/**
 * cookbook-brain dreaming: offline consolidation with an adversarial refuter.
 *
 * A dream runs in three passes:
 *
 *   1. Hygiene (deterministic, no model): duplicate active titles, superseded
 *      notes still referenced by active wikilinks, and stale unproven notes.
 *      These findings seed the proposer.
 *   2. Proposer: one `claude -p` call over a compact digest of active notes
 *      (id, type, title, credits, age, first 280 characters). It may propose
 *      operations from ONLY a closed set: merge, promote, flag_contradiction,
 *      retitle_for_collision.
 *   3. Refuter: a SECOND `claude -p` call with fresh context and no memory of
 *      proposing. It sees each proposal plus the full text of its source
 *      notes and must answer keep or reject per proposal with a short reason.
 *      A proposal whose verdict cannot be parsed is rejected by default,
 *      never silently kept. If the refuter call itself fails or returns
 *      nothing parseable, the dream is marked `refuter: absent` and NOTHING
 *      is applied, even with --apply.
 *
 * Dreams are report-only by default; --apply executes kept proposals, and
 * every application is reversible: new note files plus superseded_by stamps,
 * nothing else. The model runs over the user's own `claude` CLI login; this
 * module never reads or requires API keys and makes no network calls of its
 * own. Notes a dream writes are authored { human: brain owner, agent:
 * "dream" }, so the bare-agent provenance cap applies: the brain distrusts
 * its own dreams until work proves them.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  NOTE_TYPES,
  activeNotes,
  confidenceFor,
  consolidateNotes,
  createNote,
  duplicateActiveTitleGroups,
  extractWikilinks,
  loadBrain,
  supersedeNote,
  tierFor,
  type Author,
  type Brain,
  type Note,
  type NoteType,
} from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Output token ceilings, enforced through the Claude Code CLI's own env knob. */
const PROPOSER_MAX_OUTPUT_TOKENS = 8000;
const REFUTER_MAX_OUTPUT_TOKENS = 4000;
const PROPOSER_TIMEOUT_MS = 300_000;
const REFUTER_TIMEOUT_MS = 240_000;
const REFUTER_REASON_MAX = 200;

// ---- claude binary ----

/** Find an executable named `claude` on PATH, or null. Never executes anything. */
export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here; keep looking */
    }
  }
  return null;
}

interface ClaudeCallResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/**
 * One `claude -p` call over the user's own CLI login. The prompt goes in on
 * stdin; the output token ceiling rides the CLAUDE_CODE_MAX_OUTPUT_TOKENS
 * environment variable that Claude Code itself honors.
 */
function runClaude(prompt: string, opts: { model?: string; maxOutputTokens: number; timeoutMs: number }): ClaudeCallResult {
  const args = ["-p"];
  if (opts.model) args.push("--model", opts.model);
  const r = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(opts.maxOutputTokens) },
  });
  if (r.error) return { ok: false, stdout: "", error: r.error.message };
  if (r.status !== 0) {
    return { ok: false, stdout: r.stdout ?? "", error: `claude exited ${r.status ?? "by signal"}: ${(r.stderr ?? "").trim().slice(0, 400)}` };
  }
  return { ok: true, stdout: r.stdout ?? "" };
}

/** Pull the outermost {...} out of model output (tolerates prose and code fences). */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---- hygiene (deterministic, no model) ----

export interface HygieneFindings {
  /** groups of active notes sharing a title */
  duplicateTitles: { title: string; ids: string[] }[];
  /** an active note wikilinks a title whose every bearer is superseded */
  supersededReferenced: { linkerId: string; linkerTitle: string; link: string; supersededIds: string[] }[];
  /** verify-tier notes older than 90 days */
  staleUnproven: { id: string; title: string; ageDays: number }[];
}

export function hygieneFindings(brain: Brain, now: number): HygieneFindings {
  const duplicateTitles = duplicateActiveTitleGroups(brain).map((g) => ({
    title: g[0].title,
    ids: g.map((n) => n.id),
  }));

  const activeTitles = new Set(activeNotes(brain).map((n) => n.title.toLowerCase()));
  const supersededReferenced: HygieneFindings["supersededReferenced"] = [];
  const seen = new Set<string>();
  for (const n of activeNotes(brain)) {
    for (const link of extractWikilinks(n.body)) {
      const key = link.toLowerCase();
      if (activeTitles.has(key)) continue;
      const bearers = brain.byTitle.get(key);
      if (!bearers || bearers.length === 0) continue; // broken link; doctor's department
      const dedupe = `${n.id}::${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      supersededReferenced.push({ linkerId: n.id, linkerTitle: n.title, link, supersededIds: bearers });
    }
  }

  const staleUnproven: HygieneFindings["staleUnproven"] = [];
  for (const n of activeNotes(brain)) {
    const ageDays = Math.floor(Math.max(0, now - Date.parse(n.created)) / DAY_MS);
    if (ageDays <= 90) continue;
    if (tierFor(confidenceFor(n, now), n.credits) !== "verify") continue;
    staleUnproven.push({ id: n.id, title: n.title, ageDays });
  }

  return { duplicateTitles, supersededReferenced, staleUnproven };
}

export function hygieneCount(h: HygieneFindings): number {
  return h.duplicateTitles.length + h.supersededReferenced.length + h.staleUnproven.length;
}

function hygieneLines(h: HygieneFindings): string[] {
  const lines: string[] = [];
  for (const d of h.duplicateTitles) {
    lines.push(`duplicate active title "${d.title}": ids ${d.ids.join(", ")}`);
  }
  for (const s of h.supersededReferenced) {
    lines.push(
      `active note "${s.linkerTitle}" (${s.linkerId}) links [[${s.link}]], but every note with that title is superseded (${s.supersededIds.join(", ")})`,
    );
  }
  for (const s of h.staleUnproven) {
    lines.push(`stale unproven: "${s.title}" (${s.id}), verify tier, ${s.ageDays} days old`);
  }
  return lines;
}

// ---- digest ----

export interface DigestEntry {
  id: string;
  type: NoteType;
  title: string;
  credits: number;
  age_days: number;
  excerpt: string;
}

/**
 * The compact digest of active notes the proposer sees: id, type, title,
 * credits, age in days, and the first 280 characters of the body with
 * whitespace flattened. Sorted by id, so the digest is deterministic for a
 * given brain and clock.
 */
export function buildDigest(brain: Brain, now: number): { entries: DigestEntry[]; text: string } {
  const entries = activeNotes(brain)
    .map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      credits: n.credits,
      age_days: Math.floor(Math.max(0, now - Date.parse(n.created)) / DAY_MS),
      excerpt: n.body.replace(/\s+/g, " ").trim().slice(0, 280),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries, text: entries.map((e) => JSON.stringify(e)).join("\n") };
}

// ---- proposals ----

export type Proposal =
  | { op: "merge"; source_ids: string[]; type: NoteType; title: string; body: string; rationale: string }
  | { op: "promote"; source_id: string; title: string; body: string; rationale: string }
  | { op: "flag_contradiction"; ids: [string, string]; reason: string; rationale: string }
  | { op: "retitle_for_collision"; id: string; new_title: string; rationale: string };

export interface InvalidProposal {
  raw: unknown;
  reason: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Deterministic validation of proposer output against the brain: unknown
 * ops, invented ids, superseded sources, and under-credited promotions are
 * dropped here with a recorded reason, before the refuter ever sees them.
 */
export function validateProposals(brain: Brain, raw: unknown): { proposals: Proposal[]; invalid: InvalidProposal[] } {
  const proposals: Proposal[] = [];
  const invalid: InvalidProposal[] = [];
  const list = (raw as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) return { proposals, invalid: [{ raw, reason: "output has no proposals array" }] };

  const active = (id: unknown): Note | null => {
    if (typeof id !== "string") return null;
    const n = brain.byId.get(id);
    return n && n.superseded_by === undefined ? n : null;
  };

  for (const item of list) {
    const p = item as Record<string, unknown>;
    const drop = (reason: string) => invalid.push({ raw: item, reason });
    const rationale = asString(p.rationale) ?? "";
    switch (p.op) {
      case "merge": {
        const ids = Array.isArray(p.source_ids) ? p.source_ids : null;
        if (!ids || ids.length < 2) {
          drop("merge needs source_ids with at least 2 note ids");
          break;
        }
        if (new Set(ids).size !== ids.length) {
          drop("merge source_ids must be distinct");
          break;
        }
        const sources = ids.map(active);
        if (sources.some((s) => s === null)) {
          drop("merge source_ids include an unknown or superseded note id");
          break;
        }
        const title = asString(p.title);
        const body = asString(p.body);
        if (!title || !body) {
          drop("merge needs a non-empty title and body for the merged draft");
          break;
        }
        const type = NOTE_TYPES.includes(p.type as NoteType) && p.type !== "task" ? (p.type as NoteType) : sources[0]!.type;
        proposals.push({ op: "merge", source_ids: ids as string[], type, title, body, rationale });
        break;
      }
      case "promote": {
        const source = active(p.source_id);
        if (!source) {
          drop("promote source_id is not an active note");
          break;
        }
        if (source.type !== "gotcha") {
          drop(`promote source must be a gotcha, got ${source.type}`);
          break;
        }
        if (source.credits < 2) {
          drop(`promote requires credits >= 2, note has ${source.credits}`);
          break;
        }
        proposals.push({
          op: "promote",
          source_id: source.id,
          title: asString(p.title) ?? source.title,
          body: asString(p.body) ?? source.body,
          rationale,
        });
        break;
      }
      case "flag_contradiction": {
        const ids = Array.isArray(p.ids) ? p.ids : null;
        if (!ids || ids.length !== 2 || ids[0] === ids[1]) {
          drop("flag_contradiction needs exactly 2 distinct note ids");
          break;
        }
        if (!active(ids[0]) || !active(ids[1])) {
          drop("flag_contradiction ids include an unknown or superseded note id");
          break;
        }
        const reason = asString(p.reason);
        if (!reason) {
          drop("flag_contradiction needs a one-line reason");
          break;
        }
        proposals.push({
          op: "flag_contradiction",
          ids: [ids[0] as string, ids[1] as string],
          reason: reason.split("\n")[0],
          rationale: rationale || reason.split("\n")[0],
        });
        break;
      }
      case "retitle_for_collision": {
        const note = active(p.id);
        if (!note) {
          drop("retitle_for_collision id is not an active note");
          break;
        }
        const newTitle = asString(p.new_title);
        if (!newTitle || newTitle.toLowerCase() === note.title.toLowerCase()) {
          drop("retitle_for_collision needs a new_title different from the current title");
          break;
        }
        proposals.push({ op: "retitle_for_collision", id: note.id, new_title: newTitle, rationale });
        break;
      }
      default:
        drop(`unknown op: ${String(p.op)} (allowed: merge, promote, flag_contradiction, retitle_for_collision)`);
    }
  }
  return { proposals, invalid };
}

function describeProposal(p: Proposal): string[] {
  switch (p.op) {
    case "merge":
      return [`source_ids: ${p.source_ids.join(", ")}`, `draft: ${p.type} "${p.title}"`, `rationale: ${p.rationale || "(none given)"}`];
    case "promote":
      return [`source_id: ${p.source_id}`, `draft: convention "${p.title}"`, `rationale: ${p.rationale || "(none given)"}`];
    case "flag_contradiction":
      return [`ids: ${p.ids.join(", ")}`, `reason: ${p.reason}`, `rationale: ${p.rationale || "(none given)"}`];
    case "retitle_for_collision":
      return [`id: ${p.id}`, `new_title: ${p.new_title}`, `rationale: ${p.rationale || "(none given)"}`];
  }
}

function sourceIdsOf(p: Proposal): string[] {
  switch (p.op) {
    case "merge":
      return p.source_ids;
    case "promote":
      return [p.source_id];
    case "flag_contradiction":
      return [...p.ids];
    case "retitle_for_collision":
      return [p.id];
  }
}

// ---- prompts ----

export function proposerPrompt(digestText: string, hygiene: HygieneFindings): string {
  const hygieneSection = hygieneLines(hygiene);
  return [
    'You are the PROPOSER in a memory consolidation pass ("dream") over an agent memory directory called a brain.',
    "Each digest line below is one active note as JSON: id, type, title, credits (times the note proved true in completed work), age_days, and the first 280 characters of the body.",
    "",
    "Propose zero or more operations, ONLY from this closed set:",
    '- merge: combine 2 or more notes that state the same fact. Fields: "op", "source_ids" (array of note ids), "type" (one of decision, gotcha, convention, note, open_thread), "title", "body" (a self-contained merged draft in markdown), "rationale".',
    '- promote: turn a gotcha with credits of 2 or more into a standing convention. Fields: "op", "source_id", "title", "body", "rationale".',
    '- flag_contradiction: two notes that cannot both be true. Fields: "op", "ids" (array of exactly 2 note ids), "reason" (one line), "rationale".',
    '- retitle_for_collision: rename a note whose title collides with another active note. Fields: "op", "id", "new_title", "rationale".',
    "",
    "Rules:",
    '- Respond with ONLY a JSON object, no prose and no code fences: {"proposals": [ ... ]}',
    '- Propose nothing you are not confident about. {"proposals": []} is a good answer.',
    "- Use only note ids that appear in the digest. Never invent ids.",
    "- Do not use any tools. Answer from the digest alone.",
    "",
    "HYGIENE FINDINGS (from a deterministic scan; treat these as seeds for proposals):",
    ...(hygieneSection.length > 0 ? hygieneSection.map((l) => `- ${l}`) : ["- none"]),
    "",
    "DIGEST (one JSON object per line):",
    digestText || "(the brain has no active notes)",
    "",
  ].join("\n");
}

export function refuterPrompt(proposals: Proposal[], brain: Brain): string {
  const lines = [
    "You are the REFUTER reviewing consolidation proposals made over an agent memory. The proposals were produced by a separate pass; you have no memory of writing them and no loyalty to them.",
    "Your job is adversarial: reject any proposal that loses information, merges notes that do not state the same fact, promotes something unproven, flags a contradiction that is not one, or picks a worse title. The full text of every source note is below; judge against the notes themselves, not the proposal's own claims.",
    "",
    "Respond with ONLY a JSON object, no prose and no code fences:",
    '{"verdicts": [{"index": <proposal index>, "verdict": "keep" or "reject", "reason": "<200 characters or fewer>"}]}',
    "Give a verdict for EVERY proposal index listed below. Do not use any tools.",
    "",
  ];
  proposals.forEach((p, i) => {
    lines.push(`PROPOSAL ${i}:`, JSON.stringify(p), "", `SOURCE NOTES FOR PROPOSAL ${i}:`);
    for (const id of sourceIdsOf(p)) {
      const note = brain.byId.get(id);
      lines.push(`--- note ${id} (${note ? path.basename(note.file) : "missing"}) ---`);
      lines.push(note ? fs.readFileSync(note.file, "utf8").trim() : "(missing)");
    }
    lines.push("");
  });
  return lines.join("\n");
}

// ---- refuter verdict parsing ----

export interface Verdict {
  verdict: "keep" | "reject";
  reason: string;
  /** true when this verdict was substituted because the refuter's answer for this proposal was unparseable */
  defaulted: boolean;
}

const DEFAULT_REJECT: Omit<Verdict, "verdict"> = {
  reason: "no parseable refuter verdict for this proposal; rejected by default",
  defaulted: true,
};

/**
 * Parse refuter output into one verdict per proposal. Returns null when the
 * whole output is unusable (refuter: absent). A missing or malformed verdict
 * for an individual proposal becomes a default reject, never a silent keep.
 */
export function parseVerdicts(parsed: unknown, proposalCount: number): Verdict[] | null {
  const list = (parsed as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return null;
  const verdicts: Verdict[] = [];
  for (let i = 0; i < proposalCount; i++) {
    const entry = list.find((v) => (v as Record<string, unknown>)?.index === i) as Record<string, unknown> | undefined;
    const verdict = entry?.verdict;
    const reason = asString(entry?.reason);
    if ((verdict === "keep" || verdict === "reject") && reason) {
      verdicts.push({ verdict, reason: reason.slice(0, REFUTER_REASON_MAX), defaulted: false });
    } else {
      verdicts.push({ verdict: "reject", ...DEFAULT_REJECT });
    }
  }
  return verdicts;
}

// ---- applying ----

export interface AppliedChange {
  index: number;
  ok: boolean;
  description: string;
}

function applyProposal(dir: string, p: Proposal, author: Author): string {
  switch (p.op) {
    case "merge": {
      const { newNote } = consolidateNotes(dir, p.source_ids, { type: p.type, title: p.title, body: p.body, author });
      return `merged ${p.source_ids.length} notes into "${newNote.title}" (${path.basename(newNote.file)}); sources stamped superseded_by ${newNote.id}`;
    }
    case "promote": {
      const { newNote } = consolidateNotes(dir, [p.source_id], { type: "convention", title: p.title, body: p.body, author });
      return `promoted gotcha ${p.source_id} to convention "${newNote.title}" (${path.basename(newNote.file)})`;
    }
    case "flag_contradiction": {
      const brain = loadBrain(dir);
      const a = brain.byId.get(p.ids[0])!;
      const b = brain.byId.get(p.ids[1])!;
      const title = `Contradiction: ${a.title} vs ${b.title}`.slice(0, 120);
      const body = [
        `The dream refuter kept this contradiction flag: ${p.reason}`,
        "",
        `Between [[${a.title}]] (${a.id}) and [[${b.title}]] (${b.id}).`,
        "Decide which note holds, then supersede the loser.",
      ].join("\n");
      const note = createNote(dir, { type: "open_thread", title, body, author });
      return `filed open_thread "${note.title}" (${path.basename(note.file)})`;
    }
    case "retitle_for_collision": {
      const brain = loadBrain(dir);
      const old = brain.byId.get(p.id)!;
      const { newNote } = supersedeNote(dir, p.id, { type: old.type, title: p.new_title, body: old.body, author });
      return `retitled "${old.title}" to "${newNote.title}" via supersede (${path.basename(newNote.file)})`;
    }
  }
}

// ---- the dream itself ----

export interface DreamOptions {
  dir: string;
  apply: boolean;
  model?: string;
  now?: number;
  env?: NodeJS.ProcessEnv;
  human: string;
}

export interface DreamOutcome {
  reportFile: string;
  reportText: string;
  activeCount: number;
  hygieneTotal: number;
  proposals: Proposal[];
  refuterRan: boolean;
  keptCount: number;
  applied: AppliedChange[];
}

export function dream(opts: DreamOptions): DreamOutcome {
  const now = opts.now ?? Date.now();
  const brain = loadBrain(opts.dir);
  const hygiene = hygieneFindings(brain, now);
  const digest = buildDigest(brain, now);
  const author: Author = { human: opts.human, agent: "dream" };

  // proposer
  let proposals: Proposal[] = [];
  let invalid: InvalidProposal[] = [];
  let proposerNote: string | null = null;
  const proposerCall = runClaude(proposerPrompt(digest.text, hygiene), {
    model: opts.model,
    maxOutputTokens: PROPOSER_MAX_OUTPUT_TOKENS,
    timeoutMs: PROPOSER_TIMEOUT_MS,
  });
  if (!proposerCall.ok) {
    proposerNote = `proposer call failed: ${proposerCall.error}`;
  } else {
    const parsed = extractJson(proposerCall.stdout);
    if (parsed === null) {
      proposerNote = "proposer output was not parseable JSON; treating this as an empty dream";
    } else {
      ({ proposals, invalid } = validateProposals(brain, parsed));
    }
  }

  // refuter (fresh context: a separate process with a prompt that never mentions proposing)
  let refuterRan = false;
  let refuterNote: string | null = null;
  let verdicts: Verdict[] = [];
  if (proposals.length === 0) {
    refuterNote = "not consulted: no proposals survived to review";
  } else {
    const refuterCall = runClaude(refuterPrompt(proposals, brain), {
      model: opts.model,
      maxOutputTokens: REFUTER_MAX_OUTPUT_TOKENS,
      timeoutMs: REFUTER_TIMEOUT_MS,
    });
    if (!refuterCall.ok) {
      refuterNote = `refuter call failed: ${refuterCall.error}`;
    } else {
      const parsedVerdicts = parseVerdicts(extractJson(refuterCall.stdout), proposals.length);
      if (parsedVerdicts === null) {
        refuterNote = "refuter output was not parseable; every proposal is unreviewed";
      } else {
        refuterRan = true;
        verdicts = parsedVerdicts;
      }
    }
  }

  const keptIndexes = verdicts.map((v, i) => (v.verdict === "keep" ? i : -1)).filter((i) => i !== -1);

  // apply: only with --apply, and NEVER when the refuter was absent
  const applied: AppliedChange[] = [];
  if (opts.apply && refuterRan) {
    for (const i of keptIndexes) {
      try {
        applied.push({ index: i, ok: true, description: applyProposal(opts.dir, proposals[i], author) });
      } catch (e) {
        applied.push({ index: i, ok: false, description: `failed to apply: ${(e as Error).message}` });
      }
    }
  }

  const reportText = renderReport({
    dir: opts.dir,
    now,
    apply: opts.apply,
    model: opts.model,
    activeCount: digest.entries.length,
    digestBytes: Buffer.byteLength(digest.text, "utf8"),
    hygiene,
    proposals,
    invalid,
    proposerNote,
    refuterRan,
    refuterNote,
    verdicts,
    applied,
  });
  const reportFile = writeReport(opts.dir, now, reportText);

  return {
    reportFile,
    reportText,
    activeCount: digest.entries.length,
    hygieneTotal: hygieneCount(hygiene),
    proposals,
    refuterRan,
    keptCount: keptIndexes.length,
    applied,
  };
}

// ---- report ----

interface ReportInput {
  dir: string;
  now: number;
  apply: boolean;
  model?: string;
  activeCount: number;
  digestBytes: number;
  hygiene: HygieneFindings;
  proposals: Proposal[];
  invalid: InvalidProposal[];
  proposerNote: string | null;
  refuterRan: boolean;
  refuterNote: string | null;
  verdicts: Verdict[];
  applied: AppliedChange[];
}

function renderReport(r: ReportInput): string {
  const lines: string[] = [
    "# Dream report",
    "",
    `- date: ${new Date(r.now).toISOString()}`,
    `- brain: ${r.dir}`,
    `- mode: ${r.apply ? "apply" : "report-only"}`,
    `- model: ${r.model ?? "default (your claude CLI setting)"}`,
    "",
    "## Inputs digest",
    "",
    `- active notes digested: ${r.activeCount}`,
    `- digest size: ${r.digestBytes} bytes (see it yourself with --dry-digest)`,
    `- hygiene findings: ${r.hygiene.duplicateTitles.length} duplicate-title group(s), ${r.hygiene.supersededReferenced.length} superseded-but-referenced link(s), ${r.hygiene.staleUnproven.length} stale unproven note(s)`,
    "",
    "## Hygiene findings",
    "",
  ];
  const hLines = hygieneLines(r.hygiene);
  lines.push(...(hLines.length > 0 ? hLines.map((l) => `- ${l}`) : ["- none"]));

  lines.push("", "## Proposals", "");
  if (r.proposerNote) lines.push(`- ${r.proposerNote}`);
  if (r.proposals.length === 0 && !r.proposerNote) lines.push("- the proposer offered no proposals");
  r.proposals.forEach((p, i) => {
    lines.push(`### Proposal ${i}: ${p.op}`, "");
    lines.push(...describeProposal(p).map((l) => `- ${l}`));
    lines.push("");
  });
  if (r.invalid.length > 0) {
    lines.push("Dropped before review (failed deterministic validation):", "");
    for (const inv of r.invalid) {
      lines.push(`- ${inv.reason}: ${JSON.stringify(inv.raw).slice(0, 200)}`);
    }
    lines.push("");
  }

  lines.push("## Refuter review", "");
  lines.push(r.refuterRan ? "refuter: ran" : "refuter: absent");
  lines.push("");
  if (r.refuterRan) {
    r.verdicts.forEach((v, i) => {
      lines.push(`- proposal ${i}: ${v.verdict}. ${v.reason}${v.defaulted ? " (defaulted)" : ""}`);
    });
  } else {
    if (r.refuterNote) lines.push(`- ${r.refuterNote}`);
    lines.push("- nothing may be applied without adversarial review, so this dream applied nothing.");
  }

  lines.push("", "## Applied", "");
  if (!r.apply) {
    lines.push("report-only run: nothing was applied. Re-run with --apply to execute the kept proposals.");
  } else if (!r.refuterRan) {
    lines.push("nothing applied: the refuter was absent, and unreviewed dreams are never applied.");
  } else if (r.applied.length === 0) {
    lines.push("no proposals were kept, so there was nothing to apply.");
  } else {
    for (const a of r.applied) {
      lines.push(`- proposal ${a.index}${a.ok ? "" : " (FAILED)"}: ${a.description}`);
    }
  }

  lines.push(
    "",
    "## Undo",
    "",
    "An applied dream only adds new note files and stamps superseded_by on the notes it consolidated. To undo it, git revert the commit that contains this dream, or run git checkout -- on the brain directory before committing.",
    "",
  );
  return lines.join("\n");
}

/** Reports live in brain/dreams/, a subdirectory the note scanner never reads. */
function writeReport(dir: string, now: number, text: string): string {
  const dreamsDir = path.join(dir, "dreams");
  fs.mkdirSync(dreamsDir, { recursive: true });
  const date = new Date(now).toISOString().slice(0, 10);
  let file = path.join(dreamsDir, `DREAM_${date}.md`);
  if (fs.existsSync(file)) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    file = path.join(dreamsDir, `DREAM_${stamp}.md`);
  }
  fs.writeFileSync(file, text, { flag: "wx" });
  return file;
}
