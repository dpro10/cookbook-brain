/**
 * cookbook-brain harvest: bootstrap the brain from local Claude Code session
 * transcripts.
 *
 * A harvest runs in five passes:
 *
 *   1. Scan (deterministic, no model): read ~/.claude/projects transcripts
 *      from the last N days and build one compact digest per session out of
 *      the human's substantive messages and the assistant's main conclusions.
 *      Tool traffic is skipped. When the combined digests exceed the budget,
 *      the OLDEST sessions are dropped first, and the report records them.
 *   2. Proposer: one `claude -p` call over the digests proposes NEW atomic
 *      notes from a closed set only: decision, gotcha, convention,
 *      open_thread. No tasks, no merges, no edits of existing notes. Every
 *      proposed body must cite its session in a `source:` line. Deterministic
 *      validation drops proposals with missing fields, bodies over 1200
 *      characters, or no source line.
 *   3. Dedupe (deterministic, no model): proposals whose title matches an
 *      active note title case-insensitively, or whose body shares more than
 *      60% of its word trigrams with an active note body, are skipped before
 *      review and recorded.
 *   4. Refuter: a SECOND `claude -p` call with fresh context reviews each
 *      surviving proposal against the digests and answers keep or reject per
 *      proposal. A proposal whose verdict cannot be parsed is rejected by
 *      default. If the refuter output is unusable, the harvest is marked
 *      `refuter: absent` and NOTHING is applied, even with --apply. The
 *      refuter prompt is size-capped like dream's: oversized proposals are
 *      dropped from review and never applied.
 *   5. Apply, only with --apply: kept proposals become new note files
 *      authored { human: brain owner, agent: "harvest" }. Their bodies carry
 *      the session `source:` line, so the sourced-agent confidence cap
 *      (0.85) applies through the ordinary source detection; nothing is
 *      special-cased. The brain distrusts its own bootstrap until work
 *      proves it.
 *
 * PRIVACY: harvest deliberately reads transcript CONTENT (the human's
 * messages and the assistant's conclusions), unlike metadata-only tools such
 * as cookbook-meter, because distilling content is its whole job. The
 * digests go ONLY to the user's own `claude` CLI login, the same tool that
 * produced the sessions in the first place. This module never reads or
 * requires API keys and makes no network calls of its own. Subagent
 * transcripts (<session>/subagents/*.jsonl) are agent-to-agent traffic, not
 * the human's words, and are skipped on purpose.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCK_STALE_MS,
  acquireLock,
  activeNotes,
  createNote,
  loadBrain,
  releaseLock,
  type Author,
  type Brain,
  type NoteType,
} from "./store.ts";
import { extractJson, parseVerdicts, runClaude, type AppliedChange, type Verdict } from "./dream.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where Claude Code keeps local session transcripts. */
export const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** The closed set of types harvest may propose. No note, no task: harvest only files deliberate knowledge. */
export const HARVEST_NOTE_TYPES = ["decision", "gotcha", "convention", "open_thread"] as const;

/** Output token ceilings, same knob as dream (CLAUDE_CODE_MAX_OUTPUT_TOKENS). */
const PROPOSER_MAX_OUTPUT_TOKENS = 8000;
const REFUTER_MAX_OUTPUT_TOKENS = 4000;
const PROPOSER_TIMEOUT_MS = 300_000;
const REFUTER_TIMEOUT_MS = 240_000;

/** Both harvest prompts must fit under this, the same guard size dream's refuter uses. */
export const HARVEST_PROMPT_CHAR_CAP = 24_000;
/**
 * The combined session digests are capped below the prompt cap so BOTH
 * prompts (proposer: instructions + digests; refuter: instructions + digests
 * + proposals) stay under the guard with room left to actually review.
 * Oldest sessions are dropped first when over, recorded in the report.
 */
export const HARVEST_DIGEST_CHAR_BUDGET = 16_000;
/** Each session's digest is capped so one long session cannot crowd out the rest. */
export const SESSION_DIGEST_CHAR_CAP = 1_800;
/** Proposed bodies over this are dropped by deterministic validation. */
export const PROPOSAL_BODY_CHAR_CAP = 1_200;
/** A proposal whose body shares more than this fraction of its word trigrams with an active note is a duplicate. */
export const TRIGRAM_OVERLAP_THRESHOLD = 0.6;

const HUMAN_MSG_CHARS = 300;
const AGENT_MSG_CHARS = 280;
const MAX_HUMAN_MSGS = 12;
const MAX_AGENT_CONCLUSIONS = 4;
/** An assistant text must be at least this long to count as a conclusion rather than chatter. */
const AGENT_CONCLUSION_MIN_CHARS = 100;

const SOURCE_LINE_RE = /^\s*source:\s*\S+/im;

// ---- scanning transcripts ----

interface SessionItem {
  role: "human" | "agent";
  text: string;
}

export interface ScannedSession {
  sessionId: string;
  /** the session's working directory basename (or the encoded project dir's last segment) */
  project: string;
  /** YYYY-MM-DD of the session's last activity, used in source citations */
  date: string;
  end: string;
  items: SessionItem[];
}

export interface ScanOptions {
  now?: number;
  days: number;
  /** case-insensitive exact match on the session's cwd basename */
  project?: string;
}

/** The encoded project folder name embeds the full path; reduce to a basename (same trick as cookbook-meter). */
function encodedBasename(enc: string): string {
  return enc.split("-").filter(Boolean).pop() ?? enc;
}

/** Flatten a transcript message's content into plain text. Tool blocks (tool_use, tool_result, thinking) are tool traffic, not conversation. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Human-message noise: command wrappers, injected caveats, interruptions, and one-word acks say nothing worth harvesting. */
function isHumanNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 8) return true;
  if (t.startsWith("<")) return true; // <command-name>, <system-reminder>, and friends
  if (t.startsWith("Caveat:")) return true;
  if (t.startsWith("[Request interrupted")) return true;
  return false;
}

/**
 * Scan a transcripts root for sessions from the last N days. Only top-level
 * <sessionId>.jsonl files are read: nested subagent transcripts are skipped
 * on purpose (their "user" messages are agent-written prompts, not the
 * human's words). Unreadable files and malformed lines are skipped, never
 * fatal. Returns sessions in chronological order, oldest first.
 */
export function scanSessions(root: string, opts: ScanOptions): ScannedSession[] {
  const now = opts.now ?? Date.now();
  const cutoffIso = new Date(now - opts.days * DAY_MS).toISOString();
  const filter = opts.project?.trim().toLowerCase();
  const out: ScannedSession[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const dir = path.join(root, pd.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue; // directories (subagents/ etc.) deliberately skipped
      const file = path.join(dir, e.name);
      try {
        // a transcript's mtime is >= its last line's timestamp, so older files cannot be in-window
        if (fs.statSync(file).mtimeMs < now - opts.days * DAY_MS) continue;
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let cwd: string | null = null;
      let end: string | null = null;
      const items: SessionItem[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(line);
        } catch {
          continue; // partial write
        }
        const type = o.type;
        if (type !== "user" && type !== "assistant") continue;
        const ts = typeof o.timestamp === "string" ? o.timestamp : null;
        if (ts && (!end || ts > end)) end = ts;
        if (!cwd && typeof o.cwd === "string" && o.cwd) cwd = o.cwd;
        const message = o.message as { content?: unknown } | undefined;
        const text = textOf(message?.content).trim();
        if (type === "user") {
          if (o.isMeta) continue;
          if (isHumanNoise(text)) continue;
          items.push({ role: "human", text });
        } else {
          if (text.length < AGENT_CONCLUSION_MIN_CHARS) continue;
          items.push({ role: "agent", text });
        }
      }
      if (!end || end < cutoffIso) continue;
      if (items.length === 0) continue;
      const project = cwd ? path.basename(cwd) : encodedBasename(pd.name);
      if (filter && project.toLowerCase() !== filter) continue;
      out.push({ sessionId: path.basename(e.name, ".jsonl"), project, date: end.slice(0, 10), end, items });
    }
  }
  out.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  return out;
}

// ---- digests ----

export interface SessionDigestInfo {
  sessionId: string;
  project: string;
  date: string;
  chars: number;
}

function flatten(text: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

/**
 * One session's digest block: a citable header, then the human's substantive
 * messages (up to 12) and the assistant's key conclusions (the last 4 long
 * texts), in conversation order, capped per session so one marathon session
 * cannot crowd out the rest.
 */
export function digestSession(s: ScannedSession): string {
  const humans = s.items.filter((i) => i.role === "human").slice(0, MAX_HUMAN_MSGS);
  const agents = s.items.filter((i) => i.role === "agent").slice(-MAX_AGENT_CONCLUSIONS);
  const chosen = new Set<SessionItem>([...humans, ...agents]);
  const lines = [`SESSION ${s.date}, project ${s.project} (id ${s.sessionId.slice(0, 8)})`];
  let size = lines[0].length;
  for (const item of s.items) {
    if (!chosen.has(item)) continue;
    const line =
      item.role === "human" ? `human: ${flatten(item.text, HUMAN_MSG_CHARS)}` : `agent: ${flatten(item.text, AGENT_MSG_CHARS)}`;
    if (size + line.length + 1 > SESSION_DIGEST_CHAR_CAP) {
      lines.push("(session digest truncated)");
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

export interface HarvestDigest {
  /** the combined digest text, oldest kept session first */
  text: string;
  included: SessionDigestInfo[];
  /** sessions dropped oldest-first to fit the digest budget */
  dropped: SessionDigestInfo[];
}

/**
 * Combine per-session digests under the digest budget. Newest sessions are
 * kept first; when the budget would overflow, the OLDEST sessions are
 * dropped and recorded. The surviving digests are presented oldest first so
 * the model reads them in story order.
 */
export function buildHarvestDigest(sessions: ScannedSession[], budget: number = HARVEST_DIGEST_CHAR_BUDGET): HarvestDigest {
  const blocks = sessions.map((s) => ({ s, block: digestSession(s) }));
  const kept: typeof blocks = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    // newest first
    const size = blocks[i].block.length + 2;
    if (total + size > budget) break; // everything older than the first overflow is dropped too
    kept.unshift(blocks[i]);
    total += size;
  }
  const keptSet = new Set(kept.map((k) => k.s));
  const info = (s: ScannedSession, block: string): SessionDigestInfo => ({
    sessionId: s.sessionId,
    project: s.project,
    date: s.date,
    chars: block.length,
  });
  return {
    text: kept.map((k) => k.block).join("\n\n"),
    included: kept.map((k) => info(k.s, k.block)),
    dropped: blocks.filter((b) => !keptSet.has(b.s)).map((b) => info(b.s, b.block)),
  };
}

// ---- proposals ----

export interface HarvestProposal {
  type: NoteType;
  title: string;
  body: string;
}

export interface InvalidHarvestProposal {
  raw: unknown;
  reason: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Deterministic validation of proposer output: unknown types (harvest may
 * only file decision, gotcha, convention, open_thread), missing titles or
 * bodies, bodies over the 1200 character cap, and bodies that fail to cite
 * their session in a `source:` line are all dropped here with a recorded
 * reason, before dedupe or the refuter ever see them.
 */
export function validateHarvestProposals(raw: unknown): { proposals: HarvestProposal[]; invalid: InvalidHarvestProposal[] } {
  const proposals: HarvestProposal[] = [];
  const invalid: InvalidHarvestProposal[] = [];
  const list = (raw as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) return { proposals, invalid: [{ raw, reason: "output has no proposals array" }] };
  for (const item of list) {
    const p = item as Record<string, unknown>;
    const drop = (reason: string) => invalid.push({ raw: item, reason });
    if (!HARVEST_NOTE_TYPES.includes(p.type as (typeof HARVEST_NOTE_TYPES)[number])) {
      drop(`type must be one of ${HARVEST_NOTE_TYPES.join(", ")}, got ${String(p.type)}`);
      continue;
    }
    const title = asString(p.title);
    if (!title) {
      drop("missing title");
      continue;
    }
    const body = asString(p.body);
    if (!body) {
      drop("missing body");
      continue;
    }
    if (body.length > PROPOSAL_BODY_CHAR_CAP) {
      drop(`body is ${body.length} chars, over the ${PROPOSAL_BODY_CHAR_CAP} cap`);
      continue;
    }
    if (!SOURCE_LINE_RE.test(body)) {
      drop("body must cite its session in a source: line");
      continue;
    }
    proposals.push({ type: p.type as NoteType, title, body });
  }
  return { proposals, invalid };
}

// ---- dedupe ----

/** Word trigrams of a lowercased, punctuation-stripped text. Cheap similarity, no embeddings. */
export function wordTrigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** The fraction of a's trigrams that also appear in b. 0 when a has none. */
export function trigramOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.size;
}

export interface DedupedProposal {
  proposal: HarvestProposal;
  reason: string;
}

/**
 * Drop proposals the brain already knows: a case-insensitive title match
 * with any active note, or a body sharing more than 60% of its word
 * trigrams with an active note's body. Skipped proposals are recorded, not
 * silently discarded.
 */
export function dedupeAgainstBrain(
  brain: Brain,
  proposals: HarvestProposal[],
): { kept: HarvestProposal[]; skipped: DedupedProposal[] } {
  const active = activeNotes(brain);
  const titles = new Map(active.map((n) => [n.title.toLowerCase(), n]));
  const noteTrigrams = active.map((n) => ({ note: n, grams: wordTrigrams(n.body) }));
  const kept: HarvestProposal[] = [];
  const skipped: DedupedProposal[] = [];
  for (const p of proposals) {
    const titleHit = titles.get(p.title.toLowerCase());
    if (titleHit) {
      skipped.push({ proposal: p, reason: `title matches active note "${titleHit.title}" (${titleHit.id})` });
      continue;
    }
    const grams = wordTrigrams(p.body);
    const near = noteTrigrams.find((nt) => trigramOverlap(grams, nt.grams) > TRIGRAM_OVERLAP_THRESHOLD);
    if (near) {
      const pct = Math.round(trigramOverlap(grams, near.grams) * 100);
      skipped.push({ proposal: p, reason: `body shares ${pct}% of its trigrams with active note "${near.note.title}" (${near.note.id})` });
      continue;
    }
    kept.push(p);
  }
  return { kept, skipped };
}

// ---- prompts ----

export function harvestProposerPrompt(digestText: string): string {
  return [
    'You are the HARVESTER in a memory bootstrap pass over an agent memory directory called a brain.',
    "Below are digests of the owner's recent Claude Code sessions: the human's own messages and the assistant's main conclusions, oldest session first.",
    "Distill them into zero or more atomic notes worth keeping across future sessions, ONLY from this closed set of types:",
    "- decision: a choice the human made, and why.",
    "- gotcha: a trap, bug cause, or surprising behavior worth warning future sessions about.",
    "- convention: a standing rule the human stated or enforced.",
    "- open_thread: a real question that was raised and left unresolved.",
    "",
    "Rules:",
    '- Respond with ONLY a JSON object, no prose and no code fences: {"proposals": [{"type": ..., "title": ..., "body": ...}]}',
    `- One self-contained fact per note. Short stable title. Body of 2 to 6 sentences, under ${PROPOSAL_BODY_CHAR_CAP} characters.`,
    "- Every body MUST end with a source line naming the session it came from, exactly like: source: session 2026-08-15, project cookbook-app",
    "- Only distill what the digests actually say. Never invent details. Never propose tasks, edits, or merges of existing notes.",
    '- Propose nothing you are not confident about. {"proposals": []} is a good answer.',
    "- Do not use any tools. Answer from the digests alone.",
    "",
    "SESSION DIGESTS:",
    digestText || "(no sessions in the window)",
    "",
  ].join("\n");
}

const HARVEST_REFUTER_HEADER_LINES = [
  "You are the REFUTER reviewing memory notes proposed from digests of a developer's recent coding sessions. The proposals were produced by a separate pass; you have no memory of writing them and no loyalty to them.",
  "Your job is adversarial: reject any proposal the digests do not support, that guesses beyond what was actually said, that bundles more than one fact, or whose source line cites a session that does not appear in the digests. The digests below are the only evidence; judge against them, not the proposal's own claims.",
  "",
  "Respond with ONLY a JSON object, no prose and no code fences:",
  '{"verdicts": [{"index": <proposal index>, "verdict": "keep" or "reject", "reason": "<200 characters or fewer>"}]}',
  "Give a verdict for EVERY proposal index listed below. Do not use any tools.",
  "",
];

function refuterSection(p: HarvestProposal, index: number): string {
  return [`PROPOSAL ${index}:`, JSON.stringify(p), ""].join("\n");
}

export function harvestRefuterPrompt(proposals: HarvestProposal[], digestText: string): string {
  return [
    ...HARVEST_REFUTER_HEADER_LINES,
    "SESSION DIGESTS:",
    digestText || "(no sessions in the window)",
    "",
    ...proposals.map((p, i) => refuterSection(p, i)),
  ].join("\n");
}

/**
 * Pick which proposals fit under the refuter prompt size cap, exactly like
 * dream's guard: when the whole prompt (instructions + digests + proposals)
 * would overflow, the LARGEST proposals are dropped from review first,
 * recorded as "not reviewed: too large", and never applied, because
 * unreviewed proposals are never applied. Both lists come back in original
 * proposal-index order.
 */
export function planHarvestReview(
  proposals: HarvestProposal[],
  digestText: string,
  cap: number = HARVEST_PROMPT_CHAR_CAP,
): { reviewed: number[]; skipped: number[] } {
  const baseSize = harvestRefuterPrompt([], digestText).length;
  const sizes = proposals.map((p, i) => refuterSection(p, i).length + 1);
  const reviewed = new Set(proposals.map((_, i) => i));
  let total = baseSize + sizes.reduce((a, b) => a + b, 0);
  while (total > cap && reviewed.size > 0) {
    let largest = -1;
    for (const i of reviewed) {
      if (largest === -1 || sizes[i] > sizes[largest]) largest = i;
    }
    reviewed.delete(largest);
    total -= sizes[largest];
  }
  return {
    reviewed: [...reviewed].sort((a, b) => a - b),
    skipped: proposals.map((_, i) => i).filter((i) => !reviewed.has(i)),
  };
}

// ---- the harvest itself ----

export interface HarvestOptions {
  dir: string;
  sessionsRoot: string;
  days: number;
  project?: string;
  apply: boolean;
  model?: string;
  now?: number;
  human: string;
}

export interface HarvestOutcome {
  reportFile: string;
  reportText: string;
  sessionsScanned: number;
  sessionsDigested: number;
  droppedForBudget: SessionDigestInfo[];
  /** proposals that survived validation AND dedupe; refuter verdicts index into this list */
  proposals: HarvestProposal[];
  invalid: InvalidHarvestProposal[];
  deduped: DedupedProposal[];
  refuterRan: boolean;
  verdicts: Verdict[];
  skippedReview: number[];
  keptCount: number;
  applied: AppliedChange[];
  lockNote: string | null;
}

export function harvest(opts: HarvestOptions): HarvestOutcome {
  const now = opts.now ?? Date.now();
  const sessions = scanSessions(opts.sessionsRoot, { now, days: opts.days, project: opts.project });
  const digest = buildHarvestDigest(sessions);
  const brain = loadBrain(opts.dir);
  const author: Author = { human: opts.human, agent: "harvest" };

  // proposer
  let validated: HarvestProposal[] = [];
  let invalid: InvalidHarvestProposal[] = [];
  let proposerNote: string | null = null;
  if (digest.included.length === 0) {
    proposerNote = "no sessions in the window; nothing to propose from";
  } else {
    const proposerCall = runClaude(harvestProposerPrompt(digest.text), {
      model: opts.model,
      maxOutputTokens: PROPOSER_MAX_OUTPUT_TOKENS,
      timeoutMs: PROPOSER_TIMEOUT_MS,
    });
    if (!proposerCall.ok) {
      proposerNote = `proposer call failed: ${proposerCall.error}`;
    } else {
      const parsed = extractJson(proposerCall.stdout);
      if (parsed === null) {
        proposerNote = "proposer output was not parseable JSON; treating this as an empty harvest";
      } else {
        ({ proposals: validated, invalid } = validateHarvestProposals(parsed));
      }
    }
  }

  // dedupe before review: the refuter's attention is spent on new facts only
  const { kept: proposals, skipped: deduped } = dedupeAgainstBrain(brain, validated);

  // refuter (fresh context: a separate process with a prompt that never mentions proposing)
  let refuterRan = false;
  let refuterNote: string | null = null;
  let verdicts: Verdict[] = [];
  let skippedReview: number[] = [];
  if (proposals.length === 0) {
    refuterNote = "not consulted: no proposals survived to review";
  } else {
    const plan = planHarvestReview(proposals, digest.text);
    skippedReview = plan.skipped;
    const skippedVerdict = (): Verdict => ({
      verdict: "reject",
      reason: `not reviewed: too large (the refuter prompt is capped at ${HARVEST_PROMPT_CHAR_CAP} characters), and unreviewed proposals are never applied`,
      defaulted: true,
    });
    if (plan.reviewed.length === 0) {
      refuterNote = "not consulted: every proposal was too large for the refuter prompt size cap; unreviewed proposals are never applied";
      verdicts = proposals.map(skippedVerdict);
    } else {
      const reviewedProposals = plan.reviewed.map((i) => proposals[i]);
      const refuterCall = runClaude(harvestRefuterPrompt(reviewedProposals, digest.text), {
        model: opts.model,
        maxOutputTokens: REFUTER_MAX_OUTPUT_TOKENS,
        timeoutMs: REFUTER_TIMEOUT_MS,
      });
      if (!refuterCall.ok) {
        refuterNote = `refuter call failed: ${refuterCall.error}`;
      } else {
        const parsedVerdicts = parseVerdicts(extractJson(refuterCall.stdout), reviewedProposals.length);
        if (parsedVerdicts === null) {
          refuterNote = "refuter output was not parseable; every proposal is unreviewed";
        } else {
          refuterRan = true;
          verdicts = proposals.map(skippedVerdict);
          plan.reviewed.forEach((originalIndex, reviewedIndex) => {
            verdicts[originalIndex] = parsedVerdicts[reviewedIndex];
          });
        }
      }
    }
  }

  const keptIndexes = verdicts.map((v, i) => (v.verdict === "keep" ? i : -1)).filter((i) => i !== -1);

  // apply: only with --apply, NEVER when the refuter was absent. The brain
  // lock is held for the writes, same as dream, so MCP write tools in other
  // processes do not interleave.
  const applied: AppliedChange[] = [];
  let lockNote: string | null = null;
  if (opts.apply && refuterRan && keptIndexes.length > 0) {
    let locked = false;
    try {
      const { overrodeStale } = acquireLock(opts.dir, now);
      locked = true;
      if (overrodeStale) {
        lockNote = `warning: overrode a stale brain lock (older than ${LOCK_STALE_MS / 60000} minutes, likely a crashed apply)`;
      }
    } catch (e) {
      lockNote = `could not take the brain lock: ${(e as Error).message}. Nothing was applied; re-run once the other apply finishes.`;
    }
    if (locked) {
      try {
        for (const i of keptIndexes) {
          const p = proposals[i];
          try {
            const note = createNote(opts.dir, { type: p.type, title: p.title, body: p.body, author });
            applied.push({ index: i, ok: true, description: `wrote ${p.type} "${note.title}" (${path.basename(note.file)})` });
          } catch (e) {
            applied.push({ index: i, ok: false, description: `failed to apply: ${(e as Error).message}` });
          }
        }
      } finally {
        releaseLock(opts.dir);
      }
    }
  }

  const reportText = renderReport({
    dir: opts.dir,
    sessionsRoot: opts.sessionsRoot,
    days: opts.days,
    project: opts.project,
    now,
    apply: opts.apply,
    model: opts.model,
    sessionsScanned: sessions.length,
    digest,
    proposals,
    invalid,
    deduped,
    proposerNote,
    refuterRan,
    refuterNote,
    verdicts,
    skippedReview,
    applied,
    lockNote,
  });
  const reportFile = writeReport(opts.dir, now, reportText);

  return {
    reportFile,
    reportText,
    sessionsScanned: sessions.length,
    sessionsDigested: digest.included.length,
    droppedForBudget: digest.dropped,
    proposals,
    invalid,
    deduped,
    refuterRan,
    verdicts,
    skippedReview,
    keptCount: keptIndexes.length,
    applied,
    lockNote,
  };
}

// ---- report ----

interface ReportInput {
  dir: string;
  sessionsRoot: string;
  days: number;
  project?: string;
  now: number;
  apply: boolean;
  model?: string;
  sessionsScanned: number;
  digest: HarvestDigest;
  proposals: HarvestProposal[];
  invalid: InvalidHarvestProposal[];
  deduped: DedupedProposal[];
  proposerNote: string | null;
  refuterRan: boolean;
  refuterNote: string | null;
  verdicts: Verdict[];
  skippedReview: number[];
  applied: AppliedChange[];
  lockNote: string | null;
}

const sessionLine = (s: SessionDigestInfo): string => `session ${s.date}, project ${s.project} (id ${s.sessionId.slice(0, 8)}, ${s.chars} chars)`;

function renderReport(r: ReportInput): string {
  const digestBytes = Buffer.byteLength(r.digest.text, "utf8");
  const lines: string[] = [
    "# Harvest report",
    "",
    `- date: ${new Date(r.now).toISOString()}`,
    `- brain: ${r.dir}`,
    `- sessions root: ${r.sessionsRoot}`,
    `- window: last ${r.days} day(s)`,
    `- project filter: ${r.project ?? "(none)"}`,
    `- mode: ${r.apply ? "apply" : "report-only"}`,
    `- model: ${r.model ?? "default (your claude CLI setting)"}`,
    "",
    "## Sessions",
    "",
    `- sessions in window: ${r.sessionsScanned}`,
    `- digested: ${r.digest.included.length} (${digestBytes} bytes total; see exactly what leaves for the model with --dry-digest)`,
    `- what was read: transcript content (the human's messages and the assistant's conclusions), sent only to your own claude CLI`,
  ];
  if (r.digest.dropped.length > 0) {
    lines.push(`- dropped to fit the ${HARVEST_DIGEST_CHAR_BUDGET} char digest budget (oldest first): ${r.digest.dropped.length}`);
    for (const s of r.digest.dropped) lines.push(`  - ${sessionLine(s)}`);
  }
  for (const s of r.digest.included) lines.push(`- ${sessionLine(s)}`);

  lines.push("", "## Proposals", "");
  if (r.proposerNote) lines.push(`- ${r.proposerNote}`);
  if (r.proposals.length === 0 && !r.proposerNote) lines.push("- no proposals survived validation and dedupe");
  r.proposals.forEach((p, i) => {
    lines.push(`### Proposal ${i}: ${p.type} "${p.title}"`, "");
    lines.push(p.body);
    lines.push("");
  });
  if (r.invalid.length > 0) {
    lines.push("Dropped before review (failed deterministic validation):", "");
    for (const inv of r.invalid) {
      lines.push(`- ${inv.reason}: ${JSON.stringify(inv.raw).slice(0, 200)}`);
    }
    lines.push("");
  }

  lines.push("## Dedupe", "");
  if (r.deduped.length === 0) {
    lines.push("- nothing skipped: no proposal duplicated an active note");
  } else {
    for (const d of r.deduped) lines.push(`- skipped "${d.proposal.title}": ${d.reason}`);
  }

  lines.push("", "## Refuter review", "");
  lines.push(r.refuterRan ? "refuter: ran" : "refuter: absent");
  lines.push("");
  if (r.skippedReview.length > 0) {
    lines.push(
      `- ${r.skippedReview.length} proposal(s) dropped from review by the prompt size cap (proposal ${r.skippedReview.join(", proposal ")}): not reviewed, so never applied.`,
    );
  }
  if (r.refuterRan) {
    r.verdicts.forEach((v, i) => {
      lines.push(`- proposal ${i}: ${v.verdict}. ${v.reason}${v.defaulted ? " (defaulted)" : ""}`);
    });
  } else {
    if (r.refuterNote) lines.push(`- ${r.refuterNote}`);
    lines.push("- nothing may be applied without adversarial review, so this harvest applied nothing.");
  }

  lines.push("", "## Applied", "");
  if (r.lockNote) lines.push(`- ${r.lockNote}`);
  if (!r.apply) {
    lines.push("report-only run: nothing was applied. Re-run with --apply to write the kept notes.");
  } else if (!r.refuterRan) {
    lines.push("nothing applied: the refuter was absent, and unreviewed harvests are never applied.");
  } else if (r.applied.length === 0) {
    if (!r.lockNote) lines.push("no proposals were kept, so there was nothing to apply.");
  } else {
    for (const a of r.applied) {
      lines.push(`- proposal ${a.index}${a.ok ? "" : " (FAILED)"}: ${a.description}`);
    }
  }

  lines.push(
    "",
    "## Undo",
    "",
    "An applied harvest only adds new note files; it never edits or stamps existing notes. To undo it, git revert the commit that contains this harvest, or delete the note files listed above before committing.",
    "",
  );
  return lines.join("\n");
}

/** Reports live in brain/dreams/, the same subdirectory dream uses, which the note scanner never reads. */
function writeReport(dir: string, now: number, text: string): string {
  const dreamsDir = path.join(dir, "dreams");
  fs.mkdirSync(dreamsDir, { recursive: true });
  const date = new Date(now).toISOString().slice(0, 10);
  let file = path.join(dreamsDir, `HARVEST_${date}.md`);
  if (fs.existsSync(file)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    file = path.join(dreamsDir, `HARVEST_${stamp}.md`);
  }
  fs.writeFileSync(file, text, { flag: "wx" });
  return file;
}
