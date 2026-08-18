/**
 * Hermetic tests for cookbook-brain.
 *
 * Everything runs against fixture brain directories under test/fixtures and
 * throwaway temp directories; nothing touches a real brain, network, or any
 * user config. The MCP smoke test spawns the real server binary and speaks
 * newline-delimited JSON-RPC to it over stdio.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCK_STALE_MS,
  abandonTask,
  fixTitleAliases,
  hasTitleAlias,
  missingTitleAlias,
  renderIndexMd,
  acquireLock,
  activeConventions,
  activeLock,
  activeNotes,
  assertNotLocked,
  assignTask,
  backlinksFor,
  capFor,
  claimTask,
  completeTask,
  confidenceFor,
  consolidateNotes,
  createNote,
  creditNotes,
  diagnose,
  extractWikilinks,
  isSourced,
  listTasks,
  loadBrain,
  lockPath,
  noteFilename,
  openTasksFor,
  parseNoteFile,
  recall,
  releaseLock,
  searchRanked,
  serializeNote,
  slugify,
  stalenessFor,
  supersedeNote,
  tierFor,
  ulid,
  type Note,
} from "../src/store.ts";
import { INTERNAL_RUN_MARKER, REFUTER_PROMPT_CHAR_CAP, buildDigest, extractJson, hygieneFindings, planReview, type Proposal } from "../src/dream.ts";
import {
  HARVEST_DIGEST_CHAR_BUDGET,
  HARVEST_PROMPT_CHAR_CAP,
  SESSION_DIGEST_CHAR_CAP,
  buildHarvestDigest,
  dedupeAgainstBrain,
  digestSession,
  harvestProposerPrompt,
  harvestRefuterPrompt,
  isInternalRunPrompt,
  normalizeSourceLine,
  pendingHarvestKeeps,
  planHarvestReview,
  readWatermarks,
  scanSessions,
  sessionDateRange,
  transcriptFirstUserText,
  trigramOverlap,
  validateHarvestProposals,
  watermarksPath,
  wordTrigrams,
  writeWatermarks,
  type HarvestProposal,
  type ScannedSession,
} from "../src/harvest.ts";
import { serveWeb } from "../src/web.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BASIC = path.join(ROOT, "test", "fixtures", "basic-brain");
const BROKEN = path.join(ROOT, "test", "fixtures", "broken-brain");
const BIN = path.join(ROOT, "bin", "cookbook-brain.mjs");

/** Fixed clock so confidence staleness never drifts as the fixtures age. */
const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

/** A synthetic in-memory note for formula unit tests; never touches disk. */
function fakeNote(over: Partial<Note> = {}): Note {
  return {
    id: "01J8ZZ0000000000000000TEST",
    type: "note",
    title: "Synthetic note",
    author: { human: "diego", agent: null },
    created: daysAgo(1),
    supersedes: null,
    credits: 0,
    last_credited: null,
    body: "just a body",
    file: "synthetic.md",
    ...over,
  };
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? tmpdir("brain-cli-"),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 60_000,
    input: opts.input,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---- ids, slugs, filenames ----

check("ulid: 26 Crockford chars, lexically sortable by time", () => {
  const a = ulid(1_000_000);
  const b = ulid(2_000_000);
  assert.match(a, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  assert.ok(a < b, "earlier timestamp must sort first");
  assert.notEqual(ulid(), ulid(), "same-millisecond ids must differ");
});

check("slugify + filename convention", () => {
  assert.equal(slugify("Use pnpm everywhere"), "use-pnpm-everywhere");
  assert.equal(slugify("  Weird:: title / with (stuff)  "), "weird-title-with-stuff");
  assert.equal(slugify("???"), "untitled");
  assert.equal(noteFilename("2026-08-18T10:00:00.000Z", "Use pnpm everywhere"), "2026-08-18--use-pnpm-everywhere.md");
});

// ---- frontmatter round-trip ----

check("serialize/parse round-trip preserves every field, including tricky titles", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "decision",
    title: "Routing: use [[app]] dir, not pages",
    author: { human: "diego", agent: null },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    credits: 0,
    last_credited: null,
    body: "Body with a [[Link Target]] and a colon: here.\n\nsource: https://example.com/why",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.note);
  const { file: _f, ...roundTripped } = parsed.note;
  assert.deepEqual(roundTripped, note);
});

check("serialize/parse round-trip with agent author and superseded_by", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "gotcha",
    title: "Numbers-only title",
    author: { human: "diego", agent: "Claude Code" },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: "01J8A000000000000000000001",
    superseded_by: "01J8A000000000000000000002",
    credits: 7,
    last_credited: "2026-08-18T11:00:00.000Z",
    body: "body",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  const { file: _f, ...roundTripped } = parsed.note!;
  assert.deepEqual(roundTripped, note);
});

check("parse: malformed files return problems, not throws", () => {
  assert.ok(parseNoteFile("x.md", "just a plain file").problems.length > 0);
  assert.ok(parseNoteFile("x.md", "---\nid: abc\n").problems.some((p) => p.includes("unterminated")));
});

// ---- store round-trip on disk ----

check("store round-trip: createNote writes a file loadBrain reads back", () => {
  const dir = tmpdir("brain-store-");
  try {
    const written = createNote(dir, {
      type: "convention",
      title: "Tabs are two spaces",
      body: "Because the linter says so.",
      author: { human: "diego", agent: "Claude Code" },
    });
    assert.ok(fs.existsSync(written.file));
    assert.match(path.basename(written.file), /^\d{4}-\d{2}-\d{2}--tabs-are-two-spaces\.md$/);
    const brain = loadBrain(dir);
    assert.equal(brain.problems.length, 0);
    assert.equal(brain.notes.length, 1);
    assert.deepEqual(brain.notes[0], written);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("store: same-day duplicate titles get distinct files, nothing overwritten", () => {
  const dir = tmpdir("brain-dup-");
  try {
    const author = { human: "diego", agent: null };
    const a = createNote(dir, { type: "note", title: "Same title", body: "first", author });
    const b = createNote(dir, { type: "note", title: "Same title", body: "second", author });
    assert.notEqual(a.file, b.file);
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2);
    assert.deepEqual(new Set(brain.notes.map((n) => n.body)), new Set(["first", "second"]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("store: SCHEMA.md is not treated as a note", () => {
  const dir = tmpdir("brain-schema-");
  try {
    fs.writeFileSync(path.join(dir, "SCHEMA.md"), "# not a note");
    createNote(dir, { type: "note", title: "Real note", body: "x", author: { human: "d", agent: null } });
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 1);
    assert.equal(brain.problems.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- supersede chain ----

check("supersede: new note points back, old note gains superseded_by on disk, recall hides it, doctor is clean", () => {
  const dir = tmpdir("brain-sup-");
  try {
    const author = { human: "diego", agent: "Claude Code" };
    const original = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "YOLO.", author });
    const { oldNote, newNote } = supersedeNote(dir, original.id, {
      type: "decision",
      title: "Never deploy on Fridays",
      body: "The 2026-08-01 outage settled this.",
      author,
    });
    assert.equal(newNote.supersedes, original.id);
    assert.equal(oldNote.superseded_by, newNote.id);

    // the old FILE was stamped, and only that one field changed
    const reread = parseNoteFile(original.file, fs.readFileSync(original.file, "utf8")).note!;
    assert.equal(reread.superseded_by, newNote.id);
    assert.equal(reread.body, "YOLO.");
    assert.equal(reread.id, original.id);
    assert.equal(reread.created, original.created);

    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2);
    assert.deepEqual(
      activeNotes(brain).map((n) => n.id),
      [newNote.id],
      "superseded note must leave the active set",
    );
    const recalled = recall(brain, { query: "deploy" });
    assert.deepEqual(recalled.map((r) => r.id), [newNote.id]);

    assert.deepEqual(diagnose(dir), [], "a proper supersede chain must validate clean");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("supersede: unknown id and double-supersede both refuse", () => {
  const dir = tmpdir("brain-sup2-");
  try {
    const author = { human: "diego", agent: null };
    const original = createNote(dir, { type: "note", title: "Once", body: "x", author });
    assert.throws(() => supersedeNote(dir, "01J8NOPE00000000000000NOPE", { type: "note", title: "n", body: "b", author }), /no note with id/);
    supersedeNote(dir, original.id, { type: "note", title: "Twice", body: "y", author });
    assert.throws(
      () => supersedeNote(dir, original.id, { type: "note", title: "Thrice", body: "z", author }),
      /already superseded/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- wikilinks + backlinks ----

check("extractWikilinks: finds titles, trims, ignores empties", () => {
  assert.deepEqual(extractWikilinks("See [[Alpha]] and [[ Beta Two ]] but not [[]] or [single]."), ["Alpha", "Beta Two"]);
});

check("backlinks: resolved case-insensitively, with surrounding context lines", () => {
  const brain = loadBrain(BASIC);
  assert.equal(brain.problems.length, 0, JSON.stringify(brain.problems));

  // "Use pnpm everywhere" is linked by the cache note as [[use PNPM everywhere]]
  const pnpm = brain.byId.get("01J8A000000000000000000001")!;
  const links = backlinksFor(brain, pnpm);
  assert.deepEqual(links.map((l) => l.id), ["01J8A000000000000000000003"]);
  assert.equal(links[0].title, "Cache folder location");
  assert.ok(links[0].context.includes("This follows from [[use PNPM everywhere]]"), links[0].context);
  assert.ok(links[0].context.includes("The build cache lives"), "context must include the line before the link");
  assert.ok(links[0].context.includes("Clearing it fixes"), "context must include the line after the link");

  // exact-case link resolves too
  const nodePin = brain.byId.get("01J8A000000000000000000002")!;
  assert.deepEqual(backlinksFor(brain, nodePin).map((l) => l.id), ["01J8A000000000000000000001"]);
});

// ---- confidence + recall ----

check("confidence caps: human 0.95, sourced agent 0.85, bare agent 0.60", () => {
  const brain = loadBrain(BASIC);
  const cap = (id: string) => capFor(brain.byId.get(id)!);
  assert.equal(cap("01J8A000000000000000000001"), 0.95); // human
  assert.equal(cap("01J8A000000000000000000002"), 0.85); // agent + source URL
  assert.equal(cap("01J8A000000000000000000003"), 0.6); // agent, no source
});

check("confidence formula: fresh uncredited notes sit 0.10 under their cap", () => {
  assert.equal(confidenceFor(fakeNote(), NOW), 0.85); // human
  assert.equal(confidenceFor(fakeNote({ author: { human: "d", agent: "Codex" }, body: "source: RFC 9110" }), NOW), 0.75);
  assert.equal(confidenceFor(fakeNote({ author: { human: "d", agent: "Codex" } }), NOW), 0.5, "0.60 - 0.10 must round to exactly 0.50");
});

check("confidence formula: each credit lifts 0.05, three credits earn the cap back, extra credits never exceed it", () => {
  assert.equal(confidenceFor(fakeNote({ credits: 1, last_credited: daysAgo(1) }), NOW), 0.9);
  assert.equal(confidenceFor(fakeNote({ credits: 2, last_credited: daysAgo(1) }), NOW), 0.95);
  assert.equal(confidenceFor(fakeNote({ credits: 3, last_credited: daysAgo(1) }), NOW), 0.95, "clamped at the 0.95 cap");
  assert.equal(confidenceFor(fakeNote({ credits: 50, last_credited: daysAgo(1) }), NOW), 0.95, "credit lift saturates at 3");
  const sourcedAgent = { author: { human: "d", agent: "Codex" }, body: "source: docs", credits: 3, last_credited: daysAgo(1) };
  assert.equal(confidenceFor(fakeNote(sourcedAgent), NOW), 0.85, "sourced agent notes clamp at 0.85");
  const bareAgent = { author: { human: "d", agent: "Codex" }, credits: 3, last_credited: daysAgo(1) };
  assert.equal(confidenceFor(fakeNote(bareAgent), NOW), 0.6, "bare agent notes clamp at 0.60");
});

check("confidence formula: staleness decays 0.05 per full 90 days, max 0.15, floored well above 0.20", () => {
  assert.equal(stalenessFor(fakeNote({ created: daysAgo(89) }), NOW), 0);
  assert.equal(stalenessFor(fakeNote({ created: daysAgo(90) }), NOW), 0.05);
  assert.equal(stalenessFor(fakeNote({ created: daysAgo(270) }), NOW), 0.15);
  assert.equal(stalenessFor(fakeNote({ created: daysAgo(2000) }), NOW), 0.15, "staleness caps at 0.15");
  assert.equal(confidenceFor(fakeNote({ created: daysAgo(91) }), NOW), 0.8);
  assert.equal(confidenceFor(fakeNote({ created: daysAgo(181) }), NOW), 0.75);
  assert.equal(confidenceFor(fakeNote({ created: daysAgo(500) }), NOW), 0.7);
  // the worst legal score: bare agent, uncredited, fully stale; stays above the 0.20 floor
  const worst = confidenceFor(fakeNote({ author: { human: "d", agent: "Codex" }, created: daysAgo(2000) }), NOW);
  assert.equal(worst, 0.35);
  assert.ok(worst >= 0.2, "clamp floor is 0.20");
});

check("confidence formula: last_credited resets the staleness clock that created started", () => {
  const oldButCredited = fakeNote({ created: daysAgo(400), credits: 1, last_credited: daysAgo(10) });
  assert.equal(confidenceFor(oldButCredited, NOW), 0.9, "a recent credit erases age-based decay");
  const oldCredit = fakeNote({ created: daysAgo(400), credits: 1, last_credited: daysAgo(100) });
  assert.equal(confidenceFor(oldCredit, NOW), 0.85, "staleness counts from the last credit, not creation");
});

check("tiers: proven needs a credit AND 0.80+, standing is 0.60+, verify below; decay demotes", () => {
  assert.equal(tierFor(0.85, 0), "standing", "an uncredited note can never be proven");
  assert.equal(tierFor(0.9, 1), "proven");
  assert.equal(tierFor(0.8, 1), "proven");
  assert.equal(tierFor(0.79, 3), "standing");
  assert.equal(tierFor(0.6, 0), "standing");
  assert.equal(tierFor(0.59, 0), "verify");
  assert.equal(tierFor(0.5, 0), "verify");
  // transitions on real notes: a credited human note decays from proven to standing after ~9 uncredited months
  const proven = fakeNote({ credits: 1, last_credited: daysAgo(100) });
  assert.equal(confidenceFor(proven, NOW), 0.85);
  assert.equal(tierFor(confidenceFor(proven, NOW), proven.credits), "proven");
  const lapsed = fakeNote({ credits: 1, last_credited: daysAgo(280) });
  assert.equal(confidenceFor(lapsed, NOW), 0.75);
  assert.equal(tierFor(confidenceFor(lapsed, NOW), lapsed.credits), "standing");
  // bare agent notes top out at standing no matter how credited
  const bareAgent = fakeNote({ author: { human: "d", agent: "Codex" }, credits: 5, last_credited: daysAgo(1) });
  assert.equal(tierFor(confidenceFor(bareAgent, NOW), bareAgent.credits), "standing");
});

check("isSourced: source: line, bare URL, or neither", () => {
  assert.equal(isSourced("claim\nsource: RFC 9110 section 8"), true);
  assert.equal(isSourced("see https://example.com/doc"), true);
  assert.equal(isSourced("just vibes"), false);
});

check("recall: no query returns all active notes, newest first, with shape fields", () => {
  const results = recall(loadBrain(BASIC), { now: NOW });
  assert.deepEqual(
    results.map((r) => r.id),
    [
      "01J8A000000000000000000005",
      "01J8A000000000000000000003",
      "01J8A000000000000000000002",
      "01J8A000000000000000000001",
    ],
    "superseded 000...004 must be excluded, order newest first",
  );
  const pnpm = results.find((r) => r.id === "01J8A000000000000000000001")!;
  assert.equal(pnpm.tier, "proven", "3 fresh credits at a 0.95 cap is proven");
  assert.equal(pnpm.confidence, 0.95);
  assert.equal(pnpm.credits, 3);
  assert.equal(pnpm.backlinks.length, 1);
  const sourced = results.find((r) => r.id === "01J8A000000000000000000002")!;
  assert.equal(sourced.confidence, 0.75);
  assert.equal(sourced.tier, "standing");
  const bare = results.find((r) => r.id === "01J8A000000000000000000003")!;
  assert.equal(bare.confidence, 0.5);
  assert.equal(bare.tier, "verify");
});

check("recall: query matches title or body substring, case-insensitively", () => {
  const brain = loadBrain(BASIC);
  assert.deepEqual(
    recall(brain, { query: "PNPM" }).map((r) => r.id),
    ["01J8A000000000000000000003", "01J8A000000000000000000001"],
  );
  assert.deepEqual(recall(brain, { query: "sharp binary" }).map((r) => r.id), ["01J8A000000000000000000002"]);
  assert.deepEqual(recall(brain, { query: "no such phrase anywhere" }), []);
});

check("recall: type filter, alone and with a query", () => {
  const brain = loadBrain(BASIC);
  assert.deepEqual(recall(brain, { type: "convention" }).map((r) => r.id), ["01J8A000000000000000000005"]);
  assert.deepEqual(recall(brain, { type: "gotcha", query: "node" }).map((r) => r.id), ["01J8A000000000000000000002"]);
  assert.deepEqual(recall(brain, { type: "gotcha", query: "pnpm" }), []);
});

// ---- crediting ----

check("credit: stamps credits + last_credited on the file in place, body untouched, doctor clean", () => {
  const dir = tmpdir("brain-credit-");
  try {
    const note = createNote(dir, {
      type: "gotcha",
      title: "Staging DB resets nightly",
      body: "Every night at 02:00 UTC. Do not debug 'missing' rows at 02:05.",
      author: { human: "diego", agent: "Claude Code" },
    });
    const once = creditNotes(dir, [note.id], "2026-08-18T12:00:00.000Z");
    assert.equal(once.length, 1);
    assert.equal(once[0].credits, 1);
    assert.equal(once[0].last_credited, "2026-08-18T12:00:00.000Z");
    const reread = parseNoteFile(note.file, fs.readFileSync(note.file, "utf8")).note!;
    assert.equal(reread.credits, 1, "the credit must be stamped on disk");
    assert.equal(reread.last_credited, "2026-08-18T12:00:00.000Z");
    assert.equal(reread.body, note.body, "crediting must never touch the body");
    assert.equal(reread.created, note.created);
    creditNotes(dir, [note.id], "2026-08-19T12:00:00.000Z");
    const again = parseNoteFile(note.file, fs.readFileSync(note.file, "utf8")).note!;
    assert.equal(again.credits, 2, "credits accumulate");
    assert.deepEqual(diagnose(dir), [], "a credited brain must stay valid");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("credit: an unknown id refuses and stamps NOTHING, even for the valid ids in the batch", () => {
  const dir = tmpdir("brain-credit2-");
  try {
    const good = createNote(dir, { type: "note", title: "Good", body: "x", author: { human: "d", agent: null } });
    assert.throws(() => creditNotes(dir, [good.id, "01J8NOPE00000000000000NOPE"]), /no note with id/);
    const reread = parseNoteFile(good.file, fs.readFileSync(good.file, "utf8")).note!;
    assert.equal(reread.credits, 0, "validate-first: the good note must not have been stamped");
    assert.throws(() => creditNotes(dir, []), /at least one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("credit: raises recall confidence toward the cap", () => {
  const dir = tmpdir("brain-credit3-");
  try {
    const author = { human: "diego", agent: "Claude Code" };
    const a = createNote(dir, { type: "note", title: "Alpha", body: "fact one\n\nsource: https://example.com/a", author });
    createNote(dir, { type: "note", title: "Beta", body: "fact two\n\nsource: https://example.com/b", author });
    const before = recall(loadBrain(dir), { now: NOW });
    assert.ok(before.every((r) => r.confidence === 0.75), "both sourced agent notes start at 0.75");
    creditNotes(dir, [a.id], daysAgo(0));
    const after = recall(loadBrain(dir), { now: NOW });
    const alpha = after.find((r) => r.title === "Alpha")!;
    const beta = after.find((r) => r.title === "Beta")!;
    assert.equal(alpha.confidence, 0.8);
    assert.equal(alpha.tier, "proven");
    assert.equal(beta.confidence, 0.75);
    assert.ok(alpha.confidence > beta.confidence, "the credited note must outrank its uncredited twin");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- tasks ----

check("task round-trip: serialize/parse preserves status, assigned_to, claimed_by, result", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "task",
    title: "Draft the FAQ",
    author: { human: "diego", agent: "claude-code" },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    credits: 0,
    last_credited: null,
    status: "done",
    assigned_to: "codex",
    claimed_by: "codex",
    result: "FAQ drafted in docs/faq.md: 12 questions",
    body: "Read docs/brief.md and draft the FAQ.",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  const { file: _f, ...roundTripped } = parsed.note!;
  assert.deepEqual(roundTripped, note);
});

check("assign_task: writes an open task note; non-task notes carry no task fields", () => {
  const dir = tmpdir("brain-task-");
  try {
    const task = assignTask(dir, {
      title: "Draft the FAQ",
      instructions: "Read docs/brief.md and draft the FAQ as docs/faq.md.",
      assigned_to: "codex",
      author: { human: "diego", agent: "claude-code" },
    });
    assert.equal(task.type, "task");
    assert.equal(task.status, "open");
    assert.equal(task.assigned_to, "codex");
    assert.equal(task.claimed_by, null);
    assert.equal(task.result, null);
    const reread = parseNoteFile(task.file, fs.readFileSync(task.file, "utf8")).note!;
    assert.equal(reread.status, "open");
    assert.equal(reread.assigned_to, "codex");
    const plain = createNote(dir, { type: "note", title: "Not a task", body: "x", author: { human: "d", agent: null } });
    assert.equal(plain.status, undefined);
    assert.ok(!fs.readFileSync(plain.file, "utf8").includes("status:"), "non-task frontmatter must not carry task fields");
    assert.deepEqual(diagnose(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("claim_task: stamps claim on disk; double-claim, wrong assignee, and done tasks refuse", () => {
  const dir = tmpdir("brain-task2-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const addressed = assignTask(dir, { title: "For codex", instructions: "x", assigned_to: "codex", author });
    const anyone = assignTask(dir, { title: "For anyone", instructions: "y", author });
    assert.throws(() => claimTask(dir, addressed.id, "gemini"), /assigned to codex, not gemini/);
    const claimed = claimTask(dir, addressed.id, "Codex");
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimed_by, "Codex", "labels match case-insensitively, the claimer's spelling is kept");
    const reread = parseNoteFile(addressed.file, fs.readFileSync(addressed.file, "utf8")).note!;
    assert.equal(reread.status, "claimed");
    assert.equal(reread.body, "x", "claiming must not touch the instructions");
    assert.throws(() => claimTask(dir, addressed.id, "gemini"), /already claimed by Codex/);
    const done = completeTask(dir, anyone.id, "did it", "gemini");
    assert.equal(done.status, "done");
    assert.equal(done.claimed_by, "gemini", "completing an open task stamps the completer as claimant");
    assert.throws(() => claimTask(dir, anyone.id, "codex"), /already done/);
    assert.deepEqual(diagnose(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("complete_task: stamps result + done; refuses someone else's claim and empty results", () => {
  const dir = tmpdir("brain-task3-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const task = assignTask(dir, { title: "Claimed work", instructions: "z", assigned_to: null, author });
    claimTask(dir, task.id, "codex");
    assert.throws(() => completeTask(dir, task.id, "hijacked", "gemini"), /claimed by codex, not gemini/);
    assert.throws(() => completeTask(dir, task.id, "   ", "codex"), /short result/);
    const done = completeTask(dir, task.id, "Shipped: see docs/out.md", "CODEX");
    assert.equal(done.status, "done");
    assert.equal(done.result, "Shipped: see docs/out.md");
    const reread = parseNoteFile(task.file, fs.readFileSync(task.file, "utf8")).note!;
    assert.equal(reread.result, "Shipped: see docs/out.md");
    assert.throws(() => completeTask(dir, task.id, "again", "codex"), /already done/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("list_tasks + openTasksFor: mine means addressed to me or unassigned; label matching is case-insensitive", () => {
  const dir = tmpdir("brain-task4-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const at = (day: number) => ({ created: `2026-08-0${day}T10:00:00.000Z`, id: ulid(Date.parse(`2026-08-0${day}T10:00:00.000Z`)) });
    const forCodex = assignTask(dir, { title: "T1 for codex", instructions: "a", assigned_to: "codex", author, ...at(1) });
    assignTask(dir, { title: "T2 for anyone", instructions: "b", author, ...at(2) });
    const forClaude = assignTask(dir, { title: "T3 for claude-code", instructions: "c", assigned_to: "claude-code", author, ...at(3) });
    const claimed = assignTask(dir, { title: "T4 claimed", instructions: "d", author, ...at(4) });
    claimTask(dir, claimed.id, "codex");

    const brain = loadBrain(dir);
    assert.equal(listTasks(brain, "all").length, 4);
    assert.deepEqual(
      listTasks(brain, "open").map((t) => t.title),
      ["T1 for codex", "T2 for anyone", "T3 for claude-code"],
      "open excludes claimed, oldest first",
    );
    assert.deepEqual(
      listTasks(brain, "mine", "Codex").map((t) => t.title),
      ["T1 for codex", "T2 for anyone"],
      "mine = addressed to my label (any case) or unassigned",
    );
    assert.deepEqual(openTasksFor(brain, "codex").map((t) => t.id), [forCodex.id, listTasks(brain, "open")[1].id]);
    assert.deepEqual(
      openTasksFor(brain, null).map((t) => t.title),
      ["T2 for anyone"],
      "without a label only unassigned tasks surface",
    );
    assert.deepEqual(openTasksFor(brain, "claude-code").map((t) => t.id).includes(forClaude.id), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- search ranking ----

check("search: ranked multi-term, title hits weigh 3x body hits, backlinks add 0.5", () => {
  const brain = loadBrain(BASIC);
  // "pnpm": title+body+backlink on the pnpm note (4.5) beats a body-only hit (1)
  assert.deepEqual(
    searchRanked(brain, "pnpm", NOW).map((r) => r.id),
    ["01J8A000000000000000000001", "01J8A000000000000000000003"],
    "plain substring recall would have returned the newer note first; ranking flips it",
  );
  // "pnpm cache": the cache note scores 3 (title) + 1 (body) + 1 (pnpm in body) = 5, beating 4.5
  assert.deepEqual(
    searchRanked(brain, "pnpm cache", NOW).map((r) => r.id),
    ["01J8A000000000000000000003", "01J8A000000000000000000001"],
  );
  assert.deepEqual(searchRanked(brain, "zzqxv", NOW), []);
  assert.deepEqual(searchRanked(brain, "   ", NOW), []);
  const top = searchRanked(brain, "pnpm", NOW)[0];
  assert.equal(top.confidence, 0.95, "search results carry the same shape as recall");
  assert.equal(top.tier, "proven");
  assert.equal(top.backlinks.length, 1);
});

check("search: equal scores tie-break by recency", () => {
  const dir = tmpdir("brain-search-");
  try {
    const author = { human: "d", agent: null };
    createNote(dir, { type: "note", title: "Older", body: "the flumph rule applies", author, created: "2026-08-01T10:00:00.000Z", id: ulid(Date.parse("2026-08-01T10:00:00.000Z")) });
    createNote(dir, { type: "note", title: "Newer", body: "the flumph rule also here", author, created: "2026-08-02T10:00:00.000Z", id: ulid(Date.parse("2026-08-02T10:00:00.000Z")) });
    const results = searchRanked(loadBrain(dir), "flumph", NOW);
    assert.deepEqual(results.map((r) => r.title), ["Newer", "Older"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- doctor / diagnose ----

check("diagnose: clean fixture has zero problems", () => {
  assert.deepEqual(diagnose(BASIC), []);
});

check("diagnose: broken fixture reports parse errors, broken wikilinks, dangling and mismatched chains", () => {
  const problems = diagnose(BROKEN);
  const messages = problems.map((p) => `${path.basename(p.file)}: ${p.message}`).join("\n");
  assert.ok(/bad-frontmatter\.md: missing id/.test(messages), messages);
  assert.ok(/bad-frontmatter\.md: invalid type: feeling/.test(messages), messages);
  assert.ok(/bad-frontmatter\.md: created is not an ISO timestamp/.test(messages), messages);
  assert.ok(/bad-frontmatter\.md: credits is not a non-negative integer/.test(messages), messages);
  assert.ok(/broken-link\.md: broken wikilink \[\[No Such Note\]\]/.test(messages), messages);
  assert.ok(/dangling-supersedes\.md: dangling supersedes: 01J8B0000000000000000GHOST/.test(messages), messages);
  assert.ok(/mismatched-chain\.md: supersedes chain mismatch/.test(messages), messages);
});

check("diagnose: task inconsistencies (done without result, claimed without claimed_by)", () => {
  const dir = tmpdir("brain-doc-task-");
  try {
    const base: Omit<Note, "file"> = {
      id: "01J8C000000000000000000001",
      type: "task",
      title: "Done but no result",
      author: { human: "d", agent: "codex" },
      created: "2026-08-10T10:00:00.000Z",
      supersedes: null,
      credits: 0,
      last_credited: null,
      status: "done",
      assigned_to: null,
      claimed_by: "codex",
      result: null,
      body: "x",
    };
    fs.writeFileSync(path.join(dir, "done-no-result.md"), serializeNote(base));
    fs.writeFileSync(
      path.join(dir, "claimed-no-claimant.md"),
      serializeNote({ ...base, id: "01J8C000000000000000000002", title: "Claimed but nobody", status: "claimed", claimed_by: null }),
    );
    const messages = diagnose(dir).map((p) => `${path.basename(p.file)}: ${p.message}`).join("\n");
    assert.ok(/done-no-result\.md: task is done but has no result/.test(messages), messages);
    assert.ok(/claimed-no-claimant\.md: task is claimed but has no claimed_by/.test(messages), messages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("diagnose: warns on duplicate ACTIVE titles (ambiguous wikilinks); a superseded twin is fine", () => {
  const dir = tmpdir("brain-doc-dup-");
  try {
    const author = { human: "d", agent: null };
    createNote(dir, { type: "note", title: "Cache rules", body: "first", author, created: "2026-08-01T10:00:00.000Z", id: ulid(Date.parse("2026-08-01T10:00:00.000Z")) });
    createNote(dir, { type: "note", title: "cache RULES", body: "second", author, created: "2026-08-02T10:00:00.000Z", id: ulid(Date.parse("2026-08-02T10:00:00.000Z")) });
    const messages = diagnose(dir).map((p) => p.message).join("\n");
    assert.ok(/duplicate title "cache RULES"/.test(messages), messages);
    // the BASIC fixture also has two notes titled "Commit message style", but one is superseded: no warning there
    assert.ok(!diagnose(BASIC).some((p) => p.message.includes("duplicate title")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- CLI end-to-end (child processes) ----

check("cli init: creates the dir, writes SCHEMA.md, prints git advice and the mcp add line", () => {
  const cwd = tmpdir("brain-init-");
  try {
    const r = runCli(["init"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    const schema = path.join(cwd, "brain", "SCHEMA.md");
    assert.ok(fs.existsSync(schema), "brain/SCHEMA.md must exist");
    assert.ok(fs.readFileSync(schema, "utf8").includes("never overwrite"), "SCHEMA.md must explain the rule");
    assert.ok(r.stdout.includes("do not add it to .gitignore"), r.stdout);
    assert.ok(r.stdout.includes("claude mcp add brain -- npx cookbook-brain serve"), r.stdout);
    // idempotent
    const again = runCli(["init"], { cwd });
    assert.equal(again.status, 0);
    assert.ok(again.stdout.includes("already initialized"), again.stdout);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

check("cli log: newest first with id, type, title, author, credits; superseded flagged", () => {
  const r = runCli(["log", "--dir", BASIC]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("5 note(s)"), r.stdout);
  assert.ok(r.stdout.includes("(4 active)"), r.stdout);
  const posNewest = r.stdout.indexOf("01J8A000000000000000000005");
  const posOldest = r.stdout.indexOf("01J8A000000000000000000001");
  assert.ok(posNewest !== -1 && posOldest !== -1 && posNewest < posOldest, "newest id must print first");
  assert.ok(r.stdout.includes("decision"), r.stdout);
  assert.ok(r.stdout.includes("Use pnpm everywhere"), r.stdout);
  assert.ok(r.stdout.includes("by diego via Claude Code"), r.stdout);
  assert.ok(r.stdout.includes("credits  3"), r.stdout);
  assert.ok(r.stdout.includes("[superseded]"), r.stdout);
});

check("cli log honors BRAIN_DIR env", () => {
  const r = runCli(["log"], { env: { BRAIN_DIR: BASIC } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("Use pnpm everywhere"), r.stdout);
});

check("cli doctor: exit 0 and ok line on the clean fixture", () => {
  const r = runCli(["doctor", "--dir", BASIC]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("ok: every note parses"), r.stdout);
});

check("cli doctor: exit 1 with the problem list on the broken fixture", () => {
  const r = runCli(["doctor", "--dir", BROKEN]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.ok(r.stdout.includes("broken wikilink"), r.stdout);
  assert.ok(r.stdout.includes("dangling supersedes"), r.stdout);
});

check("cli: unknown command and missing brain dir fail with guidance", () => {
  assert.equal(runCli(["frobnicate"]).status, 2);
  const r = runCli(["log", "--dir", path.join(os.tmpdir(), "definitely-missing-brain")]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("cookbook-brain init"), r.stderr);
});

check("cli credit: stamps the notes and prints new credits + confidence; refuses without ids", () => {
  const dir = tmpdir("brain-cli-credit-");
  try {
    const note = createNote(dir, {
      type: "decision",
      title: "Poll interval is 30s",
      body: "Free tiers rate-limit below that.",
      author: { human: "diego", agent: null },
    });
    const r = runCli(["credit", note.id, "--dir", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("credited 1 note(s)"), r.stdout);
    assert.ok(r.stdout.includes("credits  1"), r.stdout);
    assert.ok(r.stdout.includes("confidence 0.90 (proven)"), r.stdout);
    const reread = parseNoteFile(note.file, fs.readFileSync(note.file, "utf8")).note!;
    assert.equal(reread.credits, 1);
    assert.equal(runCli(["credit", "--dir", dir]).status, 2, "credit with no ids must fail with guidance");
    const bad = runCli(["credit", "01J8NOPE00000000000000NOPE", "--dir", dir]);
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes("nothing was credited"), bad.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli tasks: lists open + claimed with age and addressee; done tasks drop off", () => {
  const dir = tmpdir("brain-cli-tasks-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const t1 = assignTask(dir, { title: "Draft the FAQ", instructions: "x", assigned_to: "codex", author });
    const t2 = assignTask(dir, { title: "Sweep the logs", instructions: "y", author });
    claimTask(dir, t2.id, "codex");
    const r = runCli(["tasks", "--dir", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2 waiting task(s)"), r.stdout);
    assert.ok(r.stdout.includes("open"), r.stdout);
    assert.ok(r.stdout.includes("Draft the FAQ"), r.stdout);
    assert.ok(r.stdout.includes("for codex, today"), r.stdout);
    assert.ok(r.stdout.includes("claimed by codex"), r.stdout);
    completeTask(dir, t1.id, "done", "codex");
    completeTask(dir, t2.id, "done", "codex");
    const empty = runCli(["tasks", "--dir", dir]);
    assert.ok(empty.stdout.includes("no open or claimed tasks"), empty.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- MCP server smoke test over stdio ----

interface RpcClient {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

function spawnServer(dir: string, env: Record<string, string>): RpcClient {
  const child = spawn(process.execPath, [BIN, "serve", "--dir", dir], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`));
        else waiter.resolve(msg.result);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      const p = new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
        }, 15_000);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
      return p;
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
    },
    close() {
      child.kill();
    },
  };
}

async function mcpSmokeTest(): Promise<void> {
  const dir = tmpdir("brain-mcp-");
  const client = spawnServer(dir, { BRAIN_HUMAN: "testhuman" });
  try {
    await checkAsync("mcp: initialize handshake identifies the server", async () => {
      const init = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "brain-test", version: "0.0.0" },
      });
      assert.equal(init.serverInfo.name, "cookbook-brain");
      client.notify("notifications/initialized");
    });

    await checkAsync("mcp: tools/list exposes all ten tools with teaching descriptions", async () => {
      const list = await client.request("tools/list");
      const names = list.tools.map((t: any) => t.name).sort();
      assert.deepEqual(names, [
        "abandon_task",
        "assign_task",
        "claim_task",
        "complete_task",
        "credit",
        "list_tasks",
        "recall",
        "remember",
        "search",
        "supersede",
      ]);
      const abandon = list.tools.find((t: any) => t.name === "abandon_task");
      assert.ok(abandon.description.includes("reason"), "abandon_task must teach that the reason goes on the record");
      const rememberSource = list.tools.find((t: any) => t.name === "remember");
      assert.ok(JSON.stringify(rememberSource.inputSchema).includes("auditable"), "remember must teach that cited memory is auditable memory");
      const remember = list.tools.find((t: any) => t.name === "remember");
      assert.ok(remember.description.includes("ATOMIC"), "description must teach atomicity");
      assert.ok(remember.description.includes("source"), "description must teach sourcing");
      const credit = list.tools.find((t: any) => t.name === "credit");
      assert.ok(credit.description.includes("verifiably"), "credit must teach that credit is for verified outcomes");
      const complete = list.tools.find((t: any) => t.name === "complete_task");
      assert.ok(complete.description.includes("helped_note_ids"), "complete_task must teach the crediting moment");
      const recallTool = list.tools.find((t: any) => t.name === "recall");
      assert.ok(recallTool.description.includes("open_tasks"), "recall must teach task discovery");
      assert.ok(recallTool.description.includes("apply these to your work"), "recall must teach that conventions are to be applied");
    });

    let noteId = "";
    await checkAsync("mcp: remember writes a note attributed to BRAIN_HUMAN + agent label", async () => {
      const res = await client.request("tools/call", {
        name: "remember",
        arguments: {
          type: "gotcha",
          title: "Stdio servers must not print to stdout",
          body: "Anything on stdout corrupts the JSON-RPC stream; log to stderr.\n\nsource: https://modelcontextprotocol.io/docs",
          agent_label: "Claude Code",
        },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.author.human, "testhuman");
      assert.equal(payload.author.agent, "Claude Code");
      assert.match(payload.id, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
      noteId = payload.id;
      assert.ok(fs.existsSync(payload.file), "note file must exist on disk");
    });

    await checkAsync("mcp: recall returns the note with confidence, tier, credits, backlinks, open_tasks", async () => {
      const res = await client.request("tools/call", {
        name: "recall",
        arguments: { query: "stdout" },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.count, 1);
      const note = payload.notes[0];
      assert.equal(note.id, noteId);
      assert.equal(note.confidence, 0.75, "fresh uncredited sourced agent note: 0.85 cap - 0.10");
      assert.equal(note.tier, "standing");
      assert.equal(note.credits, 0);
      assert.deepEqual(note.backlinks, []);
      assert.deepEqual(payload.open_tasks, [], "recall always carries the open_tasks section");
    });

    await checkAsync("mcp: search matches no absent terms, and ranks present ones", async () => {
      const res = await client.request("tools/call", {
        name: "search",
        arguments: { query: "zzqxv wqqzk" },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.count, 0);
      const hit = await client.request("tools/call", { name: "search", arguments: { query: "stdout stderr" } });
      const hitPayload = JSON.parse(hit.content[0].text);
      assert.equal(hitPayload.count, 1);
      assert.equal(hitPayload.notes[0].id, noteId);
    });

    await checkAsync("mcp: supersede archives the old note and recall stops returning it", async () => {
      const res = await client.request("tools/call", {
        name: "supersede",
        arguments: {
          old_id: noteId,
          type: "gotcha",
          title: "Stdio servers must not print to stdout",
          body: "Still true, and also applies to child processes inheriting stdout.\n\nsource: https://modelcontextprotocol.io/docs",
          agent_label: "Claude Code",
        },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.superseded.id, noteId);
      assert.equal(payload.note.supersedes, noteId);

      const after = await client.request("tools/call", { name: "recall", arguments: { query: "stdout" } });
      const notes = JSON.parse(after.content[0].text).notes;
      assert.deepEqual(notes.map((n: any) => n.id), [payload.note.id]);
    });
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await mcpSmokeTest();

/**
 * The full multi-agent loop over real stdio: claude-code leaves work and
 * knowledge, codex discovers the task on recall, claims it, completes it
 * crediting the note that helped, and the note's confidence rises.
 */
async function mcpTaskLifecycleTest(): Promise<void> {
  const dir = tmpdir("brain-mcp-tasks-");
  const client = spawnServer(dir, { BRAIN_HUMAN: "diego" });
  const call = async (name: string, args: unknown) => {
    const res = await client.request("tools/call", { name, arguments: args });
    const isError = res.isError === true;
    return { payload: isError ? null : JSON.parse(res.content[0].text), isError, raw: res };
  };
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "brain-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized");

    let helpedId = "";
    let bystanderId = "";
    let taskId = "";
    let openTaskId = "";

    await checkAsync("mcp tasks: claude-code remembers two notes and assigns work to codex", async () => {
      const a = await call("remember", {
        type: "gotcha",
        title: "Brief lives in docs, not the wiki",
        body: "The FAQ source of truth is docs/brief.md; the wiki copy is stale.\n\nsource: https://example.com/repo/docs/brief.md",
        agent_label: "claude-code",
      });
      helpedId = a.payload.id;
      const b = await call("remember", {
        type: "note",
        title: "Tone guide for docs",
        body: "Plain sentences, no marketing voice.\n\nsource: https://example.com/repo/docs/tone.md",
        agent_label: "claude-code",
      });
      bystanderId = b.payload.id;
      const t = await call("assign_task", {
        title: "Draft the FAQ",
        instructions: "Read [[Brief lives in docs, not the wiki]] and draft docs/faq.md.",
        assigned_to: "codex",
        agent_label: "claude-code",
      });
      assert.equal(t.payload.task.status, "open");
      assert.equal(t.payload.task.assigned_to, "codex");
      taskId = t.payload.task.id;
      // ULIDs order by millisecond; make sure the second task is born in a later one
      await new Promise((r) => setTimeout(r, 5));
      const anyTask = await call("assign_task", {
        title: "Sweep stale wiki pages",
        instructions: "List wiki pages older than 90 days.",
        agent_label: "claude-code",
      });
      openTaskId = anyTask.payload.task.id;
    });

    await checkAsync("mcp tasks: codex lists mine and sees the addressed task plus the unassigned one", async () => {
      const mine = await call("list_tasks", { filter: "mine", agent_label: "codex" });
      assert.deepEqual(
        mine.payload.tasks.map((t: any) => t.id),
        [taskId, openTaskId],
        "mine = addressed to me or unassigned, oldest first",
      );
      const other = await call("list_tasks", { filter: "mine", agent_label: "gemini" });
      assert.deepEqual(other.payload.tasks.map((t: any) => t.id), [openTaskId], "another agent only sees the unassigned task");
    });

    await checkAsync("mcp tasks: recall surfaces waiting work in open_tasks on session start", async () => {
      const res = await call("recall", { agent_label: "codex" });
      assert.deepEqual(res.payload.open_tasks.map((t: any) => t.id), [taskId, openTaskId]);
      assert.ok(res.payload.open_tasks[0].instructions.includes("draft docs/faq.md"), "open_tasks must carry the instructions");
      const anonymous = await call("recall", {});
      assert.deepEqual(anonymous.payload.open_tasks.map((t: any) => t.id), [openTaskId], "no label, only unassigned tasks surface");
    });

    await checkAsync("mcp tasks: claim succeeds once and the double-claim refuses", async () => {
      const claim = await call("claim_task", { id: taskId, agent_label: "codex" });
      assert.equal(claim.payload.task.status, "claimed");
      assert.equal(claim.payload.task.claimed_by, "codex");
      const again = await call("claim_task", { id: taskId, agent_label: "gemini" });
      assert.equal(again.isError, true);
      assert.ok(again.raw.content[0].text.includes("already claimed by codex"), again.raw.content[0].text);
    });

    await checkAsync("mcp tasks: complete credits the helped note and says so", async () => {
      const done = await call("complete_task", {
        id: taskId,
        result: "Drafted docs/faq.md with 9 questions from the brief.",
        helped_note_ids: [helpedId],
        agent_label: "codex",
      });
      assert.equal(done.payload.task.status, "done");
      assert.equal(done.payload.task.result, "Drafted docs/faq.md with 9 questions from the brief.");
      assert.equal(done.payload.credited.length, 1);
      assert.equal(done.payload.credited[0].id, helpedId);
      assert.equal(done.payload.credited[0].credits, 1);
      assert.ok(done.payload.message.includes("Credited 1 note(s)"), done.payload.message);
    });

    await checkAsync("mcp tasks: recall shows the credited note's confidence above its uncredited twin", async () => {
      const res = await call("recall", { agent_label: "codex" });
      const helped = res.payload.notes.find((n: any) => n.id === helpedId);
      const bystander = res.payload.notes.find((n: any) => n.id === bystanderId);
      assert.equal(helped.confidence, 0.8, "sourced agent cap 0.85 - 0.10 + one credit");
      assert.equal(helped.tier, "proven");
      assert.equal(bystander.confidence, 0.75);
      assert.ok(helped.confidence > bystander.confidence, "verified use must outrank equal provenance");
      assert.deepEqual(res.payload.open_tasks.map((t: any) => t.id), [openTaskId], "the completed task left open_tasks");
      const all = await call("list_tasks", { filter: "all", agent_label: "codex" });
      assert.equal(all.payload.tasks.find((t: any) => t.id === taskId).status, "done");
    });
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await mcpTaskLifecycleTest();

// ---- M3: consolidates field + consolidateNotes ----

check("consolidates: serialize/parse round-trip preserves the id list", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "convention",
    title: "Merged cache rules",
    author: { human: "diego", agent: "dream" },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    consolidates: ["01J8A000000000000000000001", "01J8A000000000000000000003"],
    credits: 0,
    last_credited: null,
    body: "One canonical statement of the cache rules.",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  const { file: _f, ...roundTripped } = parsed.note!;
  assert.deepEqual(roundTripped, note);
});

check("consolidates: malformed and empty lists are parse problems, not crashes", () => {
  const good = serializeNote({
    id: ulid(),
    type: "note",
    title: "T",
    author: { human: "d", agent: null },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    credits: 0,
    last_credited: null,
    body: "b",
  });
  const notAList = good.replace("supersedes: null", "supersedes: null\nconsolidates: just-some-id");
  assert.ok(parseNoteFile("x.md", notAList).problems.some((p) => p.includes("bracketed")), "unbracketed value must be a problem");
  const emptyList = good.replace("supersedes: null", "supersedes: null\nconsolidates: []");
  assert.ok(parseNoteFile("x.md", emptyList).problems.some((p) => p.includes("at least one")), "empty list must be a problem");
});

check("consolidateNotes: writes the new note, stamps every source superseded_by, doctor stays clean", () => {
  const dir = tmpdir("brain-consolidate-");
  try {
    const author = { human: "diego", agent: null };
    const a = createNote(dir, { type: "note", title: "Cache rules", body: "first half of the fact", author });
    const b = createNote(dir, { type: "note", title: "cache RULES", body: "second half of the fact", author });
    const { newNote, sources } = consolidateNotes(dir, [a.id, b.id], {
      type: "convention",
      title: "Cache rules, consolidated",
      body: "Both halves, in one place.",
      author: { human: "diego", agent: "dream" },
    });
    assert.deepEqual(newNote.consolidates, [a.id, b.id]);
    assert.deepEqual(sources.map((s) => s.superseded_by), [newNote.id, newNote.id]);
    const rereadA = parseNoteFile(a.file, fs.readFileSync(a.file, "utf8")).note!;
    assert.equal(rereadA.superseded_by, newNote.id, "the stamp must land on disk");
    assert.equal(rereadA.body, "first half of the fact", "consolidation must never touch a source body");
    const brain = loadBrain(dir);
    assert.deepEqual(activeNotes(brain).map((n) => n.id), [newNote.id], "both sources must leave the active set");
    assert.deepEqual(diagnose(dir), [], "a consolidates chain must validate clean, including the superseded_by back-check");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("consolidateNotes: validate-first refusals stamp nothing", () => {
  const dir = tmpdir("brain-consolidate2-");
  try {
    const author = { human: "d", agent: null };
    const a = createNote(dir, { type: "note", title: "Alpha", body: "x", author });
    const b = createNote(dir, { type: "note", title: "Beta", body: "y", author });
    assert.throws(() => consolidateNotes(dir, [a.id, "01J8NOPE00000000000000NOPE"], { type: "note", title: "n", body: "b", author }), /nothing was consolidated/);
    assert.equal(parseNoteFile(a.file, fs.readFileSync(a.file, "utf8")).note!.superseded_by, undefined, "the good source must be untouched");
    assert.throws(() => consolidateNotes(dir, [a.id, a.id], { type: "note", title: "n", body: "b", author }), /distinct/);
    assert.throws(() => consolidateNotes(dir, [], { type: "note", title: "n", body: "b", author }), /at least one/);
    supersedeNote(dir, b.id, { type: "note", title: "Beta v2", body: "y2", author });
    assert.throws(() => consolidateNotes(dir, [a.id, b.id], { type: "note", title: "n", body: "b", author }), /already superseded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("diagnose: dangling and unstamped consolidates chains are reported", () => {
  const dir = tmpdir("brain-doc-consolidate-");
  try {
    const author = { human: "d", agent: null };
    const orphan = createNote(dir, { type: "note", title: "Unstamped source", body: "x", author });
    fs.writeFileSync(
      path.join(dir, "bad-merge.md"),
      serializeNote({
        id: "01J8D000000000000000000001",
        type: "note",
        title: "Bad merge",
        author: { human: "d", agent: "dream" },
        created: "2026-08-18T10:00:00.000Z",
        supersedes: null,
        consolidates: [orphan.id, "01J8B0000000000000000GHOST"],
        credits: 0,
        last_credited: null,
        body: "claims to consolidate, but nobody was stamped",
      }),
    );
    const messages = diagnose(dir).map((p) => p.message).join("\n");
    assert.ok(/dangling consolidates: 01J8B0000000000000000GHOST/.test(messages), messages);
    assert.ok(/consolidates chain mismatch/.test(messages), messages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- M3: dream hygiene, digest, JSON guard ----

/** Seed the three hygiene cases: a duplicate active title pair, a superseded-but-referenced link, a stale unproven note. */
function seedHygieneBrain(dir: string): { dupA: Note; dupB: Note; oldRule: Note; stale: Note } {
  const author = { human: "diego", agent: null };
  const at = (daysOld: number) => {
    const created = daysAgo(daysOld);
    return { created, id: ulid(Date.parse(created)) };
  };
  const dupA = createNote(dir, { type: "note", title: "Cache rules", body: "pnpm cache lives in .pnpm-cache", author, ...at(30) });
  const dupB = createNote(dir, { type: "note", title: "cache rules", body: "clear the cache when lockfiles change", author, ...at(20) });
  const oldRule = createNote(dir, { type: "decision", title: "Old deploy rule", body: "deploy Fridays", author, ...at(15) });
  supersedeNote(dir, oldRule.id, { type: "decision", title: "New deploy rule", body: "never deploy Fridays", author, ...at(10) });
  createNote(dir, { type: "note", title: "Release checklist", body: "follow [[Old deploy rule]] before shipping", author, ...at(5) });
  const stale = createNote(dir, { type: "note", title: "Maybe flaky endpoint", body: "the status endpoint might lie", author: { human: "diego", agent: "codex" }, ...at(120) });
  return { dupA, dupB, oldRule, stale };
}

check("dream hygiene: detects duplicate titles, superseded-but-referenced links, and stale unproven notes", () => {
  const dir = tmpdir("brain-hygiene-");
  try {
    const { dupA, dupB, oldRule, stale } = seedHygieneBrain(dir);
    const h = hygieneFindings(loadBrain(dir), NOW);
    assert.equal(h.duplicateTitles.length, 1);
    assert.deepEqual(h.duplicateTitles[0].ids.sort(), [dupA.id, dupB.id].sort());
    assert.equal(h.supersededReferenced.length, 1);
    assert.equal(h.supersededReferenced[0].link, "Old deploy rule");
    assert.deepEqual(h.supersededReferenced[0].supersededIds, [oldRule.id]);
    assert.deepEqual(h.staleUnproven.map((s) => s.id), [stale.id], "a 120 day old uncredited bare-agent note is stale unproven");
    assert.ok(h.staleUnproven[0].ageDays >= 119, "age must be reported in days");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("dream digest: deterministic, sorted by id, excerpts capped at 280 flattened chars", () => {
  const dir = tmpdir("brain-digest-");
  try {
    const author = { human: "diego", agent: null };
    createNote(dir, { type: "note", title: "Long note", body: ("many words here\n".repeat(50)), author, created: daysAgo(2), id: ulid(Date.parse(daysAgo(2))) });
    createNote(dir, { type: "gotcha", title: "Short note", body: "brief", author, created: daysAgo(1), id: ulid(Date.parse(daysAgo(1))) });
    const one = buildDigest(loadBrain(dir), NOW);
    const two = buildDigest(loadBrain(dir), NOW);
    assert.equal(one.text, two.text, "same brain and clock must produce byte-identical digests");
    assert.deepEqual(one.entries.map((e) => e.id), [...one.entries.map((e) => e.id)].sort(), "entries must sort by id");
    const long = one.entries.find((e) => e.title === "Long note")!;
    assert.equal(long.excerpt.length, 280);
    assert.ok(!long.excerpt.includes("\n"), "excerpts must flatten newlines");
    const short = one.entries.find((e) => e.title === "Short note")!;
    assert.equal(short.age_days, 1);
    assert.equal(short.credits, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("dream extractJson: tolerates prose and fences, refuses garbage", () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"proposals": []}\n```\nDone.'), { proposals: [] });
  assert.deepEqual(extractJson('{"verdicts":[{"index":0,"verdict":"keep","reason":"r"}]}'), {
    verdicts: [{ index: 0, verdict: "keep", reason: "r" }],
  });
  assert.equal(extractJson("I dreamt of ponies and cannot answer."), null);
  assert.equal(extractJson("almost json { proposals: [ oops"), null);
});

// ---- M3: dream CLI end-to-end over a fake claude shim on PATH ----

/**
 * The fake `claude` binary. Hermetic: never touches the network or the real
 * CLI. It tells proposer from refuter calls by the prompt text on stdin, and
 * its behavior is driven by FAKE_CLAUDE_MODE plus FAKE_* seed ids, mirroring
 * the shim-on-PATH pattern the MCP tests use for child processes.
 */
const SHIM_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const mode = process.env.FAKE_CLAUDE_MODE || "wellformed";
const isRefuter = input.includes("You are the REFUTER");
if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ role: isRefuter ? "refuter" : "proposer", args: process.argv.slice(2), maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || null }) + "\\n",
  );
}
const out = (s) => process.stdout.write(s);
if (!isRefuter) {
  if (mode === "proposer-garbage") { out("I dreamt of electric sheep and cannot answer in JSON."); process.exit(0); }
  const proposals = [];
  if (process.env.FAKE_MERGE_IDS) {
    proposals.push({ op: "merge", source_ids: process.env.FAKE_MERGE_IDS.split(","), type: "convention", title: "Cache rules, consolidated", body: "The pnpm cache lives in .pnpm-cache; clear it when lockfiles change.", rationale: "Both notes state halves of the same cache fact." });
  }
  if (process.env.FAKE_PROMOTE_ID) {
    proposals.push({ op: "promote", source_id: process.env.FAKE_PROMOTE_ID, title: "Always pin node versions", body: "Pin node in .nvmrc; unpinned builds broke twice.", rationale: "Twice-credited gotcha; promote to convention." });
  }
  if (process.env.FAKE_CONTRA_IDS) {
    proposals.push({ op: "flag_contradiction", ids: process.env.FAKE_CONTRA_IDS.split(","), reason: "One note says deploy on Fridays, the other forbids it.", rationale: "Both cannot hold at once." });
  }
  if (process.env.FAKE_RETITLE_ID) {
    proposals.push({ op: "retitle_for_collision", id: process.env.FAKE_RETITLE_ID, new_title: "Cache paths (pnpm)", rationale: "Title collides with another active note." });
  }
  if (process.env.FAKE_BOGUS_PROPOSAL === "1") proposals.push({ op: "delete_everything", id: "nope" });
  out("Here is the dream:\\n\`\`\`json\\n" + JSON.stringify({ proposals }) + "\\n\`\`\`\\n");
  process.exit(0);
}
if (mode === "refuter-garbage") { out("As a reviewer I feel conflicted and will write a poem instead."); process.exit(0); }
const indexes = [...input.matchAll(/^PROPOSAL (\\d+):/gm)].map((m) => Number(m[1]));
let verdicts;
if (mode === "refuter-rejects-some") {
  verdicts = indexes
    .map((i) => {
      if (i === 0) return { index: 0, verdict: "keep", reason: "Sources agree; the merge loses nothing." };
      if (i === 1) return { index: 1, verdict: "reject", reason: "The draft drops the second incident's detail." };
      if (i === 2) return null;
      return { index: i, verdict: "maybe", reason: "unsure" };
    })
    .filter(Boolean);
} else {
  verdicts = indexes.map((i) => ({ index: i, verdict: "keep", reason: "Checked against the source notes; nothing is lost." }));
}
out(JSON.stringify({ verdicts }) + "\\n");
`;

const shimDir = tmpdir("brain-shim-");
fs.writeFileSync(path.join(shimDir, "claude"), SHIM_SOURCE, { mode: 0o755 });
const SHIM_PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
/** A PATH with no `claude` anywhere, for the missing-binary and dry-digest tests. */
const NO_CLAUDE_PATH = "/usr/bin:/bin";

function dreamEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: SHIM_PATH, BRAIN_HUMAN: "dreamtester", ...extra };
}

function findDreamReport(dir: string): string {
  const dreams = path.join(dir, "dreams");
  const files = fs.existsSync(dreams) ? fs.readdirSync(dreams).filter((f) => f.startsWith("DREAM_")) : [];
  assert.equal(files.length, 1, `expected exactly one dream report, found: ${files.join(", ")}`);
  return fs.readFileSync(path.join(dreams, files[0]), "utf8");
}

/** Two active notes with colliding titles, ready to be merged. */
function seedMergePair(dir: string): { a: Note; b: Note } {
  const author = { human: "diego", agent: null };
  const a = createNote(dir, { type: "note", title: "Cache rules", body: "pnpm cache lives in .pnpm-cache", author, created: daysAgo(3), id: ulid(Date.parse(daysAgo(3))) });
  const b = createNote(dir, { type: "note", title: "cache rules", body: "clear the cache when lockfiles change", author, created: daysAgo(2), id: ulid(Date.parse(daysAgo(2))) });
  return { a, b };
}

check("cli dream --dry-digest: prints the exact proposer prompt and makes no model calls (no claude needed)", () => {
  const dir = tmpdir("brain-dream-dry-");
  try {
    const { a } = seedMergePair(dir);
    const r = runCli(["dream", "--dry-digest", "--dir", dir], { env: { PATH: NO_CLAUDE_PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("You are the PROPOSER"), "must print the real proposer prompt");
    assert.ok(r.stdout.includes(a.id), "the digest must carry the note ids");
    assert.ok(r.stdout.includes("HYGIENE FINDINGS"), "the prompt must carry the hygiene seed section");
    assert.ok(r.stdout.includes('duplicate active title "Cache rules"'), r.stdout);
    assert.ok(!fs.existsSync(path.join(dir, "dreams")), "a dry run must not write a report");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream: missing claude binary fails with a friendly requirement message, never asks for API keys", () => {
  const dir = tmpdir("brain-dream-nobin-");
  try {
    seedMergePair(dir);
    const r = runCli(["dream", "--dir", dir], { env: { PATH: NO_CLAUDE_PATH } });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}`);
    assert.ok(r.stderr.includes("Claude Code CLI"), r.stderr);
    assert.ok(r.stderr.includes("never reads or requires API keys"), r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream report-only: full report with refuter: ran, and NOTHING applied", () => {
  const dir = tmpdir("brain-dream-report-");
  try {
    const { a, b } = seedMergePair(dir);
    const r = runCli(["dream", "--dir", dir], { env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("refuter: ran"), r.stdout);
    assert.ok(r.stdout.includes("report-only run"), r.stdout);
    const report = findDreamReport(dir);
    for (const section of ["# Dream report", "## Inputs digest", "## Hygiene findings", "## Proposals", "## Refuter review", "## Applied", "## Undo"]) {
      assert.ok(report.includes(section), `report must carry section: ${section}`);
    }
    assert.ok(report.includes("refuter: ran"), "the mandatory refuter line must be present");
    assert.ok(!report.includes("refuter: absent"), "a reviewed dream must not read as unreviewed");
    assert.ok(report.includes("proposal 0: keep"), report);
    assert.ok(report.includes("report-only run: nothing was applied"), report);
    assert.ok(report.includes("git revert"), "the report must say how to undo");
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2, "report-only must write no notes");
    assert.ok(brain.notes.every((n) => n.superseded_by === undefined), "report-only must stamp nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: merge writes consolidates, stamps superseded_by on both sources, doctor stays clean", () => {
  const dir = tmpdir("brain-dream-apply-");
  try {
    const { a, b } = seedMergePair(dir);
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("applied: 1 change(s)"), r.stdout);
    const brain = loadBrain(dir);
    const merged = brain.notes.find((n) => n.consolidates !== undefined)!;
    assert.ok(merged, "the merged note must exist");
    assert.deepEqual(merged.consolidates, [a.id, b.id]);
    assert.deepEqual(merged.author, { human: "dreamtester", agent: "dream" }, "dream notes are authored by the brain owner via the dream agent");
    assert.equal(brain.byId.get(a.id)!.superseded_by, merged.id);
    assert.equal(brain.byId.get(b.id)!.superseded_by, merged.id);
    assert.deepEqual(activeNotes(brain).map((n) => n.id), [merged.id]);
    assert.deepEqual(diagnose(dir), [], "an applied dream must leave the brain valid");
    assert.ok(findDreamReport(dir).includes("merged 2 notes"), "the report must record the application");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream: refuter garbage means refuter: absent and ZERO applications, even with --apply", () => {
  const dir = tmpdir("brain-dream-garbage-");
  try {
    const { a, b } = seedMergePair(dir);
    const before = fs.readdirSync(dir).sort();
    const r = runCli(["dream", "--apply", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}`, FAKE_CLAUDE_MODE: "refuter-garbage" }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("refuter: absent"), r.stdout);
    assert.ok(r.stdout.includes("applied: nothing"), r.stdout);
    const report = findDreamReport(dir);
    assert.ok(report.includes("refuter: absent"), "the mandatory line must say the reviewer never showed");
    assert.ok(!report.includes("refuter: ran"), "an unreviewed dream must never read as reviewed");
    assert.ok(report.includes("unreviewed dreams are never applied"), report);
    assert.deepEqual(fs.readdirSync(dir).sort().filter((f) => f !== "dreams"), before, "no note files may change");
    assert.ok(loadBrain(dir).notes.every((n) => n.superseded_by === undefined), "nothing may be stamped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream: proposer garbage is a graceful empty dream with an honest report", () => {
  const dir = tmpdir("brain-dream-pgarbage-");
  try {
    seedMergePair(dir);
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_CLAUDE_MODE: "proposer-garbage" }) });
    assert.equal(r.status, 0, r.stderr);
    const report = findDreamReport(dir);
    assert.ok(report.includes("empty dream"), report);
    assert.ok(report.includes("refuter: absent"), "with nothing to review the refuter is honestly reported absent");
    assert.ok(report.includes("not consulted"), "the report must distinguish not-consulted from failed");
    assert.equal(loadBrain(dir).notes.length, 2, "an empty dream writes nothing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: refuter rejections and missing verdicts (default reject) gate what is applied", () => {
  const dir = tmpdir("brain-dream-rejects-");
  try {
    const author = { human: "diego", agent: null };
    const { a, b } = seedMergePair(dir);
    const gotcha = createNote(dir, { type: "gotcha", title: "Unpinned node broke the build", body: "It broke twice.", author: { human: "diego", agent: "codex" } });
    creditNotes(dir, [gotcha.id]);
    creditNotes(dir, [gotcha.id]);
    const c1 = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "ship it", author });
    const c2 = createNote(dir, { type: "decision", title: "Never deploy on Fridays", body: "outage settled it", author });
    const retitleTarget = createNote(dir, { type: "note", title: "Cache paths", body: "where caches live", author });
    const r = runCli(["dream", "--apply", "--dir", dir], {
      env: dreamEnv({
        FAKE_CLAUDE_MODE: "refuter-rejects-some",
        FAKE_MERGE_IDS: `${a.id},${b.id}`,
        FAKE_PROMOTE_ID: gotcha.id,
        FAKE_CONTRA_IDS: `${c1.id},${c2.id}`,
        FAKE_RETITLE_ID: retitleTarget.id,
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    const report = findDreamReport(dir);
    assert.ok(report.includes("refuter: ran"), report);
    assert.ok(report.includes("proposal 0: keep"), report);
    assert.ok(report.includes("proposal 1: reject"), report);
    assert.ok(report.includes("rejected by default"), "a missing verdict must be reported as a default reject");
    assert.ok(report.includes("(defaulted)"), report);
    const brain = loadBrain(dir);
    assert.ok(brain.notes.some((n) => n.consolidates !== undefined), "the kept merge must be applied");
    assert.equal(brain.byId.get(gotcha.id)!.superseded_by, undefined, "the rejected promotion must not be applied");
    assert.ok(!brain.notes.some((n) => n.type === "open_thread"), "the default-rejected contradiction must not be filed");
    assert.equal(brain.byId.get(retitleTarget.id)!.superseded_by, undefined, "the default-rejected retitle must not be applied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: contradiction files an open_thread authored by dream, capped as a bare agent claim", () => {
  const dir = tmpdir("brain-dream-contra-");
  try {
    const author = { human: "diego", agent: null };
    const c1 = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "ship it", author });
    const c2 = createNote(dir, { type: "decision", title: "Never deploy on Fridays", body: "outage settled it", author });
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_CONTRA_IDS: `${c1.id},${c2.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    const brain = loadBrain(dir);
    const thread = brain.notes.find((n) => n.type === "open_thread")!;
    assert.ok(thread, "the contradiction must be filed as an open_thread note");
    assert.ok(thread.title.startsWith("Contradiction:"), thread.title);
    assert.deepEqual(thread.author, { human: "dreamtester", agent: "dream" });
    assert.equal(capFor(thread), 0.6, "dream output is a bare agent claim: it starts at low trust by design");
    assert.equal(tierFor(confidenceFor(thread), thread.credits), "verify");
    assert.ok(thread.body.includes(c1.id) && thread.body.includes(c2.id), "the thread must name both notes");
    assert.equal(brain.byId.get(c1.id)!.superseded_by, undefined, "flagging must not supersede either side");
    assert.deepEqual(diagnose(dir), [], "the filed thread's wikilinks must resolve");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply is undoable: only new files plus superseded_by stamps, bodies never touched", () => {
  const dir = tmpdir("brain-dream-undo-");
  try {
    const author = { human: "diego", agent: null };
    const { a, b } = seedMergePair(dir);
    const gotcha = createNote(dir, { type: "gotcha", title: "Unpinned node broke the build", body: "It broke twice.", author: { human: "diego", agent: "codex" } });
    creditNotes(dir, [gotcha.id]);
    creditNotes(dir, [gotcha.id]);
    const retitleTarget = createNote(dir, { type: "note", title: "Cache paths", body: "where caches live", author });
    const before = new Map<string, Note>();
    for (const n of loadBrain(dir).notes) before.set(n.file, n);
    const r = runCli(["dream", "--apply", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}`, FAKE_PROMOTE_ID: gotcha.id, FAKE_RETITLE_ID: retitleTarget.id }),
    });
    assert.equal(r.status, 0, r.stderr);
    const after = loadBrain(dir);
    for (const [file, old] of before) {
      const now = after.notes.find((n) => n.file === file)!;
      assert.ok(now, `preexisting file must survive: ${file}`);
      const { superseded_by: _s1, file: _f1, ...oldRest } = old;
      const { superseded_by: _s2, file: _f2, ...nowRest } = now;
      assert.deepEqual(nowRest, oldRest, `only superseded_by may change on ${path.basename(file)}`);
    }
    assert.ok(after.notes.length > before.size, "applications must arrive as new files");
    assert.deepEqual(diagnose(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream: --model reaches claude -p, and the proposer/refuter token ceilings are 8000/4000", () => {
  const dir = tmpdir("brain-dream-model-");
  try {
    const { a, b } = seedMergePair(dir);
    const log = path.join(dir, "..", `fake-claude-log-${path.basename(dir)}.jsonl`);
    const r = runCli(["dream", "--model", "claude-test-model", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}`, FAKE_CLAUDE_LOG: log }),
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    fs.rmSync(log, { force: true });
    assert.deepEqual(calls.map((c) => c.role), ["proposer", "refuter"], "exactly two calls: propose, then refute");
    for (const c of calls) {
      assert.deepEqual(c.args, ["-p", "--model", "claude-test-model"], "the model id must ride claude -p --model");
    }
    assert.equal(calls[0].maxTokens, "8000", "proposer output ceiling");
    assert.equal(calls[1].maxTokens, "4000", "refuter output ceiling");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: source frontmatter field ----

check("source field: serialize/parse round-trip, including URL values that need quoting", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "gotcha",
    title: "Sourced via frontmatter",
    author: { human: "diego", agent: "codex" },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    source: "https://example.com/spec#section-3",
    credits: 0,
    last_credited: null,
    body: "a body with no citation of its own",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  const { file: _f, ...roundTripped } = parsed.note!;
  assert.deepEqual(roundTripped, note);
});

check("source field: earns the 0.85 sourced-agent cap; the body heuristic still works; human cap unchanged", () => {
  const viaField = fakeNote({ author: { human: "d", agent: "codex" }, source: "docs/spec.md", body: "no citation in the body" });
  assert.equal(capFor(viaField), 0.85, "the formal source field must trigger the sourced cap");
  assert.equal(confidenceFor(viaField, NOW), 0.75);
  const viaBody = fakeNote({ author: { human: "d", agent: "codex" }, body: "source: docs/spec.md" });
  assert.equal(capFor(viaBody), 0.85, "the body heuristic must keep working (backward compatible)");
  const bare = fakeNote({ author: { human: "d", agent: "codex" } });
  assert.equal(capFor(bare), 0.6);
  const human = fakeNote({ source: "docs/spec.md" });
  assert.equal(capFor(human), 0.95, "a human note stays at the human cap with or without a source");
});

check("source field: createNote trims it, omits it when blank, and doctor flags a blank source on disk", () => {
  const dir = tmpdir("brain-source-");
  try {
    const author = { human: "diego", agent: "codex" };
    const sourced = createNote(dir, { type: "note", title: "Sourced", body: "x", source: "  RFC 9110  ", author });
    assert.equal(sourced.source, "RFC 9110");
    assert.ok(fs.readFileSync(sourced.file, "utf8").includes("source: RFC 9110"), "source must land in frontmatter");
    const blank = createNote(dir, { type: "note", title: "Blank source", body: "y", source: "   ", author });
    assert.equal(blank.source, undefined, "a blank source is omitted, not written");
    assert.ok(!fs.readFileSync(blank.file, "utf8").includes("source:"), "no source line for a blank source");
    assert.deepEqual(diagnose(dir), []);
    // a hand-edited file with an empty source: line is a doctor problem
    const bad = serializeNote({
      id: ulid(),
      type: "note",
      title: "Hand-edited",
      author,
      created: "2026-08-18T10:00:00.000Z",
      supersedes: null,
      credits: 0,
      last_credited: null,
      body: "z",
    }).replace("supersedes: null", "supersedes: null\nsource:");
    fs.writeFileSync(path.join(dir, "hand-edited.md"), bad);
    const messages = diagnose(dir).map((p) => p.message).join("\n");
    assert.ok(/source must be a non-empty string/.test(messages), messages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: abandon_task ----

check("abandonTask: claimed goes back to open with claimed_by cleared and the reason stamped on disk", () => {
  const dir = tmpdir("brain-abandon-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const task = assignTask(dir, { title: "Tough one", instructions: "needs prod access", author });
    claimTask(dir, task.id, "codex");
    const back = abandonTask(dir, task.id, "No prod credentials; needs a human or an agent with access.", "CODEX");
    assert.equal(back.status, "open");
    assert.equal(back.claimed_by, null);
    assert.equal(back.abandon_reason, "No prod credentials; needs a human or an agent with access.");
    const reread = parseNoteFile(task.file, fs.readFileSync(task.file, "utf8")).note!;
    assert.equal(reread.status, "open");
    assert.equal(reread.claimed_by, null);
    assert.equal(reread.abandon_reason, "No prod credentials; needs a human or an agent with access.");
    assert.equal(reread.body, "needs prod access", "abandoning must never touch the instructions");
    assert.deepEqual(diagnose(dir), [], "an abandoned task must validate clean");
    // the abandoned task is claimable again, and the next claim clears the reason
    const reclaimed = claimTask(dir, task.id, "gemini");
    assert.equal(reclaimed.status, "claimed");
    assert.equal(reclaimed.abandon_reason, undefined);
    const rereadClaimed = parseNoteFile(task.file, fs.readFileSync(task.file, "utf8")).note!;
    assert.equal(rereadClaimed.abandon_reason, undefined, "the next claim must clear abandon_reason on disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("abandonTask: refuses open tasks, done tasks, the wrong agent, and empty reasons", () => {
  const dir = tmpdir("brain-abandon2-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const open = assignTask(dir, { title: "Still open", instructions: "x", author });
    assert.throws(() => abandonTask(dir, open.id, "reason", "codex"), /not claimed/);
    claimTask(dir, open.id, "codex");
    assert.throws(() => abandonTask(dir, open.id, "reason", "gemini"), /claimed by codex, not gemini/);
    assert.throws(() => abandonTask(dir, open.id, "   ", "codex"), /requires a reason/);
    assert.throws(() => abandonTask(dir, open.id, "reason", "  "), /agent's label/);
    completeTask(dir, open.id, "done after all", "codex");
    assert.throws(() => abandonTask(dir, open.id, "reason", "codex"), /already done/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli tasks: an abandoned task shows its reason", () => {
  const dir = tmpdir("brain-cli-abandon-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const task = assignTask(dir, { title: "Bounced work", instructions: "x", author });
    claimTask(dir, task.id, "codex");
    abandonTask(dir, task.id, "Blocked on missing API key", "codex");
    const r = runCli(["tasks", "--dir", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("open"), r.stdout);
    assert.ok(r.stdout.includes("abandoned earlier: Blocked on missing API key"), r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: conventions helper ----

check("activeConventions: only active convention-type notes, superseded ones excluded", () => {
  const dir = tmpdir("brain-conv-");
  try {
    const author = { human: "diego", agent: null };
    const keep = createNote(dir, { type: "convention", title: "Two-space indent", body: "The linter says so.", author });
    const old = createNote(dir, { type: "convention", title: "Old rule", body: "was true once", author });
    createNote(dir, { type: "note", title: "Not a convention", body: "just a note", author });
    supersedeNote(dir, old.id, { type: "convention", title: "New rule", body: "is true now", author });
    const titles = activeConventions(loadBrain(dir)).map((n) => n.title).sort();
    assert.deepEqual(titles, ["New rule", "Two-space indent"], "superseded conventions and non-conventions must not ride");
    assert.equal(activeConventions(loadBrain(dir)).find((n) => n.id === keep.id)!.body, "The linter says so.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: brain lock ----

check("lock: acquire/release round-trip; fresh foreign locks block, stale ones are overridden with a flag", () => {
  const dir = tmpdir("brain-lock-");
  try {
    assert.equal(activeLock(dir), null, "no lock file means no lock");
    const first = acquireLock(dir, NOW);
    assert.equal(first.overrodeStale, false);
    assert.ok(fs.existsSync(lockPath(dir)), "the lock file must exist while held");
    assert.equal(activeLock(dir, NOW)!.pid, process.pid);
    // own pid may re-acquire (same process, no deadlock)
    assert.equal(acquireLock(dir, NOW).overrodeStale, false);
    releaseLock(dir);
    assert.ok(!fs.existsSync(lockPath(dir)), "release must remove the lock file");
    // a fresh lock held by another pid refuses
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date(NOW).toISOString() }));
    assert.throws(() => acquireLock(dir, NOW + 1000), /locked by another apply/);
    // the same lock, 10 minutes later, is stale: acquire succeeds and reports the override
    const overridden = acquireLock(dir, NOW + LOCK_STALE_MS);
    assert.equal(overridden.overrodeStale, true, "a stale lock must be overridden, with the override reported");
    releaseLock(dir);
    // garbage lock files never block
    fs.writeFileSync(lockPath(dir), "not json at all");
    assert.equal(activeLock(dir, NOW), null);
    assert.doesNotThrow(() => assertNotLocked(dir, NOW));
    releaseLock(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("lock: assertNotLocked blocks writes only during a fresh foreign lock; stale and own locks never block", () => {
  const dir = tmpdir("brain-lock2-");
  try {
    assert.doesNotThrow(() => assertNotLocked(dir, NOW), "no lock, no block");
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date(NOW).toISOString() }));
    assert.throws(() => assertNotLocked(dir, NOW + 1000), /temporarily locked/);
    assert.doesNotThrow(() => assertNotLocked(dir, NOW + LOCK_STALE_MS), "a stale lock must not block writes");
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, timestamp: new Date(NOW).toISOString() }));
    assert.doesNotThrow(() => assertNotLocked(dir, NOW + 1000), "our own lock must not block us");
    // the lock file never becomes a note and never bothers doctor
    createNote(dir, { type: "note", title: "Real note", body: "x", author: { human: "d", agent: null } });
    assert.equal(loadBrain(dir).notes.length, 1);
    assert.deepEqual(diagnose(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: a fresh foreign lock means nothing is applied and the report says why", () => {
  const dir = tmpdir("brain-dream-lock-");
  try {
    const { a, b } = seedMergePair(dir);
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date().toISOString() }));
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("could not take the brain lock"), r.stdout);
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2, "no notes may be written while another apply holds the lock");
    assert.ok(brain.notes.every((n) => n.superseded_by === undefined), "nothing may be stamped");
    assert.ok(findDreamReport(dir).includes("could not take the brain lock"), "the report must record the lock refusal");
    assert.ok(fs.existsSync(lockPath(dir)), "the foreign lock must not be deleted by the refused apply");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: a stale lock is overridden with a warning, the apply proceeds, and the lock is released", () => {
  const dir = tmpdir("brain-dream-stale-");
  try {
    const { a, b } = seedMergePair(dir);
    const staleStamp = new Date(Date.now() - LOCK_STALE_MS - 60_000).toISOString();
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: staleStamp }));
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("overrode a stale brain lock"), r.stdout);
    assert.ok(r.stdout.includes("applied: 1 change(s)"), r.stdout);
    assert.ok(loadBrain(dir).notes.some((n) => n.consolidates !== undefined), "the apply must proceed past a stale lock");
    assert.ok(!fs.existsSync(lockPath(dir)), "the lock must be released after the apply");
    assert.ok(findDreamReport(dir).includes("overrode a stale brain lock"), "the report must record the override");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: dream --json ----

check("cli dream --json: machine-readable report on stdout, markdown report still written", () => {
  const dir = tmpdir("brain-dream-json-");
  try {
    const { a, b } = seedMergePair(dir);
    const r = runCli(["dream", "--json", "--dir", dir], { env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.mode, "report-only");
    assert.equal(payload.brain, dir);
    assert.equal(payload.active_notes, 2);
    assert.equal(payload.refuter_ran, true);
    assert.equal(payload.proposals.length, 1);
    assert.equal(payload.proposals[0].op, "merge");
    assert.equal(payload.verdicts.length, 1);
    assert.equal(payload.verdicts[0].verdict, "keep");
    assert.equal(payload.kept, 1);
    assert.deepEqual(payload.applied, [], "report-only json must show nothing applied");
    assert.deepEqual(payload.skipped_review, []);
    assert.equal(payload.commit, null, "no --commit means commit: null");
    assert.ok(fs.existsSync(payload.report_file), "the markdown report file must still be written");
    assert.ok(findDreamReport(dir).includes("# Dream report"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: dream --commit ----

const GIT_TEST_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "braintest",
  GIT_AUTHOR_EMAIL: "braintest@example.com",
  GIT_COMMITTER_NAME: "braintest",
  GIT_COMMITTER_EMAIL: "braintest@example.com",
};

function gitIn(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_TEST_ENV }, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

check("cli dream --commit: commits ONLY brain paths after apply; a dirty repo elsewhere is untouched", () => {
  const repo = tmpdir("brain-commit-repo-");
  try {
    gitIn(repo, ["init", "-q"]);
    fs.writeFileSync(path.join(repo, "README.md"), "a project\n");
    gitIn(repo, ["add", "README.md"]);
    gitIn(repo, ["commit", "-q", "-m", "initial"]);
    const dir = path.join(repo, "brain");
    fs.mkdirSync(dir);
    const { a, b } = seedMergePair(dir);
    // dirt outside the brain dir: must never ride the dream commit
    fs.writeFileSync(path.join(repo, "untracked-scratch.txt"), "dirty\n");
    fs.appendFileSync(path.join(repo, "README.md"), "modified\n");
    const r = runCli(["dream", "--apply", "--commit", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}`, ...GIT_TEST_ENV }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("applied: 1 change(s)"), r.stdout);
    assert.ok(r.stdout.includes('commit: committed the brain directory'), r.stdout);
    const subject = gitIn(repo, ["log", "-1", "--format=%s"]).trim();
    assert.match(subject, /^dream: \d{4}-\d{2}-\d{2} applied 1 proposals$/);
    const files = gitIn(repo, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n").filter(Boolean);
    assert.ok(files.length > 0, "the commit must contain files");
    assert.ok(files.every((f) => f.startsWith("brain/")), `only brain paths may be committed, got: ${files.join(", ")}`);
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.ok(status.includes("untracked-scratch.txt"), "untracked dirt outside the brain must survive uncommitted");
    assert.ok(status.includes("README.md"), "modified files outside the brain must survive uncommitted");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

check("cli dream --commit: refuses without --apply; outside a git repo it is a polite no-op", () => {
  const dir = tmpdir("brain-commit-norepo-");
  try {
    const { a, b } = seedMergePair(dir);
    const bad = runCli(["dream", "--commit", "--dir", dir], { env: dreamEnv({}) });
    assert.equal(bad.status, 2, "commit without apply must fail with guidance");
    assert.ok(bad.stderr.includes("--commit requires --apply"), bad.stderr);
    const r = runCli(["dream", "--apply", "--commit", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${a.id},${b.id}`, ...GIT_TEST_ENV }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("applied: 1 change(s)"), r.stdout);
    assert.ok(r.stdout.includes("not committed: the brain directory is not inside a git repository"), r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: contradiction dedupe ----

check("cli dream --apply: a contradiction already covered by an active open_thread is not filed twice", () => {
  const dir = tmpdir("brain-dream-dedupe-");
  try {
    const author = { human: "diego", agent: null };
    const c1 = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "ship it", author });
    const c2 = createNote(dir, { type: "decision", title: "Never deploy on Fridays", body: "outage settled it", author });
    const existing = createNote(dir, {
      type: "open_thread",
      title: "Which Friday rule holds?",
      body: `Earlier flag: decide between ${c1.id} and ${c2.id}.`,
      author,
    });
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_CONTRA_IDS: `${c1.id},${c2.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("skipped filing contradiction"), r.stdout);
    const threads = loadBrain(dir).notes.filter((n) => n.type === "open_thread");
    assert.deepEqual(threads.map((t) => t.id), [existing.id], "no second open_thread may be filed for the same pair");
    assert.ok(findDreamReport(dir).includes("already references both notes"), "the report must record the dedupe");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: a superseded open_thread does NOT suppress a fresh contradiction flag", () => {
  const dir = tmpdir("brain-dream-dedupe2-");
  try {
    const author = { human: "diego", agent: null };
    const c1 = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "ship it", author });
    const c2 = createNote(dir, { type: "decision", title: "Never deploy on Fridays", body: "outage settled it", author });
    const old = createNote(dir, { type: "open_thread", title: "Old flag", body: `about ${c1.id} and ${c2.id}`, author });
    supersedeNote(dir, old.id, { type: "note", title: "Resolved once", body: "was settled, then diverged again", author });
    const r = runCli(["dream", "--apply", "--dir", dir], { env: dreamEnv({ FAKE_CONTRA_IDS: `${c1.id},${c2.id}` }) });
    assert.equal(r.status, 0, r.stderr);
    const threads = activeNotes(loadBrain(dir)).filter((n) => n.type === "open_thread");
    assert.equal(threads.length, 1, "an inactive open_thread must not block a fresh flag");
    assert.ok(threads[0].title.startsWith("Contradiction:"), threads[0].title);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.4: refuter prompt size guard ----

check("planReview: everything fits under the cap by default; oversized proposals are dropped largest-first", () => {
  const dir = tmpdir("brain-plan-");
  try {
    const author = { human: "diego", agent: null };
    const small1 = createNote(dir, { type: "note", title: "Small A", body: "tiny", author });
    const small2 = createNote(dir, { type: "note", title: "Small B", body: "also tiny", author });
    const big1 = createNote(dir, { type: "note", title: "Big A", body: "x".repeat(15_000), author });
    const big2 = createNote(dir, { type: "note", title: "Big B", body: "y".repeat(15_000), author });
    const brain = loadBrain(dir);
    const smallMerge: Proposal = { op: "merge", source_ids: [small1.id, small2.id], type: "note", title: "Merged small", body: "b", rationale: "r" };
    const bigMerge: Proposal = { op: "merge", source_ids: [big1.id, big2.id], type: "note", title: "Merged big", body: "b", rationale: "r" };
    assert.deepEqual(planReview([smallMerge], brain), { reviewed: [0], skipped: [] }, "small proposals all fit");
    assert.deepEqual(planReview([bigMerge, smallMerge], brain), { reviewed: [1], skipped: [0] }, "the largest proposal is dropped first");
    assert.deepEqual(planReview([smallMerge, bigMerge], brain), { reviewed: [0], skipped: [1] }, "index order does not matter, size does");
    assert.deepEqual(planReview([bigMerge], brain), { reviewed: [], skipped: [0] }, "a single oversized proposal leaves nothing to review");
    assert.deepEqual(planReview([], brain), { reviewed: [], skipped: [] });
    assert.ok(REFUTER_PROMPT_CHAR_CAP === 24_000, "the documented cap");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli dream --apply: an oversized proposal is recorded as not reviewed and never applied; the rest still are", () => {
  const dir = tmpdir("brain-dream-size-");
  try {
    const author = { human: "diego", agent: null };
    const big1 = createNote(dir, { type: "note", title: "Huge dossier A", body: "a".repeat(15_000), author });
    const big2 = createNote(dir, { type: "note", title: "Huge dossier B", body: "b".repeat(15_000), author });
    const c1 = createNote(dir, { type: "decision", title: "Deploy on Fridays", body: "ship it", author });
    const c2 = createNote(dir, { type: "decision", title: "Never deploy on Fridays", body: "outage settled it", author });
    const r = runCli(["dream", "--apply", "--dir", dir], {
      env: dreamEnv({ FAKE_MERGE_IDS: `${big1.id},${big2.id}`, FAKE_CONTRA_IDS: `${c1.id},${c2.id}` }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("not reviewed (too large for the refuter prompt cap): proposal 0"), r.stdout);
    const report = findDreamReport(dir);
    assert.ok(report.includes("refuter: ran"), "the refuter still reviews what fits");
    assert.ok(report.includes("dropped from review by the prompt size cap"), report);
    assert.ok(report.includes("not reviewed: too large"), report);
    const brain = loadBrain(dir);
    assert.equal(brain.byId.get(big1.id)!.superseded_by, undefined, "the unreviewed merge must NOT be applied");
    assert.equal(brain.byId.get(big2.id)!.superseded_by, undefined);
    assert.ok(brain.notes.some((n) => n.type === "open_thread"), "the reviewed contradiction must still be applied");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

fs.rmSync(shimDir, { recursive: true, force: true });

/**
 * v0.4 MCP features over real stdio: conventions riding recall, the source
 * field, abandon_task, and the brain lock respected by write tools only.
 */
async function mcpV4FeatureTest(): Promise<void> {
  const dir = tmpdir("brain-mcp-v4-");
  const client = spawnServer(dir, { BRAIN_HUMAN: "diego" });
  const call = async (name: string, args: unknown) => {
    const res = await client.request("tools/call", { name, arguments: args });
    const isError = res.isError === true;
    return { payload: isError ? null : JSON.parse(res.content[0].text), isError, raw: res };
  };
  try {
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "brain-test", version: "0.0.0" },
    });
    client.notify("notifications/initialized");

    let conventionId = "";
    await checkAsync("mcp v4: conventions ride EVERY recall verbatim, even when the query matches nothing", async () => {
      const conv = await call("remember", {
        type: "convention",
        title: "No em dashes in copy",
        body: "Restructure the sentence instead.",
        agent_label: "claude-code",
      });
      conventionId = conv.payload.id;
      await call("remember", { type: "note", title: "Unrelated fact", body: "the sky is up", agent_label: "claude-code" });
      const res = await call("recall", { query: "zzqxv-matches-nothing" });
      assert.equal(res.payload.count, 0, "the query matches no notes");
      assert.deepEqual(
        res.payload.conventions,
        [{ id: conventionId, title: "No em dashes in copy", body: "Restructure the sentence instead." }],
        "conventions must ride verbatim regardless of the query",
      );
    });

    await checkAsync("mcp v4: a superseded convention stops riding recall (negative)", async () => {
      const replaced = await call("supersede", {
        old_id: conventionId,
        type: "convention",
        title: "No em dashes in copy",
        body: "Restructure the sentence instead. Semicolons are fine.",
        agent_label: "claude-code",
      });
      const res = await call("recall", { query: "zzqxv-matches-nothing" });
      assert.equal(res.payload.conventions.length, 1, "exactly one active convention may ride");
      assert.equal(res.payload.conventions[0].id, replaced.payload.note.id);
      assert.ok(res.payload.conventions[0].body.includes("Semicolons"), "the successor rides, not the superseded original");
    });

    let sourcedId = "";
    await checkAsync("mcp v4: remember with the source field earns the sourced cap without a body citation", async () => {
      const res = await call("remember", {
        type: "gotcha",
        title: "Registry mirrors lag by a day",
        body: "Fresh publishes 404 on the mirror for up to 24 hours.",
        source: "https://example.com/registry-docs",
        agent_label: "codex",
      });
      sourcedId = res.payload.id;
      // fmScalar quotes values containing a colon, so the URL lands quoted
      assert.ok(fs.readFileSync(res.payload.file, "utf8").includes('source: "https://example.com/registry-docs"'));
      const recalled = await call("recall", { query: "Registry mirrors" });
      assert.equal(recalled.payload.notes[0].confidence, 0.75, "source field: 0.85 cap - 0.10 fresh, not the bare 0.50");
      assert.equal(recalled.payload.notes[0].tier, "standing");
    });

    await checkAsync("mcp v4: abandon_task returns a claimed task to open with the reason on the record", async () => {
      const t = await call("assign_task", { title: "Needs prod access", instructions: "rotate the key", agent_label: "claude-code" });
      const taskId = t.payload.task.id;
      await call("claim_task", { id: taskId, agent_label: "codex" });
      const wrong = await call("abandon_task", { id: taskId, reason: "hijack attempt", agent_label: "gemini" });
      assert.equal(wrong.isError, true, "only the claimer may abandon");
      assert.ok(wrong.raw.content[0].text.includes("only the claimer"), wrong.raw.content[0].text);
      const back = await call("abandon_task", { id: taskId, reason: "No prod credentials on this machine.", agent_label: "codex" });
      assert.equal(back.payload.task.status, "open");
      assert.equal(back.payload.task.claimed_by, null);
      assert.equal(back.payload.task.abandon_reason, "No prod credentials on this machine.");
      const listed = await call("list_tasks", { filter: "open", agent_label: "gemini" });
      assert.equal(listed.payload.tasks[0].abandon_reason, "No prod credentials on this machine.", "the reason must be visible to the next agent");
      const reclaim = await call("claim_task", { id: taskId, agent_label: "gemini" });
      assert.equal(reclaim.payload.task.abandon_reason, null, "the next claim clears the reason");
    });

    await checkAsync("mcp v4: a fresh foreign lock blocks writes but never reads; a stale lock blocks nothing", async () => {
      fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date().toISOString() }));
      const blockedWrite = await call("remember", { type: "note", title: "During lock", body: "x", agent_label: "codex" });
      assert.equal(blockedWrite.isError, true, "remember must refuse during an active apply");
      assert.ok(blockedWrite.raw.content[0].text.includes("temporarily locked"), blockedWrite.raw.content[0].text);
      const blockedCredit = await call("credit", { ids: [sourcedId] });
      assert.equal(blockedCredit.isError, true, "credit must refuse during an active apply");
      const read = await call("recall", { query: "Registry mirrors" });
      assert.equal(read.isError, false, "reads never block on the lock");
      assert.equal(read.payload.count, 1);
      const searchRead = await call("search", { query: "registry" });
      assert.equal(searchRead.isError, false, "search never blocks on the lock");
      // stale lock: writes flow again
      fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString() }));
      const afterStale = await call("remember", { type: "note", title: "After stale lock", body: "y", agent_label: "codex" });
      assert.equal(afterStale.isError, false, "a stale lock must not block writes");
      fs.rmSync(lockPath(dir), { force: true });
    });
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await mcpV4FeatureTest();

// ---- v0.5: harvest ----

/** Harvest fixtures live against the real clock: the CLI path has no injectable now. */
const HNOW = Date.now();
const hIso = (daysOld: number, minutes = 0) => new Date(HNOW - daysOld * DAY + minutes * 60_000).toISOString();

function writeJsonl(file: string, entries: unknown[], extraRawLines: string[] = []): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...entries.map((e) => JSON.stringify(e)), ...extraRawLines].join("\n") + "\n");
}

/**
 * A fabricated transcript tree in the real ~/.claude/projects shape:
 * encoded project dirs, top-level <sessionId>.jsonl files, one subagents/
 * transcript that harvest must skip, tool-noise entries to skip, a malformed
 * line, and one session outside the day window.
 */
function makeSessionsRoot(): string {
  const root = tmpdir("brain-sessions-");
  const app = path.join(root, "-Users-diego-Desktop-cookbook-app");
  const cwdApp = "/Users/diego/Desktop/cookbook-app";
  writeJsonl(
    path.join(app, "sess-aaaa-1111.jsonl"),
    [
      { type: "user", timestamp: hIso(1, 0), cwd: cwdApp, sessionId: "sess-aaaa-1111", message: { role: "user", content: "Switch the poll interval to 30 seconds because free tiers rate limit below that." } },
      { type: "user", timestamp: hIso(1, 1), cwd: cwdApp, isMeta: true, message: { role: "user", content: "META_NOISE_MUST_NOT_APPEAR in any digest" } },
      { type: "user", timestamp: hIso(1, 2), cwd: cwdApp, message: { role: "user", content: "<command-name>/clear</command-name>" } },
      { type: "user", timestamp: hIso(1, 3), cwd: cwdApp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "TOOL_RESULT_NOISE_MUST_NOT_APPEAR" }] } },
      { type: "assistant", timestamp: hIso(1, 4), cwd: cwdApp, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo TOOL_USE_NOISE_MUST_NOT_APPEAR" } }] } },
      { type: "assistant", timestamp: hIso(1, 5), cwd: cwdApp, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "assistant", timestamp: hIso(1, 6), cwd: cwdApp, message: { role: "assistant", content: [{ type: "text", text: "Done: the poll interval is 30 seconds everywhere, and no free tier target rate limited at that cadence in testing." }] } },
      { type: "user", timestamp: hIso(1, 7), cwd: cwdApp, message: { role: "user", content: [{ type: "text", text: "Great. And remember we never deploy on Fridays after that outage." }] } },
      { type: "summary", summary: "summaries are not conversation" },
    ],
    ["{this line is not json"],
  );
  // subagent transcript: agent-to-agent traffic, must be skipped entirely
  writeJsonl(path.join(app, "sess-aaaa-1111", "subagents", "agent-1.jsonl"), [
    { type: "user", timestamp: hIso(1, 8), cwd: cwdApp, message: { role: "user", content: "SUBAGENT_PROMPT_MUST_NOT_APPEAR: these user messages are agent-written" } },
    { type: "assistant", timestamp: hIso(1, 9), cwd: cwdApp, message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_CONCLUSION_MUST_NOT_APPEAR even though it is over one hundred characters long, because subagents are not the human." }] } },
  ]);
  const other = path.join(root, "-Users-diego-Desktop-other-proj");
  const cwdOther = "/Users/diego/Desktop/other-proj";
  writeJsonl(path.join(other, "sess-bbbb-2222.jsonl"), [
    { type: "user", timestamp: hIso(2, 0), cwd: cwdOther, message: { role: "user", content: "In other-proj the staging DB resets nightly at 02:00 UTC, so do not debug missing rows at 02:05." } },
    { type: "assistant", timestamp: hIso(2, 1), cwd: cwdOther, message: { role: "assistant", content: [{ type: "text", text: "Understood: the staging database resets nightly at 02:00 UTC, so rows missing right after that window are expected rather than a bug." }] } },
  ]);
  // outside the 7-day window by MESSAGE timestamp (mtime is fresh, so the per-message window must catch it)
  writeJsonl(path.join(other, "sess-old-3333.jsonl"), [
    { type: "user", timestamp: hIso(30, 0), cwd: cwdOther, message: { role: "user", content: "OLD_SESSION_MUST_NOT_APPEAR because it is outside the window." } },
  ]);
  // one of the tool's own claude -p runs: first user message is our prompt, marker first line
  const brainDir = path.join(root, "-Users-diego-Desktop-cookbook-brain");
  const cwdBrain = "/Users/diego/Desktop/cookbook-brain";
  writeJsonl(path.join(brainDir, "sess-int-4444.jsonl"), [
    { type: "queue-operation", timestamp: hIso(0, -20) },
    { type: "user", timestamp: hIso(0, -19), cwd: cwdBrain, message: { role: "user", content: `${INTERNAL_RUN_MARKER}\nYou are the HARVESTER in a memory bootstrap pass.\nINTERNAL_RUN_MUST_NOT_APPEAR in any digest.` } },
    { type: "assistant", timestamp: hIso(0, -18), cwd: cwdBrain, message: { role: "assistant", content: [{ type: "text", text: 'INTERNAL_RUN_MUST_NOT_APPEAR: {"proposals": []} padded well past one hundred characters so it would otherwise count as a conclusion.' }] } },
  ]);
  // a genuinely old file: old messages AND old mtime, so the cheap pre-filter skips it before parsing
  const ancient = path.join(other, "sess-ancient-5555.jsonl");
  writeJsonl(ancient, [
    { type: "user", timestamp: hIso(45, 0), cwd: cwdOther, message: { role: "user", content: "ANCIENT_FILE_MUST_NOT_APPEAR because both its mtime and its messages predate the window." } },
  ]);
  fs.utimesSync(ancient, new Date(HNOW - 45 * DAY), new Date(HNOW - 45 * DAY));
  return root;
}

check("harvest scan: reads content, skips tool noise, meta, subagents, summaries, malformed lines, and old sessions", () => {
  const root = makeSessionsRoot();
  try {
    const scan = scanSessions(root, { now: HNOW, days: 7 });
    const sessions = scan.sessions;
    assert.deepEqual(sessions.map((s) => s.project), ["other-proj", "cookbook-app"], "chronological order, oldest first, project from cwd basename");
    const app = sessions[1];
    assert.equal(app.sessionId, "sess-aaaa-1111");
    assert.equal(app.date, hIso(1, 7).slice(0, 10), "the session date is its last in-window activity's date");
    assert.equal(app.startDate, hIso(1, 0).slice(0, 10), "the session's start date is its first in-window message's date");
    assert.deepEqual(app.items.map((i) => i.role), ["human", "agent", "human"], "two substantive human messages and one long conclusion survive");
    assert.equal(scan.internalRuns, 1, "the tool's own claude -p run must be skipped and counted");
    assert.equal(scan.noInWindow, 1, "the fresh-mtime file whose messages are all old counts as no-in-window; the ancient-mtime file is pre-filtered and never counted");
    const digest = buildHarvestDigest(sessions);
    assert.deepEqual(digest.dropped, [], "two small sessions fit the budget");
    assert.ok(digest.text.includes("SESSION"), digest.text);
    assert.ok(digest.text.includes("project cookbook-app"), digest.text);
    assert.ok(digest.text.includes("human: Switch the poll interval to 30 seconds"), digest.text);
    assert.ok(digest.text.includes("never deploy on Fridays"), digest.text);
    assert.ok(digest.text.includes("agent: Done: the poll interval is 30 seconds"), digest.text);
    assert.ok(digest.text.includes("staging DB resets nightly"), digest.text);
    for (const banned of ["SUBAGENT", "TOOL_RESULT_NOISE", "TOOL_USE_NOISE", "META_NOISE", "OLD_SESSION", "INTERNAL_RUN", "ANCIENT_FILE", "<command-name>", "summaries are not conversation", "agent: ok"]) {
      assert.ok(!digest.text.includes(banned), `digest must not contain ${banned}`);
    }
    assert.ok(digest.text.indexOf("staging DB") < digest.text.indexOf("poll interval"), "sessions must read oldest first");
    assert.equal(digest.included[1].messages, 3, "the digest info carries the in-window message count");
    assert.equal(digest.included[1].startDate, app.startDate, "the digest info carries the slice's start date");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check("harvest scan: --days narrows the window and --project filters by cwd basename, case-insensitively", () => {
  const root = makeSessionsRoot();
  try {
    const recent = scanSessions(root, { now: HNOW, days: 1 });
    assert.deepEqual(recent.sessions.map((s) => s.project), ["cookbook-app"], "the 2-day-old session must leave a 1-day window");
    const filtered = scanSessions(root, { now: HNOW, days: 7, project: "Cookbook-App" });
    assert.deepEqual(filtered.sessions.map((s) => s.project), ["cookbook-app"], "the project filter matches case-insensitively");
    const other = scanSessions(root, { now: HNOW, days: 7, project: "other-proj" });
    assert.deepEqual(other.sessions.map((s) => s.sessionId), ["sess-bbbb-2222"]);
    assert.deepEqual(scanSessions(root, { now: HNOW, days: 7, project: "no-such-project" }).sessions, []);
    assert.deepEqual(scanSessions(path.join(root, "definitely-missing"), { now: HNOW, days: 7 }).sessions, [], "a missing root scans to empty, never throws");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check("harvest scan: a long-lived session is windowed by MESSAGE timestamp, and old history never reaches the digest", () => {
  const root = tmpdir("brain-longlived-");
  try {
    const proj = path.join(root, "-Users-diego-Desktop-phonestack");
    const cwd = "/Users/diego/Desktop/phonestack";
    // one session file kept alive for months: file mtime is fresh, but most messages predate the window
    writeJsonl(path.join(proj, "sess-long-9999.jsonl"), [
      { type: "user", timestamp: hIso(60, 0), cwd, message: { role: "user", content: "ANCIENT_DECISION_MUST_NOT_APPEAR: back in June we picked SwiftUI over UIKit." } },
      { type: "assistant", timestamp: hIso(60, 1), cwd, message: { role: "assistant", content: [{ type: "text", text: "ANCIENT_CONCLUSION_MUST_NOT_APPEAR even though this conclusion easily clears the one hundred character floor for agent conclusions." }] } },
      { type: "user", timestamp: hIso(5, 0), cwd, message: { role: "user", content: "This week we locked the sonar sampling rate at 48 kilohertz for the wearable." } },
      { type: "user", timestamp: hIso(2, 0), cwd, message: { role: "user", content: "And the revenue track ships before the sonar demo, that ordering is settled." } },
      { type: "assistant", timestamp: hIso(2, 1), cwd, message: { role: "assistant", content: [{ type: "text", text: "Settled then: revenue track first, sonar demo second, and the sampling rate stays at 48 kilohertz for the wearable hardware." }] } },
    ]);
    const scan = scanSessions(root, { now: HNOW, days: 7 });
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.noInWindow, 0, "a session WITH in-window messages is digested, not counted out");
    const s = scan.sessions[0];
    assert.equal(s.items.length, 3, "only the three in-window messages survive");
    assert.equal(s.startDate, hIso(5, 0).slice(0, 10), "attribution starts at the first IN-WINDOW message, not the file's first message");
    assert.equal(s.date, hIso(2, 1).slice(0, 10), "attribution ends at the last in-window message");
    const digest = buildHarvestDigest(scan.sessions);
    assert.ok(digest.text.includes(`SESSION ${sessionDateRange(s)}, project phonestack`), digest.text);
    assert.ok(digest.text.includes(`${s.startDate} to ${s.date}`), "a multi-day slice reads as a range in the header");
    assert.ok(digest.text.includes("sonar sampling rate"), digest.text);
    assert.ok(!digest.text.includes("ANCIENT_DECISION"), "old human messages must NEVER reach the digest");
    assert.ok(!digest.text.includes("ANCIENT_CONCLUSION"), "old agent conclusions must NEVER reach the digest");
    assert.equal(digest.included[0].messages, 3);
    // the range helper itself: single-day slices stay bare
    assert.equal(sessionDateRange({ startDate: "2026-08-18", date: "2026-08-18" }), "2026-08-18");
    assert.equal(sessionDateRange({ startDate: "2026-08-12", date: "2026-08-18" }), "2026-08-12 to 2026-08-18");
    // shrinking the window drops the older half of the slice
    const narrow = scanSessions(root, { now: HNOW, days: 3 }).sessions;
    assert.equal(narrow.length, 1);
    assert.equal(narrow[0].items.length, 2, "a 3-day window keeps only the 2-day-old messages");
    assert.ok(!buildHarvestDigest(narrow).text.includes("sonar sampling rate"), "the 5-day-old message leaves a 3-day window");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check("harvest scan: internal-run detection matches the marker and the legacy prompt preambles, never real work", () => {
  assert.ok(isInternalRunPrompt(`${INTERNAL_RUN_MARKER}\nYou are the HARVESTER in a memory bootstrap pass.`), "the marker is the exact detector");
  assert.ok(isInternalRunPrompt("You are the HARVESTER in a memory bootstrap pass over an agent memory directory called a brain."), "pre-marker harvest proposer transcripts");
  assert.ok(isInternalRunPrompt("You are the REFUTER reviewing memory notes proposed from digests of a developer's recent coding sessions."), "pre-marker harvest refuter transcripts");
  assert.ok(isInternalRunPrompt('You are the PROPOSER in a memory consolidation pass ("dream") over an agent memory directory called a brain.'), "pre-marker dream proposer transcripts");
  assert.ok(isInternalRunPrompt("You are the REFUTER reviewing consolidation proposals made over an agent memory."), "pre-marker dream refuter transcripts");
  assert.ok(!isInternalRunPrompt("You are the best. Help me fix the harvester."), "ordinary praise is not an internal run");
  assert.ok(!isInternalRunPrompt("Fix a correctness bug in the REFUTER prompt."), "talking ABOUT the prompts is not an internal run");
  // every prompt this tool sends must open with the marker, so future transcripts are exactly detectable
  assert.ok(harvestProposerPrompt("d").startsWith(INTERNAL_RUN_MARKER));
  assert.ok(harvestRefuterPrompt([], "d").startsWith(INTERNAL_RUN_MARKER));
});

check("harvest digest: flattens whitespace, truncates long messages, and caps each session's digest", () => {
  const base: ScannedSession = { sessionId: "s1", project: "p", startDate: "2026-08-17", date: "2026-08-17", end: hIso(1), items: [] };
  const spaced = digestSession({ ...base, items: [{ role: "human", text: "line one\nline two   spaced" }] });
  assert.ok(spaced.includes("human: line one line two spaced"), spaced);
  const long = digestSession({ ...base, items: [{ role: "human", text: "x".repeat(900) }] });
  const humanLine = long.split("\n").find((l) => l.startsWith("human:"))!;
  assert.equal(humanLine.length, "human: ".length + 300, "human messages truncate at 300 chars");
  const many = digestSession({ ...base, items: Array.from({ length: 12 }, (_, i) => ({ role: "human" as const, text: `message ${i} ` + "y".repeat(290) })) });
  assert.ok(many.length <= SESSION_DIGEST_CHAR_CAP + "(session digest truncated)".length + 1, `session digest must respect its cap, got ${many.length}`);
  assert.ok(many.includes("(session digest truncated)"), "an overflowing session must say it was truncated");
});

check("harvest digest budget: oldest sessions are dropped first and recorded; survivors stay chronological", () => {
  const mk = (i: number): ScannedSession => ({
    sessionId: `sess-${i}`,
    project: "p",
    startDate: hIso(6 - i).slice(0, 10),
    date: hIso(6 - i).slice(0, 10),
    end: hIso(6 - i),
    items: [{ role: "human", text: `session number ${i} says something substantive` }],
  });
  const sessions = [mk(0), mk(1), mk(2)]; // oldest first
  const full = buildHarvestDigest(sessions);
  assert.deepEqual(full.dropped, [], "everything fits under the real budget");
  assert.equal(full.included.length, 3);
  const perBlock = digestSession(sessions[0]).length + 2;
  const tight = buildHarvestDigest(sessions, perBlock * 2 + 4);
  assert.deepEqual(tight.included.map((s) => s.sessionId), ["sess-1", "sess-2"], "the newest sessions survive");
  assert.deepEqual(tight.dropped.map((s) => s.sessionId), ["sess-0"], "the oldest session is dropped and recorded");
  assert.ok(tight.text.indexOf("session number 1") < tight.text.indexOf("session number 2"), "survivors stay oldest first");
  assert.ok(HARVEST_DIGEST_CHAR_BUDGET < HARVEST_PROMPT_CHAR_CAP, "the digest budget must leave prompt headroom for review");
});

check("harvest trigrams: word trigrams and overlap behave", () => {
  const a = wordTrigrams("The staging DB resets nightly at 02:00 UTC.");
  assert.ok(a.has("the staging db"), [...a].join("|"));
  assert.ok(a.has("staging db resets"));
  assert.equal(trigramOverlap(a, a), 1, "identical texts overlap fully");
  assert.equal(trigramOverlap(wordTrigrams("too short"), a), 0, "under three words there are no trigrams");
  const b = wordTrigrams("The staging DB resets nightly at 02:00 UTC, so wait.");
  assert.ok(trigramOverlap(a, b) > 0.8, String(trigramOverlap(a, b)));
  assert.ok(trigramOverlap(a, wordTrigrams("completely different words about deployment windows and lint rules")) === 0);
});

check("harvest validation: closed type set, required fields, the 1200-char body cap, and the mandatory source line", () => {
  const good = {
    type: "decision",
    title: "Poll interval is 30s",
    body: "The human settled on 30 seconds because free tiers rate limit below that.\n\nsource: session 2026-08-17, project cookbook-app",
  };
  const { proposals, invalid } = validateHarvestProposals({
    proposals: [
      good,
      { type: "note", title: "T", body: "b\nsource: session x" },
      { type: "task", title: "T", body: "b\nsource: session x" },
      { type: "merge", title: "T", body: "b\nsource: session x" },
      { type: "gotcha", body: "no title\nsource: session x" },
      { type: "gotcha", title: "No body" },
      { type: "gotcha", title: "Too long", body: "z".repeat(1300) + "\nsource: session x" },
      { type: "gotcha", title: "No citation", body: "a body with no citation at all" },
    ],
  });
  assert.equal(proposals.length, 1, JSON.stringify(invalid));
  assert.deepEqual(proposals[0], good);
  assert.equal(invalid.length, 7);
  const reasons = invalid.map((i) => i.reason).join("\n");
  assert.ok(/type must be one of decision, gotcha, convention, open_thread/.test(reasons), reasons);
  assert.ok(/missing title/.test(reasons), reasons);
  assert.ok(/missing body/.test(reasons), reasons);
  assert.ok(/over the 1200 cap/.test(reasons), reasons);
  assert.ok(/must cite its session in a source: line/.test(reasons), reasons);
  assert.deepEqual(validateHarvestProposals("not even an object").proposals, []);
  assert.equal(validateHarvestProposals({ nope: true }).invalid[0].reason, "output has no proposals array");
});

check("harvest validation: an INLINE session citation is moved onto its own line so the 0.85 cap detection sees it", () => {
  // observed in the wild: the model ends the last sentence with the citation instead of a line break
  const inline = "The owner keeps all Phonestack work in the cookbook workspace. source: session 2026-08-18, project diegoprozzi";
  const fixed = normalizeSourceLine(inline);
  assert.ok(fixed.endsWith("\n\nsource: session 2026-08-18, project diegoprozzi"), fixed);
  assert.ok(isSourced(fixed), "the normalized body must pass the standard line-start source detection");
  assert.ok(fixed.startsWith("The owner keeps all Phonestack work in the cookbook workspace."), "no words may change");
  const already = "A fact.\n\nsource: session 2026-08-18, project x";
  assert.equal(normalizeSourceLine(already), already, "a body already carrying a source line is untouched");
  const none = "A fact with no citation of any kind.";
  assert.equal(normalizeSourceLine(none), none, "nothing is invented for uncited bodies");
  // the date-RANGE form from long-lived sessions normalizes and validates the same way
  const inlineRange = "The sonar sampling rate is locked at 48 kilohertz. source: session 2026-08-12 to 2026-08-18, project phonestack";
  const fixedRange = normalizeSourceLine(inlineRange);
  assert.ok(fixedRange.endsWith("\n\nsource: session 2026-08-12 to 2026-08-18, project phonestack"), fixedRange);
  assert.ok(isSourced(fixedRange), "the range form must pass the standard source detection");
  const { proposals, invalid } = validateHarvestProposals({
    proposals: [
      { type: "convention", title: "Inline citation", body: inline },
      { type: "note", title: "Wrong type stays wrong", body: inline },
      { type: "gotcha", title: "Still uncited", body: none },
      { type: "decision", title: "Range citation", body: inlineRange },
      { type: "decision", title: "Range on its own line", body: "Revenue track ships first.\n\nsource: session 2026-08-12 to 2026-08-18, project phonestack" },
    ],
  });
  assert.equal(proposals.length, 3, JSON.stringify(invalid));
  assert.ok(isSourced(proposals[0].body), "validated bodies must carry a line-start source line");
  assert.ok(proposals.some((p) => p.title === "Range citation"), "the range form must survive validation");
  assert.ok(proposals.some((p) => p.title === "Range on its own line"));
  assert.equal(invalid.length, 2);
  assert.ok(invalid.some((i) => i.reason.includes("must cite its session")), JSON.stringify(invalid));
});

check("harvest dedupe: title matches and >60% trigram overlap against ACTIVE notes are skipped with reasons", () => {
  const dir = tmpdir("brain-harvest-dedupe-");
  try {
    const author = { human: "diego", agent: null };
    const existing = createNote(dir, {
      type: "decision",
      title: "Poll interval is 30s",
      body: "Free tier endpoints rate limit hard below thirty seconds, so the poll interval is thirty seconds for every monitored target, and we verified the limit holds across all eight targets in the fleet during testing last week.",
      author,
    });
    const retired = createNote(dir, { type: "note", title: "Retired title", body: "was true once", author });
    supersedeNote(dir, retired.id, { type: "note", title: "Retired title v2", body: "still niche", author });
    const src = "\n\nsource: session 2026-08-17, project cookbook-app";
    const titleDup: HarvestProposal = { type: "decision", title: "POLL INTERVAL IS 30S", body: "Different words entirely, same claim by title." + src };
    const bodyDup: HarvestProposal = { type: "decision", title: "Polling cadence", body: existing.body + src };
    const fresh: HarvestProposal = { type: "convention", title: "Never deploy on Fridays", body: "The team never deploys on Fridays after the August outage settled the question for good." + src };
    const resurrected: HarvestProposal = { type: "note", title: "Retired title", body: "A superseded title is free again for new facts." + src };
    const { kept, skipped } = dedupeAgainstBrain(loadBrain(dir), [titleDup, bodyDup, fresh, resurrected]);
    assert.deepEqual(kept.map((p) => p.title), ["Never deploy on Fridays", "Retired title"], "superseded notes must not block a title");
    assert.equal(skipped.length, 2);
    assert.ok(skipped[0].reason.includes(`title matches active note "Poll interval is 30s" (${existing.id})`), skipped[0].reason);
    assert.ok(/body shares \d+% of its trigrams with active note "Poll interval is 30s"/.test(skipped[1].reason), skipped[1].reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("harvest planHarvestReview: same guard as dream's, largest proposals dropped first, base includes the digests", () => {
  const src = "\n\nsource: session 2026-08-17, project x";
  const small: HarvestProposal = { type: "decision", title: "Small", body: "short body" + src };
  const big: HarvestProposal = { type: "decision", title: "Big", body: "x".repeat(3000) + src };
  const digestText = "SESSION 2026-08-17, project x\nhuman: something";
  const base = harvestRefuterPrompt([], digestText).length;
  const smallSize = harvestRefuterPrompt([small], digestText).length - base;
  const cap = base + smallSize + 2;
  assert.deepEqual(planHarvestReview([small, big], digestText, HARVEST_PROMPT_CHAR_CAP), { reviewed: [0, 1], skipped: [] }, "both fit the real cap");
  assert.deepEqual(planHarvestReview([big, small], digestText, cap), { reviewed: [1], skipped: [0] }, "the largest is dropped first");
  assert.deepEqual(planHarvestReview([small, big], digestText, cap), { reviewed: [0], skipped: [1] }, "index order does not matter, size does");
  assert.deepEqual(planHarvestReview([big], digestText, base), { reviewed: [], skipped: [0] }, "when nothing fits, nothing is reviewed");
  assert.ok(harvestProposerPrompt(digestText).includes("You are the HARVESTER"));
  assert.ok(harvestRefuterPrompt([small], digestText).includes("You are the REFUTER"));
});

// ---- v0.5: harvest CLI end-to-end over a fake claude shim on PATH ----

/**
 * The fake `claude` binary for harvest runs. Hermetic, same pattern as the
 * dream shim: it tells proposer from refuter by the prompt text on stdin,
 * modes ride FAKE_CLAUDE_MODE, and the proposal payload rides
 * FAKE_HARVEST_PROPOSALS as JSON.
 */
const HARVEST_SHIM_SOURCE = `#!/usr/bin/env node
const fs = require("fs");
const input = fs.readFileSync(0, "utf8");
const mode = process.env.FAKE_CLAUDE_MODE || "wellformed";
const isRefuter = input.includes("You are the REFUTER");
if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ role: isRefuter ? "refuter" : "proposer", args: process.argv.slice(2), maxTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || null }) + "\\n",
  );
}
const out = (s) => process.stdout.write(s);
if (!isRefuter) {
  if (mode === "proposer-garbage") { out("The sessions were lovely but I will not answer in JSON."); process.exit(0); }
  const proposals = process.env.FAKE_HARVEST_PROPOSALS
    ? JSON.parse(process.env.FAKE_HARVEST_PROPOSALS)
    : [
        { type: "decision", title: "Poll interval is 30s", body: "The human settled on a 30 second poll interval because free tiers rate limit below that. It held in testing.\\n\\nsource: session 2026-08-17, project cookbook-app" },
        { type: "convention", title: "Never deploy on Fridays", body: "The human said the team never deploys on Fridays after the outage. Treat it as a standing rule.\\n\\nsource: session 2026-08-17, project cookbook-app" },
      ];
  out("Distilled:\\n\`\`\`json\\n" + JSON.stringify({ proposals }) + "\\n\`\`\`\\n");
  process.exit(0);
}
if (mode === "refuter-garbage") { out("I would rather review the weather than these notes."); process.exit(0); }
const indexes = [...input.matchAll(/^PROPOSAL (\\d+):/gm)].map((m) => Number(m[1]));
let verdicts;
if (mode === "refuter-rejects-some") {
  verdicts = indexes
    .map((i) => {
      if (i === 0) return { index: 0, verdict: "keep", reason: "The digests support it." };
      if (i === 1) return { index: 1, verdict: "reject", reason: "The digests never show this decision being made." };
      return null;
    })
    .filter(Boolean);
} else {
  verdicts = indexes.map((i) => ({ index: i, verdict: "keep", reason: "Supported by the session digests." }));
}
out(JSON.stringify({ verdicts }) + "\\n");
`;

const harvestShimDir = tmpdir("brain-harvest-shim-");
fs.writeFileSync(path.join(harvestShimDir, "claude"), HARVEST_SHIM_SOURCE, { mode: 0o755 });
const HARVEST_SHIM_PATH = `${harvestShimDir}${path.delimiter}${process.env.PATH ?? ""}`;

function harvestEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: HARVEST_SHIM_PATH, BRAIN_HUMAN: "harvesttester", ...extra };
}

function findHarvestReport(dir: string): string {
  const dreams = path.join(dir, "dreams");
  const files = fs.existsSync(dreams) ? fs.readdirSync(dreams).filter((f) => f.startsWith("HARVEST_")) : [];
  assert.equal(files.length, 1, `expected exactly one harvest report, found: ${files.join(", ")}`);
  return fs.readFileSync(path.join(dreams, files[0]), "utf8");
}

check("cli harvest --dry-digest: prints the exact proposer prompt with the digests, no model calls, no report", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-dry-");
  try {
    const r = runCli(["harvest", "--dry-digest", "--dir", dir, "--sessions", root], { env: { PATH: NO_CLAUDE_PATH } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("You are the HARVESTER"), "must print the real proposer prompt");
    assert.ok(r.stdout.includes("project cookbook-app"), r.stdout);
    assert.ok(r.stdout.includes("Switch the poll interval to 30 seconds"), "the digest must carry the human's words");
    assert.ok(!fs.existsSync(path.join(dir, "dreams")), "a dry run must not write a report");
    const filtered = runCli(["harvest", "--dry-digest", "--dir", dir, "--sessions", root, "--project", "other-proj"], { env: { PATH: NO_CLAUDE_PATH } });
    assert.ok(!filtered.stdout.includes("Switch the poll interval"), "the project filter must keep other projects' content out of the digest");
    assert.ok(filtered.stdout.includes("staging DB resets nightly"), filtered.stdout);
    const missing = runCli(["harvest", "--dir", path.join(os.tmpdir(), "definitely-missing-brain")], { env: { PATH: NO_CLAUDE_PATH } });
    assert.equal(missing.status, 2, "harvest without a brain directory must fail with guidance");
    assert.equal(runCli(["harvest", "--days", "0", "--dir", dir]).status, 2, "--days must be a positive integer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest: missing claude binary fails with the transcript privacy message, never asks for API keys", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-nobin-");
  try {
    const r = runCli(["harvest", "--dir", dir, "--sessions", root], { env: { PATH: NO_CLAUDE_PATH } });
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}`);
    assert.ok(r.stderr.includes("Claude Code CLI"), r.stderr);
    assert.ok(r.stderr.includes("your own logged-in `claude`"), r.stderr);
    assert.ok(r.stderr.includes("never reads or requires API keys"), r.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest report-only: full report with refuter: ran, and NOTHING written to the brain", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-report-");
  try {
    const r = runCli(["harvest", "--dir", dir, "--sessions", root], { env: harvestEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("2 session(s) in the last 7 day(s), 2 digested"), r.stdout);
    assert.ok(r.stdout.includes("refuter: ran"), r.stdout);
    assert.ok(r.stdout.includes("report-only run"), r.stdout);
    const report = findHarvestReport(dir);
    for (const section of ["# Harvest report", "## Sessions", "## Proposals", "## Dedupe", "## Refuter review", "## Applied", "## Undo"]) {
      assert.ok(report.includes(section), `report must carry section: ${section}`);
    }
    assert.ok(report.includes("refuter: ran"), "the mandatory refuter line must be present");
    assert.ok(!report.includes("refuter: absent"), "a reviewed harvest must not read as unreviewed");
    assert.ok(report.includes('Proposal 0: decision "Poll interval is 30s"'), report);
    assert.ok(report.includes("proposal 0: keep"), report);
    assert.ok(report.includes("transcript content"), "the report must say plainly that content was read");
    assert.ok(report.includes("skipped: 1 internal tool run(s)"), "the tool's own claude -p run must be counted in the report");
    assert.ok(report.includes("no in-window activity: 1 session(s)"), "the touched-but-old session must be counted, not listed");
    assert.ok(report.includes("windowed by message timestamp"), report);
    assert.ok(/session \d{4}-\d{2}-\d{2}[^\n]*project cookbook-app \(id sess-aaa[^\n]*3 in-window message\(s\)/.test(report), "per-session lines carry dates and in-window message counts");
    assert.ok(r.stdout.includes("1 internal tool run(s) skipped"), r.stdout);
    assert.ok(report.includes("report-only run: nothing was applied"), report);
    assert.ok(report.includes("git revert"), "the report must say how to undo");
    assert.equal(loadBrain(dir).notes.length, 0, "report-only must write no notes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --apply: notes land with harvest authorship, the session source line, and the 0.85 sourced cap via recall", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-apply-");
  try {
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], { env: harvestEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("applied: 2 note(s)"), r.stdout);
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2);
    const decision = brain.notes.find((n) => n.type === "decision")!;
    assert.equal(decision.title, "Poll interval is 30s");
    assert.deepEqual(decision.author, { human: "harvesttester", agent: "harvest" }, "harvest notes are authored by the brain owner via the harvest agent");
    assert.ok(decision.body.includes("source: session 2026-08-17, project cookbook-app"), "the body must cite its session");
    assert.equal(decision.source, undefined, "no special-cased frontmatter source: the body citation is the mechanism");
    assert.equal(capFor(decision), 0.85, "the session citation earns the sourced-agent cap through ordinary source detection");
    const recalled = recall(brain, { query: "poll interval" });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].confidence, 0.75, "fresh uncredited harvest note: 0.85 cap - 0.10");
    assert.equal(recalled[0].tier, "standing");
    const convention = brain.notes.find((n) => n.type === "convention")!;
    assert.equal(convention.title, "Never deploy on Fridays");
    assert.deepEqual(diagnose(dir), [], "an applied harvest must leave the brain valid");
    assert.ok(findHarvestReport(dir).includes('wrote decision "Poll interval is 30s"'), "the report must record the writes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest: refuter garbage means refuter: absent and ZERO writes, even with --apply", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-rgarbage-");
  try {
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], { env: harvestEnv({ FAKE_CLAUDE_MODE: "refuter-garbage" }) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("refuter: absent"), r.stdout);
    assert.ok(r.stdout.includes("applied: nothing"), r.stdout);
    const report = findHarvestReport(dir);
    assert.ok(report.includes("refuter: absent"), "the mandatory line must say the reviewer never showed");
    assert.ok(!report.includes("refuter: ran"), "an unreviewed harvest must never read as reviewed");
    assert.ok(report.includes("unreviewed harvests are never applied"), report);
    assert.equal(loadBrain(dir).notes.length, 0, "nothing may be written without adversarial review");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest: proposer garbage is a graceful empty harvest with an honest report", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-pgarbage-");
  try {
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], { env: harvestEnv({ FAKE_CLAUDE_MODE: "proposer-garbage" }) });
    assert.equal(r.status, 0, r.stderr);
    const report = findHarvestReport(dir);
    assert.ok(report.includes("empty harvest"), report);
    assert.ok(report.includes("refuter: absent"), "with nothing to review the refuter is honestly reported absent");
    assert.ok(report.includes("not consulted"), "the report must distinguish not-consulted from failed");
    assert.equal(loadBrain(dir).notes.length, 0, "an empty harvest writes nothing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --apply: refuter rejections and missing verdicts (default reject) gate what is written", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-rejects-");
  const src = "\n\nsource: session 2026-08-17, project cookbook-app";
  const proposals = [
    { type: "decision", title: "Kept decision", body: "The digests support this one fully, twice over." + src },
    { type: "gotcha", title: "Rejected gotcha", body: "The refuter will find no evidence for this." + src },
    { type: "open_thread", title: "Unanswered question", body: "The refuter forgets to give this one a verdict." + src },
  ];
  try {
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], {
      env: harvestEnv({ FAKE_CLAUDE_MODE: "refuter-rejects-some", FAKE_HARVEST_PROPOSALS: JSON.stringify(proposals) }),
    });
    assert.equal(r.status, 0, r.stderr);
    const report = findHarvestReport(dir);
    assert.ok(report.includes("refuter: ran"), report);
    assert.ok(report.includes("proposal 0: keep"), report);
    assert.ok(report.includes("proposal 1: reject"), report);
    assert.ok(report.includes("rejected by default"), "a missing verdict must be reported as a default reject");
    assert.ok(report.includes("(defaulted)"), report);
    const brain = loadBrain(dir);
    assert.deepEqual(brain.notes.map((n) => n.title), ["Kept decision"], "only the kept proposal may be written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --apply: dedupe skips known facts before review and never writes them twice", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-dedupe-cli-");
  const src = "\n\nsource: session 2026-08-17, project cookbook-app";
  try {
    createNote(dir, {
      type: "decision",
      title: "Poll interval is 30s",
      body: "Already on record from an earlier session.",
      author: { human: "harvesttester", agent: null },
    });
    const proposals = [
      { type: "decision", title: "poll interval is 30s", body: "A rediscovery of the same decision, phrased anew." + src },
      { type: "convention", title: "Never deploy on Fridays", body: "The human said the team never deploys on Fridays after the outage." + src },
    ];
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], {
      env: harvestEnv({ FAKE_HARVEST_PROPOSALS: JSON.stringify(proposals) }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("deduped: 1"), r.stdout);
    const report = findHarvestReport(dir);
    assert.ok(report.includes('skipped "poll interval is 30s"'), report);
    assert.ok(report.includes("title matches active note"), report);
    assert.ok(report.includes('Proposal 0: convention "Never deploy on Fridays"'), "surviving proposals renumber from zero");
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, 2, "one preexisting note plus one new one; no duplicate");
    assert.equal(brain.notes.filter((n) => n.title.toLowerCase() === "poll interval is 30s").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --json: machine-readable report with the budget drops recorded; markdown report still written", () => {
  const root = tmpdir("brain-harvest-budget-root-");
  const dir = tmpdir("brain-harvest-budget-");
  try {
    // 12 sessions of ~1800 digest chars each overflow the 16000-char budget
    const proj = path.join(root, "-Users-diego-Desktop-busy-proj");
    for (let i = 0; i < 12; i++) {
      const entries = Array.from({ length: 12 }, (_, m) => ({
        type: "user",
        timestamp: new Date(HNOW - (12 - i) * 3_600_000 + m * 60_000).toISOString(),
        cwd: "/Users/diego/Desktop/busy-proj",
        message: { role: "user", content: `session ${i} message ${m} ` + "w".repeat(280) },
      }));
      writeJsonl(path.join(proj, `sess-${String(i).padStart(2, "0")}.jsonl`), entries);
    }
    const r = runCli(["harvest", "--json", "--dir", dir, "--sessions", root, "--days", "2"], { env: harvestEnv() });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.mode, "report-only");
    assert.equal(payload.brain, dir);
    assert.equal(payload.days, 2);
    assert.equal(payload.sessions_scanned, 12);
    assert.equal(payload.internal_runs_skipped, 0, "the JSON report carries the internal-run count");
    assert.equal(payload.no_in_window, 0, "the JSON report carries the no-in-window count");
    assert.ok(payload.sessions_digested < 12, "the budget must force drops");
    assert.ok(payload.dropped_for_budget.length > 0, "drops must be recorded");
    assert.equal(payload.sessions_digested + payload.dropped_for_budget.length, 12);
    const droppedIds = payload.dropped_for_budget.map((s: any) => s.sessionId);
    assert.ok(droppedIds.includes("sess-00"), "the oldest session must be dropped first");
    assert.ok(!droppedIds.includes("sess-11"), "the newest session must survive");
    assert.equal(payload.refuter_ran, true);
    assert.equal(payload.kept, payload.proposals.length);
    assert.deepEqual(payload.applied, [], "report-only json must show nothing applied");
    assert.equal(payload.lock_note, null);
    assert.ok(fs.existsSync(payload.report_file), "the markdown report file must still be written");
    const report = fs.readFileSync(payload.report_file, "utf8");
    assert.ok(report.includes("dropped to fit the 16000 char digest budget"), report);
    assert.equal(loadBrain(dir).notes.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest: --model reaches claude -p, and the proposer/refuter token ceilings are 8000/4000", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-model-");
  try {
    const log = path.join(dir, "..", `fake-harvest-log-${path.basename(dir)}.jsonl`);
    const r = runCli(["harvest", "--model", "claude-test-model", "--dir", dir, "--sessions", root], {
      env: harvestEnv({ FAKE_CLAUDE_LOG: log }),
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    fs.rmSync(log, { force: true });
    assert.deepEqual(calls.map((c) => c.role), ["proposer", "refuter"], "exactly two calls: propose, then refute");
    for (const c of calls) {
      assert.deepEqual(c.args, ["-p", "--model", "claude-test-model"], "the model id must ride claude -p --model");
    }
    assert.equal(calls[0].maxTokens, "8000", "proposer output ceiling");
    assert.equal(calls[1].maxTokens, "4000", "refuter output ceiling");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --apply: a fresh foreign lock means nothing is written and the report says why", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-harvest-lock-");
  try {
    fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: 999_999_999, timestamp: new Date().toISOString() }));
    const r = runCli(["harvest", "--apply", "--dir", dir, "--sessions", root], { env: harvestEnv() });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("could not take the brain lock"), r.stdout);
    assert.equal(loadBrain(dir).notes.length, 0, "no notes may be written while another apply holds the lock");
    assert.ok(findHarvestReport(dir).includes("could not take the brain lock"), "the report must record the lock refusal");
    assert.ok(fs.existsSync(lockPath(dir)), "the foreign lock must not be deleted by the refused apply");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

fs.rmSync(harvestShimDir, { recursive: true, force: true });

// ---- v0.6: Obsidian aliases ----

check("aliases: createNote, supersede, and assign_task all emit aliases: [<title>], and it round-trips from disk", () => {
  const dir = tmpdir("brain-alias-");
  try {
    const author = { human: "diego", agent: "claude-code" };
    const note = createNote(dir, { type: "gotcha", title: "Cache rules", body: "x", author });
    assert.deepEqual(note.aliases, ["Cache rules"], "createNote must stamp the title as an alias");
    assert.ok(fs.readFileSync(note.file, "utf8").includes("aliases: [Cache rules]"), "the alias must land in frontmatter");
    const reread = parseNoteFile(note.file, fs.readFileSync(note.file, "utf8")).note!;
    assert.deepEqual(reread.aliases, ["Cache rules"], "the alias must round-trip through the parser");
    assert.ok(hasTitleAlias(reread));
    assert.ok(hasTitleAlias({ ...reread, aliases: ["CACHE RULES"] }), "title aliases match case-insensitively");
    const { newNote } = supersedeNote(dir, note.id, { type: "gotcha", title: "Cache rules v2", body: "y", author });
    assert.deepEqual(newNote.aliases, ["Cache rules v2"], "supersede replacements carry their own title alias");
    const task = assignTask(dir, { title: "Draft the FAQ", instructions: "z", author });
    assert.deepEqual(task.aliases, ["Draft the FAQ"], "task notes carry the alias too");
    assert.deepEqual(missingTitleAlias(loadBrain(dir)), [], "a fresh 0.6 brain has no alias gaps");
    assert.deepEqual(diagnose(dir), [], "aliases must not disturb the validator");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("aliases: round-trip survives commas, colons, and brackets in titles; malformed aliases is a parse problem", () => {
  const note: Omit<Note, "file"> = {
    id: ulid(),
    type: "note",
    title: "Routing: app, not pages",
    aliases: ["Routing: app, not pages", "plain extra alias"],
    author: { human: "diego", agent: null },
    created: "2026-08-18T10:00:00.000Z",
    supersedes: null,
    credits: 0,
    last_credited: null,
    body: "b",
  };
  const parsed = parseNoteFile("x.md", serializeNote(note));
  assert.deepEqual(parsed.problems, []);
  const { file: _f, ...roundTripped } = parsed.note!;
  assert.deepEqual(roundTripped, note, "quoted list items with commas must split correctly");
  const dir = tmpdir("brain-alias-tricky-");
  try {
    const written = createNote(dir, { type: "note", title: "Weird, title: with [brackets]", body: "x", author: { human: "d", agent: null } });
    const reread = parseNoteFile(written.file, fs.readFileSync(written.file, "utf8")).note!;
    assert.deepEqual(reread.aliases, ["Weird, title: with [brackets]"], "tricky titles must survive the disk round-trip");
    assert.ok(hasTitleAlias(reread));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const withoutAliases = serializeNote({ ...note, aliases: undefined });
  const malformed = withoutAliases.replace("supersedes: null", "supersedes: null\naliases: not-a-list");
  assert.ok(
    parseNoteFile("x.md", malformed).problems.some((p) => p.includes("bracketed")),
    "an unbracketed aliases value must be reported, not crash",
  );
  assert.equal(parseNoteFile("x.md", withoutAliases).note!.aliases, undefined, "pre-alias notes still parse clean");
});

check("aliases: doctor warns on pre-alias active notes (exit 0), --fix-aliases stamps them, superseded notes never warn", () => {
  const dir = tmpdir("brain-alias-fix-");
  try {
    const author = { human: "diego", agent: null };
    // a pre-alias active note, as written by cookbook-brain 0.5 and earlier
    fs.writeFileSync(
      path.join(dir, "2026-08-01--old-note.md"),
      serializeNote({
        id: "01J8F000000000000000000001",
        type: "note",
        title: "Old note",
        author,
        created: "2026-08-01T10:00:00.000Z",
        supersedes: null,
        credits: 2,
        last_credited: null,
        body: "kept body",
      }),
    );
    // a consistent pre-alias supersede pair: the superseded half must NOT warn
    fs.writeFileSync(
      path.join(dir, "2026-08-02--old-b.md"),
      serializeNote({
        id: "01J8F000000000000000000002",
        type: "note",
        title: "Old B",
        author,
        created: "2026-08-02T10:00:00.000Z",
        supersedes: null,
        superseded_by: "01J8F000000000000000000003",
        credits: 0,
        last_credited: null,
        body: "b",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "2026-08-03--new-b.md"),
      serializeNote({
        id: "01J8F000000000000000000003",
        type: "note",
        title: "New B",
        aliases: ["New B"],
        author,
        created: "2026-08-03T10:00:00.000Z",
        supersedes: "01J8F000000000000000000002",
        credits: 0,
        last_credited: null,
        body: "b2",
      }),
    );
    assert.deepEqual(
      missingTitleAlias(loadBrain(dir)).map((n) => n.title),
      ["Old note"],
      "only the pre-alias ACTIVE note may warn",
    );
    const warn = runCli(["doctor", "--dir", dir]);
    assert.equal(warn.status, 0, "alias gaps are warnings, not errors: doctor must still exit 0");
    assert.ok(warn.stdout.includes("1 alias warning(s)"), warn.stdout);
    assert.ok(warn.stdout.includes('no alias matching "Old note"'), warn.stdout);
    assert.ok(warn.stdout.includes("--fix-aliases"), "the warning must teach the fix");
    assert.ok(warn.stdout.includes("ok: every note parses"), "warnings must not hide the ok line");
    const fix = runCli(["doctor", "--fix-aliases", "--dir", dir]);
    assert.equal(fix.status, 0, fix.stderr);
    assert.ok(fix.stdout.includes("stamped a title alias onto 1 note(s)"), fix.stdout);
    assert.ok(!fix.stdout.includes("alias warning"), "after the fix there is nothing left to warn about");
    const fixed = parseNoteFile("x.md", fs.readFileSync(path.join(dir, "2026-08-01--old-note.md"), "utf8")).note!;
    assert.deepEqual(fixed.aliases, ["Old note"], "the stamp must land on disk");
    assert.equal(fixed.body, "kept body", "the alias stamp must never touch a body");
    assert.equal(fixed.credits, 2, "the alias stamp must not disturb other fields");
    assert.deepEqual(fixTitleAliases(dir), [], "a second fix has nothing to do");
    // an existing aliases list gains the title, it is not replaced
    fs.writeFileSync(
      path.join(dir, "2026-08-04--aliased.md"),
      serializeNote({
        id: "01J8F000000000000000000004",
        type: "note",
        title: "Custom aliased",
        aliases: ["shorthand"],
        author,
        created: "2026-08-04T10:00:00.000Z",
        supersedes: null,
        credits: 0,
        last_credited: null,
        body: "c",
      }),
    );
    const stamped = fixTitleAliases(dir);
    assert.equal(stamped.length, 1);
    assert.deepEqual(stamped[0].aliases, ["shorthand", "Custom aliased"], "hand-added aliases survive the stamp");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.6: the INDEX.md view ----

/** A brain with one of everything for the index and web tests. */
function seedViewBrain(dir: string): void {
  const human = { human: "diego", agent: null };
  const agent = { human: "diego", agent: "claude-code" };
  const at = (day: number) => {
    const created = daysAgo(day);
    return { created, id: ulid(Date.parse(created)) };
  };
  createNote(dir, { type: "convention", title: "No em dashes in copy", body: "Restructure the sentence instead.", author: human, ...at(9) });
  const poll = createNote(dir, { type: "decision", title: "Poll interval is 30s", body: "Free tiers rate limit below that.", author: human, ...at(4) });
  creditNotes(dir, [poll.id]);
  createNote(dir, { type: "decision", title: "Older decision", body: "still holds", author: human, ...at(6) });
  const gotcha = createNote(dir, { type: "gotcha", title: "Registry mirrors lag", body: "Fresh publishes 404 for a day.\n\nsource: https://example.com/registry", author: agent, ...at(3) });
  creditNotes(dir, [gotcha.id]);
  createNote(dir, { type: "note", title: "Linked note", body: "See [[Registry mirrors lag]] before publishing.", author: human, ...at(2) });
  const retired = createNote(dir, { type: "note", title: "Retired fact", body: "was true", author: human, ...at(8) });
  supersedeNote(dir, retired.id, { type: "note", title: "Current fact", body: "is true", author: human, ...at(7) });
  const forCodex = assignTask(dir, { title: "Open work", instructions: "do the open thing", assigned_to: "codex", author: agent, ...at(5) });
  claimTask(dir, forCodex.id, "codex");
  abandonTask(dir, forCodex.id, "no prod access on this machine", "codex");
  const claimed = assignTask(dir, { title: "Claimed work", instructions: "in flight", author: agent, ...at(4) });
  claimTask(dir, claimed.id, "gemini");
  const done = assignTask(dir, { title: "Done work", instructions: "finished", author: agent, ...at(3) });
  completeTask(dir, done.id, "shipped in docs/out.md", "codex");
}

check("cli index: INDEX.md is a wikilinked view with ordered sections, tiers, credits, and task statuses", () => {
  const dir = tmpdir("brain-index-");
  try {
    seedViewBrain(dir);
    const notesBefore = loadBrain(dir).notes.length;
    const r = runCli(["index", "--dir", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("wrote"), r.stdout);
    assert.ok(r.stdout.includes("a view, not a note"), "the CLI must say the file is a view");
    const file = path.join(dir, "INDEX.md");
    const text = fs.readFileSync(file, "utf8");
    const order = ["## Conventions", "## Decisions", "## Gotchas", "## Open threads", "## Notes", "## Tasks"];
    let last = -1;
    for (const heading of order) {
      const pos = text.indexOf(heading);
      assert.ok(pos !== -1, `INDEX.md must carry section: ${heading}`);
      assert.ok(pos > last, `sections must appear in order; ${heading} is misplaced`);
      last = pos;
    }
    assert.ok(text.includes("- [[No em dashes in copy]] (standing, 0 credits)"), text);
    assert.ok(text.includes("- [[Poll interval is 30s]] (proven, 1 credit)"), "a credited human note reads proven with singular credit");
    assert.ok(text.includes("- [[Registry mirrors lag]] (proven, 1 credit)"), text);
    assert.ok(
      text.indexOf("[[Poll interval is 30s]]") < text.indexOf("[[Older decision]]"),
      "within a section, newest created first",
    );
    assert.ok(text.includes("- [[Open work]] (open, for codex)"), "open tasks show their assignee");
    assert.ok(text.includes("- [[Claimed work]] (claimed by gemini)"), "claimed tasks show their claimer");
    assert.ok(!text.includes("[[Done work]]"), "done tasks leave the index");
    assert.ok(!text.includes("[[Retired fact]]"), "superseded notes leave the index");
    assert.ok(text.includes("[[Current fact]]"), "their successors stay");
    assert.ok(text.includes("it is a view"), "the file must explain that regenerating overwrites it");
    // exclusion: INDEX.md is not a note, does not enter recall, and does not disturb doctor
    const brain = loadBrain(dir);
    assert.equal(brain.notes.length, notesBefore, "INDEX.md must not be scanned as a note");
    assert.ok(!brain.notes.some((n) => n.file.endsWith("INDEX.md")));
    assert.deepEqual(recall(brain, { query: "Brain index" }), [], "the view must never surface in recall");
    assert.equal(runCli(["doctor", "--dir", dir]).status, 0, "the generated view must not create doctor problems");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("index: deterministic for a fixed brain and clock, and regenerating overwrites the view in place", () => {
  const dir = tmpdir("brain-index-det-");
  try {
    seedViewBrain(dir);
    const one = renderIndexMd(loadBrain(dir), NOW);
    const two = renderIndexMd(loadBrain(dir), NOW);
    assert.equal(one, two, "same brain and clock must produce byte-identical views");
    assert.equal(runCli(["index", "--dir", dir]).status, 0);
    const first = fs.readFileSync(path.join(dir, "INDEX.md"), "utf8");
    assert.equal(runCli(["index", "--dir", dir]).status, 0);
    const second = fs.readFileSync(path.join(dir, "INDEX.md"), "utf8");
    assert.equal(first, second, "regenerating an unchanged brain must be byte-identical");
    createNote(dir, { type: "note", title: "Brand new note", body: "fresh", author: { human: "diego", agent: null } });
    assert.equal(runCli(["index", "--dir", dir]).status, 0);
    const third = fs.readFileSync(path.join(dir, "INDEX.md"), "utf8");
    assert.ok(third.includes("[[Brand new note]]"), "regenerating must pick up new notes by overwriting the view");
    assert.equal(fs.readdirSync(dir).filter((f) => f === "INDEX.md").length, 1, "there is only ever one INDEX.md");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- v0.6: the read-only web viewer ----

check("cli web: --port validates and a missing brain dir refuses with guidance", () => {
  assert.equal(runCli(["web", "--port", "abc"]).status, 2, "--port must require an integer");
  assert.equal(runCli(["web", "--port", "99999"]).status, 2, "--port must stay in range");
  const r = runCli(["web", "--dir", path.join(os.tmpdir(), "definitely-missing-brain")]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("cookbook-brain init"), r.stderr);
});

async function webViewerTest(): Promise<void> {
  const dir = tmpdir("brain-web-");
  let server: Awaited<ReturnType<typeof serveWeb>> | null = null;
  try {
    seedViewBrain(dir);
    fs.mkdirSync(path.join(dir, "dreams"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dreams", "DREAM_2026-08-17.md"), "# Dream report\n\nrefuter: ran\n");
    server = await serveWeb(dir, 0);
    const addr = server.address() as { address: string; port: number };
    const base = `http://127.0.0.1:${addr.port}`;

    await checkAsync("web: binds 127.0.0.1 only", async () => {
      assert.equal(addr.address, "127.0.0.1", "the viewer must never bind a public interface");
    });

    await checkAsync("web: serves one self-contained page with the section structure and the read-only footer", async () => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
      const html = await res.text();
      assert.ok(html.includes("Read-only view. The live multiplayer version is cookbook.team"), "the footer line must be present verbatim");
      for (const heading of ["<h2>Conventions</h2>", "<h2>Notes</h2>", "<h2>Task board</h2>", "<h2>Reports</h2>"]) {
        assert.ok(html.includes(heading), `the page must carry ${heading}`);
      }
      assert.ok(html.includes("/api/brain.json"), "the page must fetch the JSON endpoint");
      assert.ok(!/src\s*=\s*["']https?:/i.test(html), "no external scripts: the page is self-contained");
      assert.ok(!/href\s*=\s*["']https?:[^"']*\.css/i.test(html), "no CDN stylesheets");
    });

    await checkAsync("web: /api/brain.json carries confidence, tier, credits, backlinks, tasks, conventions, and reports", async () => {
      const res = await fetch(`${base}/api/brain.json`);
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") ?? "").includes("application/json"));
      const data = await res.json();
      assert.equal(data.brain, dir);
      const gotcha = data.notes.find((n: any) => n.title === "Registry mirrors lag");
      assert.ok(gotcha, "active notes must be present");
      assert.equal(typeof gotcha.confidence, "number", "every note carries a confidence score");
      assert.equal(gotcha.tier, "proven", "a fresh credited sourced-agent note reads proven at 0.80");
      assert.equal(gotcha.credits, 1);
      assert.deepEqual(gotcha.backlinks.map((b: any) => b.title), ["Linked note"], "backlinks ride the JSON");
      assert.ok(!data.notes.some((n: any) => n.title === "Retired fact"), "superseded notes stay out");
      assert.deepEqual(data.conventions.map((c: any) => c.title), ["No em dashes in copy"], "conventions ride separately for pinning");
      assert.equal(typeof data.conventions[0].tier, "string");
      const open = data.tasks.find((t: any) => t.title === "Open work");
      assert.equal(open.status, "open");
      assert.equal(open.abandon_reason, "no prod access on this machine", "abandon reasons must be visible on the board");
      assert.equal(data.tasks.find((t: any) => t.title === "Claimed work").claimed_by, "gemini");
      assert.equal(data.tasks.find((t: any) => t.title === "Done work").result, "shipped in docs/out.md");
      assert.equal(data.reports.length, 1);
      assert.equal(data.reports[0].name, "DREAM_2026-08-17.md");
      assert.ok(data.reports[0].content.includes("refuter: ran"), "report contents ride the JSON");
    });

    await checkAsync("web: read-only means 405 on every non-GET, 404 on unknown paths, and zero disk changes", async () => {
      const before = fs.readdirSync(dir).sort().join(",");
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        for (const p of ["/", "/api/brain.json", "/api/remember"]) {
          const res = await fetch(base + p, { method, body: method === "POST" || method === "PUT" ? "{}" : undefined });
          assert.equal(res.status, 405, `${method} ${p} must be refused with 405`);
          assert.equal(res.headers.get("allow"), "GET, HEAD");
        }
      }
      const missing = await fetch(`${base}/api/notes`);
      assert.equal(missing.status, 404, "unknown paths are 404: only / and /api/brain.json exist");
      assert.equal(fs.readdirSync(dir).sort().join(","), before, "no request may change the brain directory");
    });
  } finally {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await webViewerTest();

// ---- v0.7: autoharvest (watermarks, --session, the SessionEnd hook, pending keeps) ----

/** A fresh claude shim for the v0.7 runs (the earlier harvest shim dir was removed after its section). */
const v7ShimDir = tmpdir("brain-v7-shim-");
fs.writeFileSync(path.join(v7ShimDir, "claude"), HARVEST_SHIM_SOURCE, { mode: 0o755 });
const V7_SHIM_PATH = `${v7ShimDir}${path.delimiter}${process.env.PATH ?? ""}`;

function v7Env(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: V7_SHIM_PATH, BRAIN_HUMAN: "hooktester", ...extra };
}

/** The long-lived session fixture again: months of history, three in-window messages. */
function makeLongLivedV7Root(): { root: string; transcript: string } {
  const root = tmpdir("brain-v7-longlived-");
  const proj = path.join(root, "-Users-diego-Desktop-phonestack");
  const cwd = "/Users/diego/Desktop/phonestack";
  const transcript = path.join(proj, "sess-long-9999.jsonl");
  writeJsonl(transcript, [
    { type: "user", timestamp: hIso(60, 0), cwd, message: { role: "user", content: "ANCIENT_DECISION_MUST_NOT_APPEAR: back in June we picked SwiftUI over UIKit." } },
    { type: "assistant", timestamp: hIso(60, 1), cwd, message: { role: "assistant", content: [{ type: "text", text: "ANCIENT_CONCLUSION_MUST_NOT_APPEAR even though this conclusion easily clears the one hundred character floor for agent conclusions." }] } },
    { type: "user", timestamp: hIso(5, 0), cwd, message: { role: "user", content: "This week we locked the sonar sampling rate at 48 kilohertz for the wearable." } },
    { type: "user", timestamp: hIso(2, 0), cwd, message: { role: "user", content: "And the revenue track ships before the sonar demo, that ordering is settled." } },
    { type: "assistant", timestamp: hIso(2, 1), cwd, message: { role: "assistant", content: [{ type: "text", text: "Settled then: revenue track first, sonar demo second, and the sampling rate stays at 48 kilohertz for the wearable hardware." }] } },
  ]);
  return { root, transcript };
}

check("watermarks: round-trip in dreams/harvested.json; missing, malformed, and partial files read safely", () => {
  const dir = tmpdir("brain-v7-wm-");
  try {
    assert.deepEqual(readWatermarks(dir), {}, "no file means no watermarks");
    assert.equal(watermarksPath(dir), path.join(dir, "dreams", "harvested.json"), "the file lives under dreams/, which the note scanner never reads");
    const marks = { "sess-long-9999": { lastMessageTs: hIso(2, 1), harvestedAt: hIso(0, 0) } };
    writeWatermarks(dir, marks);
    assert.deepEqual(readWatermarks(dir), marks, "round-trip");
    fs.writeFileSync(watermarksPath(dir), "not json at all");
    assert.deepEqual(readWatermarks(dir), {}, "a malformed file reads as empty, never throws");
    fs.writeFileSync(watermarksPath(dir), JSON.stringify({ ok: { lastMessageTs: "2026-08-16T00:00:00.000Z", harvestedAt: "2026-08-18T00:00:00.000Z" }, bad: { nope: 1 }, worse: "x" }));
    assert.deepEqual(Object.keys(readWatermarks(dir)), ["ok"], "malformed entries are dropped individually");
    // the watermark file is not a note and never disturbs the brain
    createNote(dir, { type: "note", title: "Real note", body: "x", author: { human: "d", agent: null } });
    assert.equal(loadBrain(dir).notes.length, 1);
    assert.deepEqual(diagnose(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("harvest scan: a watermark digests only NEWER messages; a fully covered session counts up to date", () => {
  const { root } = makeLongLivedV7Root();
  try {
    const wmAt = (ts: string) => ({ "sess-long-9999": { lastMessageTs: ts, harvestedAt: hIso(0, 0) } });
    const full = scanSessions(root, { now: HNOW, days: 7 });
    assert.equal(full.sessions[0].items.length, 3);
    assert.equal(full.upToDate, 0);
    const partial = scanSessions(root, { now: HNOW, days: 7, watermarks: wmAt(hIso(5, 0)) });
    assert.equal(partial.sessions.length, 1);
    assert.equal(partial.sessions[0].items.length, 2, "the message AT the watermark was already harvested; only strictly newer ones ride");
    assert.equal(partial.sessions[0].startDate, hIso(2, 0).slice(0, 10), "attribution starts at the first NEW message");
    assert.ok(!buildHarvestDigest(partial.sessions).text.includes("sonar sampling rate"), "watermarked content must never reach a digest again");
    const covered = scanSessions(root, { now: HNOW, days: 7, watermarks: wmAt(hIso(2, 1)) });
    assert.deepEqual(covered.sessions, [], "nothing newer than the watermark leaves nothing to digest");
    assert.equal(covered.upToDate, 1, "the covered session counts as up to date");
    assert.equal(covered.noInWindow, 0, "up to date is not the same as out of window");
    const foreign = scanSessions(root, { now: HNOW, days: 7, watermarks: { "sess-other": { lastMessageTs: hIso(0, 0), harvestedAt: hIso(0, 0) } } });
    assert.equal(foreign.sessions[0].items.length, 3, "another session's watermark filters nothing here");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check("harvest scan: sessionId selects exactly one transcript", () => {
  const root = makeSessionsRoot();
  try {
    const one = scanSessions(root, { now: HNOW, days: 7, sessionId: "sess-bbbb-2222" });
    assert.deepEqual(one.sessions.map((s) => s.sessionId), ["sess-bbbb-2222"]);
    assert.equal(one.internalRuns, 0, "other transcripts are never even opened");
    assert.deepEqual(scanSessions(root, { now: HNOW, days: 7, sessionId: "sess-no-such" }).sessions, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check("cli harvest --session: harvests exactly one transcript, and the window defaults to 2 days", () => {
  const root = makeSessionsRoot();
  const dir = tmpdir("brain-v7-session-");
  try {
    const r = runCli(["harvest", "--json", "--dir", dir, "--sessions", root, "--session", "sess-aaaa-1111"], { env: v7Env() });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.session, "sess-aaaa-1111");
    assert.equal(payload.days, 2, "--session narrows the default window to 2 days");
    assert.equal(payload.sessions_scanned, 1, "exactly one transcript rides");
    assert.equal(payload.sessions_digested, 1);
    assert.ok(fs.readFileSync(payload.report_file, "utf8").includes("- session filter: sess-aaaa-1111"), "the report names the session filter");
    // the message window still applies in session mode: a 30-day-old session digests nothing at the default
    const old = JSON.parse(runCli(["harvest", "--json", "--dir", dir, "--sessions", root, "--session", "sess-old-3333"], { env: v7Env() }).stdout);
    assert.equal(old.sessions_scanned, 0, "the 2-day default window keeps a 30-day-old session out");
    // and an explicit --days always wins over the session-mode default
    const wide = JSON.parse(runCli(["harvest", "--json", "--dir", dir, "--sessions", root, "--session", "sess-old-3333", "--days", "40"], { env: v7Env() }).stdout);
    assert.equal(wide.days, 40);
    assert.equal(wide.sessions_scanned, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest --since-last: the first run stamps the watermark, repeat runs digest only what is new", () => {
  const { root, transcript } = makeLongLivedV7Root();
  const dir = tmpdir("brain-v7-since-");
  try {
    // run 1: digests the three in-window messages and stamps the watermark
    const p1 = JSON.parse(runCli(["harvest", "--json", "--since-last", "--dir", dir, "--sessions", root], { env: v7Env() }).stdout);
    assert.equal(p1.since_last, true);
    assert.equal(p1.sessions_digested, 1);
    assert.equal(p1.watermarks_updated, 1, "a successful report-only harvest still advances the watermark");
    const marks1 = readWatermarks(dir);
    assert.equal(marks1["sess-long-9999"].lastMessageTs, hIso(2, 1), "the watermark is the last digested message's own timestamp");
    // run 2, nothing new: the session reads up to date and the model is never called
    const p2 = JSON.parse(runCli(["harvest", "--json", "--since-last", "--dir", dir, "--sessions", root], { env: v7Env() }).stdout);
    assert.equal(p2.sessions_scanned, 0);
    assert.equal(p2.up_to_date, 1, "a covered session counts as up to date");
    assert.equal(p2.watermarks_updated, 0, "nothing digested, nothing stamped");
    assert.deepEqual(readWatermarks(dir), marks1, "the watermark file is untouched");
    // new activity arrives in the same long-lived session
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: "user", timestamp: hIso(0, -10), cwd: "/Users/diego/Desktop/phonestack", message: { role: "user", content: "Fresh decision: the wearable battery test runs before every demo from now on." } }) + "\n",
    );
    // the outbound digest carries ONLY the new message
    const dry = runCli(["harvest", "--dry-digest", "--since-last", "--dir", dir, "--sessions", root], { env: { PATH: NO_CLAUDE_PATH } });
    assert.ok(dry.stdout.includes("Fresh decision"), dry.stdout);
    assert.ok(!dry.stdout.includes("sonar sampling rate"), "already-harvested content must never re-digest");
    assert.ok(!dry.stdout.includes("ANCIENT_DECISION"), "out-of-window content stays out too");
    // run 3 digests only the new slice and advances the watermark
    const p3 = JSON.parse(runCli(["harvest", "--json", "--since-last", "--dir", dir, "--sessions", root], { env: v7Env() }).stdout);
    assert.equal(p3.sessions_digested, 1);
    const marks3 = readWatermarks(dir);
    assert.equal(marks3["sess-long-9999"].lastMessageTs, hIso(0, -10), "the watermark advances to the newest digested message");
    assert.ok(marks3["sess-long-9999"].lastMessageTs > marks1["sess-long-9999"].lastMessageTs);
    assert.equal(loadBrain(dir).notes.length, 0, "every run here was report-only");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli harvest: a failed proposer stamps NO watermark, so the next run retries the same messages", () => {
  const { root } = makeLongLivedV7Root();
  const dir = tmpdir("brain-v7-wmfail-");
  try {
    const p = JSON.parse(runCli(["harvest", "--json", "--since-last", "--dir", dir, "--sessions", root], { env: v7Env({ FAKE_CLAUDE_MODE: "proposer-garbage" }) }).stdout);
    assert.equal(p.watermarks_updated, 0, "an unparseable proposer is not a successful harvest");
    assert.deepEqual(readWatermarks(dir), {}, "nothing was stamped, so nothing is ever silently lost");
    // the retry digests the same three messages
    const retry = JSON.parse(runCli(["harvest", "--json", "--since-last", "--dir", dir, "--sessions", root], { env: v7Env() }).stdout);
    assert.equal(retry.sessions_digested, 1);
    assert.equal(retry.watermarks_updated, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("cli hook-run --no-detach: parses the SessionEnd JSON and runs a report-only incremental harvest inline", () => {
  const { root, transcript } = makeLongLivedV7Root();
  const dir = tmpdir("brain-v7-hookrun-");
  const sessionCwd = tmpdir("brain-v7-hookcwd-");
  try {
    const payload = { session_id: "sess-long-9999", transcript_path: transcript, cwd: sessionCwd, hook_event_name: "SessionEnd", reason: "exit" };
    const r = runCli(["hook-run", "--no-detach", "--dir", dir, "--sessions", root], { env: v7Env(), input: JSON.stringify(payload) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, "report-only", "hook mode is ALWAYS report-only; --apply does not exist here");
    assert.equal(out.session, "sess-long-9999", "the session id comes from the stdin JSON");
    assert.equal(out.since_last, true, "hook harvests are incremental");
    assert.equal(out.days, 2, "session-mode default window");
    assert.equal(out.sessions_digested, 1);
    assert.ok(fs.existsSync(out.report_file), "the markdown report lands like any harvest");
    assert.equal(readWatermarks(dir)["sess-long-9999"].lastMessageTs, hIso(2, 1), "the hook run stamps the watermark");
    assert.equal(loadBrain(dir).notes.length, 0, "a hook run must never write notes");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionCwd, { recursive: true, force: true });
  }
});

check("cli hook-run: the recursion guard skips the tool's own sessions; broken stdin exits 0 quietly", () => {
  const root = tmpdir("brain-v7-guard-root-");
  const dir = tmpdir("brain-v7-guard-");
  try {
    const transcript = path.join(root, "-Users-diego-Desktop-cookbook-brain", "sess-guard-0001.jsonl");
    writeJsonl(transcript, [
      { type: "user", timestamp: hIso(0, -5), cwd: "/x", isMeta: true, message: { role: "user", content: "meta noise first" } },
      { type: "user", timestamp: hIso(0, -4), cwd: "/x", message: { role: "user", content: `${INTERNAL_RUN_MARKER}\nYou are the HARVESTER in a memory bootstrap pass.` } },
    ]);
    assert.ok(isInternalRunPrompt(transcriptFirstUserText(transcript)!), "the guard reuses isInternalRunPrompt on the first non-meta user message");
    assert.equal(transcriptFirstUserText(path.join(root, "missing.jsonl")), null, "an unreadable transcript reads as no message");
    const payload = { session_id: "sess-guard-0001", transcript_path: transcript, cwd: dir };
    const r = runCli(["hook-run", "--no-detach", "--dir", dir, "--sessions", root], { env: v7Env(), input: JSON.stringify(payload) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "", "an internal session spawns no harvest at all");
    assert.ok(!fs.existsSync(path.join(dir, "dreams")), "no report may be written");
    // garbage stdin and a missing session_id both exit 0 without doing anything: session close must never break
    assert.equal(runCli(["hook-run", "--no-detach", "--dir", dir, "--sessions", root], { env: v7Env(), input: "not json" }).status, 0);
    assert.equal(runCli(["hook-run", "--no-detach", "--dir", dir, "--sessions", root], { env: v7Env(), input: "{}" }).status, 0);
    assert.ok(!fs.existsSync(path.join(dir, "dreams")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await checkAsync("cli hook-run detached: exits 0 immediately and the harvest lands in the log", async () => {
  const { root, transcript } = makeLongLivedV7Root();
  const dir = tmpdir("brain-v7-detach-");
  const sessionCwd = tmpdir("brain-v7-detach-cwd-");
  const log = path.join(tmpdir("brain-v7-detach-log-"), "autoharvest.log");
  try {
    const payload = { session_id: "sess-long-9999", transcript_path: transcript, cwd: sessionCwd };
    const r = runCli(["hook-run", "--dir", dir, "--sessions", root], {
      env: v7Env({ COOKBOOK_BRAIN_AUTOHARVEST_LOG: log }),
      input: JSON.stringify(payload),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "", "detached mode prints nothing: the output goes to the log");
    assert.ok(fs.existsSync(log), "the log header is written before hook-run exits");
    assert.ok(fs.readFileSync(log, "utf8").includes("[cookbook-brain autoharvest]"), "the log opens with a stamped header line");
    // the detached child finishes on its own schedule; poll for its JSON report
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !fs.readFileSync(log, "utf8").includes('"report_file"')) {
      await new Promise((res) => setTimeout(res, 250));
    }
    const logText = fs.readFileSync(log, "utf8");
    assert.ok(logText.includes('"mode": "report-only"'), `the detached harvest must be report-only; log was:\n${logText.slice(0, 500)}`);
    assert.ok(logText.includes('"session": "sess-long-9999"'), logText.slice(0, 500));
    assert.ok(logText.includes('"since_last": true'), "the detached harvest is incremental");
    assert.equal(readWatermarks(dir)["sess-long-9999"].lastMessageTs, hIso(2, 1), "the detached run stamps the watermark");
    assert.equal(loadBrain(dir).notes.length, 0, "still report-only");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sessionCwd, { recursive: true, force: true });
  }
});

check("cli install-hook: surgically merges our SessionEnd entry; unrelated keys and hooks survive; idempotent; uninstall restores", () => {
  const file = path.join(tmpdir("brain-v7-settings-"), "settings.json");
  const before = {
    model: "opus",
    theme: "dark",
    hooks: {
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo post-tool" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "echo unrelated-session-end" }] }],
    },
  };
  fs.writeFileSync(file, JSON.stringify(before, null, 2));
  const r = runCli(["install-hook", "--settings", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("installed a SessionEnd hook"), r.stdout);
  assert.ok(r.stdout.includes("report-only"), "install must say unattended runs never apply");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.model, "opus");
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.hooks.PostToolUse, before.hooks.PostToolUse, "other hook events are untouched");
  assert.equal(after.hooks.SessionEnd.length, 2, "our group is appended; the unrelated one is preserved");
  assert.deepEqual(after.hooks.SessionEnd[0], before.hooks.SessionEnd[0]);
  const ours = after.hooks.SessionEnd[1].hooks[0];
  assert.equal(ours.type, "command");
  assert.ok(ours.command.includes("cookbook-brain"), "ours is identified by its command string");
  assert.ok(ours.command.endsWith("hook-run"), ours.command);
  // idempotent: a second install changes nothing
  const again = runCli(["install-hook", "--settings", file]);
  assert.equal(again.status, 0);
  assert.ok(again.stdout.includes("already installed"), again.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), after);
  // uninstall removes ONLY ours and restores the pre-install shape exactly
  const un = runCli(["uninstall-hook", "--settings", file]);
  assert.equal(un.status, 0, un.stderr);
  assert.ok(un.stdout.includes("removed 1 cookbook-brain hook"), un.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), before, "uninstall restores exactly the pre-install settings");
  // uninstalling again is a polite no-op
  const unAgain = runCli(["uninstall-hook", "--settings", file]);
  assert.equal(unAgain.status, 0);
  assert.ok(unAgain.stdout.includes("nothing was changed"), unAgain.stdout);
});

check("cli install-hook: creates a missing settings file; uninstall prunes the empty hooks object it added", () => {
  const file = path.join(tmpdir("brain-v7-settings2-"), "nested", "settings.json");
  const r = runCli(["install-hook", "--settings", file]);
  assert.equal(r.status, 0, r.stderr);
  const created = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(created.hooks.SessionEnd.length, 1);
  assert.ok(created.hooks.SessionEnd[0].hooks[0].command.includes("cookbook-brain"));
  const un = runCli(["uninstall-hook", "--settings", file]);
  assert.equal(un.status, 0, un.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {}, "nothing of ours may be left behind");
  // uninstall against a missing file is a polite no-op too
  const missing = runCli(["uninstall-hook", "--settings", path.join(os.tmpdir(), "definitely-missing-settings.json")]);
  assert.equal(missing.status, 0);
  assert.ok(missing.stdout.includes("nothing to remove"), missing.stdout);
});

check("cli install-hook + uninstall-hook: refuse malformed settings and change nothing", () => {
  const file = path.join(tmpdir("brain-v7-settings3-"), "settings.json");
  fs.writeFileSync(file, "{ this is not json");
  const bytes = fs.readFileSync(file, "utf8");
  const r = runCli(["install-hook", "--settings", file]);
  assert.equal(r.status, 1, "a file we cannot parse must refuse, never clobber");
  assert.ok(r.stderr.includes("refusing to touch"), r.stderr);
  assert.ok(r.stderr.includes("Nothing was changed"), r.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "the malformed file must stay byte-identical");
  const un = runCli(["uninstall-hook", "--settings", file]);
  assert.equal(un.status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  // a parseable file whose hooks value cannot be edited safely also refuses
  fs.writeFileSync(file, JSON.stringify({ hooks: "what even is this" }));
  const bad = runCli(["install-hook", "--settings", file]);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes('"hooks" value is not an object'), bad.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { hooks: "what even is this" });
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionEnd: "also wrong" } }));
  const bad2 = runCli(["install-hook", "--settings", file]);
  assert.equal(bad2.status, 1);
  assert.ok(bad2.stderr.includes("SessionEnd"), bad2.stderr);
});

check("cli log: surfaces recent harvest reports with kept-but-unapplied proposals", () => {
  const dir = tmpdir("brain-v7-pending-");
  try {
    createNote(dir, { type: "note", title: "A note", body: "x", author: { human: "d", agent: null } });
    const dreams = path.join(dir, "dreams");
    fs.mkdirSync(dreams);
    assert.ok(!runCli(["log", "--dir", dir]).stdout.includes("unapplied keeps"), "no reports, no line");
    // a recent report-only report with a keep: pending
    fs.writeFileSync(
      path.join(dreams, "HARVEST_2026-08-18.md"),
      ["# Harvest report", "## Refuter review", "refuter: ran", "- proposal 0: keep. Supported by the digests.", "## Applied", "report-only run: nothing was applied. Re-run with --apply to write the kept notes."].join("\n"),
    );
    // an APPLIED report with keeps: not pending
    fs.writeFileSync(
      path.join(dreams, "HARVEST_2026-08-17.md"),
      ["# Harvest report", "## Refuter review", "refuter: ran", "- proposal 0: keep. Supported.", "## Applied", '- proposal 0: wrote decision "X" (x.md)'].join("\n"),
    );
    // a report-only report with only rejects: not pending
    fs.writeFileSync(
      path.join(dreams, "HARVEST_2026-08-16.md"),
      ["# Harvest report", "## Refuter review", "- proposal 0: reject. Unsupported.", "## Applied", "report-only run: nothing was applied."].join("\n"),
    );
    // a dream report never trips the harvest line
    fs.writeFileSync(path.join(dreams, "DREAM_2026-08-18.md"), ["- proposal 0: keep. Fine.", "report-only run: nothing was applied."].join("\n"));
    // an old pending report ages out of "recent"
    const old = path.join(dreams, "HARVEST_2026-07-01.md");
    fs.writeFileSync(old, ["- proposal 0: keep. Old.", "report-only run: nothing was applied."].join("\n"));
    fs.utimesSync(old, new Date(Date.now() - 8 * DAY), new Date(Date.now() - 8 * DAY));
    assert.equal(pendingHarvestKeeps(dir), 1, "exactly one recent report-only report holds unapplied keeps");
    const r = runCli(["log", "--dir", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("1 harvest report(s) with unapplied keeps: review with cookbook-brain harvest --apply"), r.stdout);
    assert.equal(pendingHarvestKeeps(tmpdir("brain-v7-nodreams-")), 0, "a brain without dreams/ counts zero");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

fs.rmSync(v7ShimDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall brain tests passed");
