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
  activeNotes,
  assignTask,
  backlinksFor,
  capFor,
  claimTask,
  completeTask,
  confidenceFor,
  createNote,
  creditNotes,
  diagnose,
  extractWikilinks,
  isSourced,
  listTasks,
  loadBrain,
  noteFilename,
  openTasksFor,
  parseNoteFile,
  recall,
  searchRanked,
  serializeNote,
  slugify,
  stalenessFor,
  supersedeNote,
  tierFor,
  ulid,
  type Note,
} from "../src/store.ts";

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

    await checkAsync("mcp: tools/list exposes all nine tools with teaching descriptions", async () => {
      const list = await client.request("tools/list");
      const names = list.tools.map((t: any) => t.name).sort();
      assert.deepEqual(names, [
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
      const remember = list.tools.find((t: any) => t.name === "remember");
      assert.ok(remember.description.includes("ATOMIC"), "description must teach atomicity");
      assert.ok(remember.description.includes("source"), "description must teach sourcing");
      const credit = list.tools.find((t: any) => t.name === "credit");
      assert.ok(credit.description.includes("verifiably"), "credit must teach that credit is for verified outcomes");
      const complete = list.tools.find((t: any) => t.name === "complete_task");
      assert.ok(complete.description.includes("helped_note_ids"), "complete_task must teach the crediting moment");
      const recallTool = list.tools.find((t: any) => t.name === "recall");
      assert.ok(recallTool.description.includes("open_tasks"), "recall must teach task discovery");
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

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall brain tests passed");
