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
import { REFUTER_PROMPT_CHAR_CAP, buildDigest, extractJson, hygieneFindings, planReview, type Proposal } from "../src/dream.ts";

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

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? tmpdir("brain-cli-"),
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    timeout: 30_000,
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

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall brain tests passed");
