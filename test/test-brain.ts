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
  backlinksFor,
  confidenceFor,
  createNote,
  diagnose,
  extractWikilinks,
  isSourced,
  loadBrain,
  noteFilename,
  parseNoteFile,
  recall,
  serializeNote,
  slugify,
  supersedeNote,
  tierFor,
  ulid,
  type Note,
} from "../src/store.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BASIC = path.join(ROOT, "test", "fixtures", "basic-brain");
const BROKEN = path.join(ROOT, "test", "fixtures", "broken-brain");
const BIN = path.join(ROOT, "bin", "cookbook-brain.mjs");

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

check("confidence caps: human 0.95, sourced agent 0.85, bare agent 0.60; tiers split at 0.85", () => {
  const brain = loadBrain(BASIC);
  const conf = (id: string) => confidenceFor(brain.byId.get(id)!);
  assert.equal(conf("01J8A000000000000000000001"), 0.95); // human
  assert.equal(conf("01J8A000000000000000000002"), 0.85); // agent + source URL
  assert.equal(conf("01J8A000000000000000000003"), 0.6); // agent, no source
  assert.equal(tierFor(0.95), "standing");
  assert.equal(tierFor(0.85), "standing");
  assert.equal(tierFor(0.6), "verify");
});

check("isSourced: source: line, bare URL, or neither", () => {
  assert.equal(isSourced("claim\nsource: RFC 9110 section 8"), true);
  assert.equal(isSourced("see https://example.com/doc"), true);
  assert.equal(isSourced("just vibes"), false);
});

check("recall: no query returns all active notes, newest first, with shape fields", () => {
  const results = recall(loadBrain(BASIC));
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
  assert.equal(pnpm.tier, "standing");
  assert.equal(pnpm.confidence, 0.95);
  assert.equal(pnpm.credits, 3);
  assert.equal(pnpm.backlinks.length, 1);
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

    await checkAsync("mcp: tools/list exposes remember, recall, supersede, search with teaching descriptions", async () => {
      const list = await client.request("tools/list");
      const names = list.tools.map((t: any) => t.name).sort();
      assert.deepEqual(names, ["recall", "remember", "search", "supersede"]);
      const remember = list.tools.find((t: any) => t.name === "remember");
      assert.ok(remember.description.includes("ATOMIC"), "description must teach atomicity");
      assert.ok(remember.description.includes("source"), "description must teach sourcing");
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

    await checkAsync("mcp: recall returns the note with confidence, tier, credits, backlinks", async () => {
      const res = await client.request("tools/call", {
        name: "recall",
        arguments: { query: "stdout" },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.count, 1);
      const note = payload.notes[0];
      assert.equal(note.id, noteId);
      assert.equal(note.confidence, 0.85, "sourced agent note caps at 0.85");
      assert.equal(note.tier, "standing");
      assert.equal(note.credits, 0);
      assert.deepEqual(note.backlinks, []);
    });

    await checkAsync("mcp: search behaves as query-only recall", async () => {
      const res = await client.request("tools/call", {
        name: "search",
        arguments: { query: "no such thing here" },
      });
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.count, 0);
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

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nall brain tests passed");
