/**
 * cookbook-brain CLI.
 *
 * Commands:
 *   init     create a ./brain directory with a SCHEMA.md explaining the format
 *   serve    run the stdio MCP server over the brain directory
 *   log      list recent notes, newest first
 *   credit   credit notes that proved true in completed work
 *   tasks    list open and claimed tasks with their age
 *   doctor   validate every note and the link/supersede graph
 *
 * The brain directory resolves as: --dir flag, then the BRAIN_DIR environment
 * variable, then ./brain.
 */
import fs from "node:fs";
import path from "node:path";
import {
  activeNotes,
  confidenceFor,
  creditNotes,
  diagnose,
  listTasks,
  loadBrain,
  tierFor,
  type Note,
} from "./store.ts";

const USAGE = `cookbook-brain: agent memory as plain markdown files you own

Usage: npx cookbook-brain <command> [options]

Commands:
  init            create the brain directory (with SCHEMA.md) in the current project
  serve           run the stdio MCP server so agents can remember and recall
  log             list recent notes, newest first
  credit <id...>  credit notes whose facts held up in completed work
  tasks           list open and claimed tasks with their age
  doctor          validate every note, wikilink, supersedes chain, and task

Options:
  --dir <path>   brain directory (default ./brain; BRAIN_DIR env also works)
  --help         show this help

Hook it up to Claude Code:
  claude mcp add brain -- npx cookbook-brain serve
`;

const SCHEMA_MD = `# This directory is a brain

Every markdown file here is one note: one fact, decision, gotcha, convention,
or open question that a person or an agent decided was worth keeping. The
whole format is plain text on purpose. You can read it, edit it, grep it,
diff it, and commit it like any other file in the repo.

## One note per file

A note is a small frontmatter block followed by a markdown body:

\`\`\`markdown
---
id: 01J8ZQ4X2E5N9GVHBK3W7T1MCD
type: gotcha
title: Vercel strips trailing slashes on rewrites
author:
  human: diego
  agent: Claude Code
created: 2026-08-18T17:20:00.000Z
supersedes: null
credits: 0
last_credited: null
---
Rewrites in vercel.json silently drop the trailing slash before matching,
so a rule targeting /docs/ never fires. Match /docs instead.

source: https://vercel.com/docs/rewrites

Related: [[Docs routing decision]]
\`\`\`

The fields:

- **id**: a ULID. Sortable by creation time, unique, never reused.
- **type**: one of \`decision\`, \`gotcha\`, \`convention\`, \`note\`,
  \`open_thread\`, \`task\`.
- **title**: short and stable. Other notes link to it by title.
- **author.human**: the person this note is attributed to.
- **author.agent**: the agent that wrote it, or \`null\` if the human wrote it
  themselves.
- **created**: ISO timestamp.
- **supersedes**: the id of the note this one replaces, or \`null\`.
- **credits**: how many times this note rode into work that verifiably
  completed. Crediting raises recall confidence toward the note's cap.
- **last_credited**: when that last happened, or \`null\`.

Task notes (\`type: task\`) carry four more fields. The body holds the task's
instructions; the frontmatter holds its lifecycle:

- **status**: \`open\` until claimed, \`claimed\` until done, then \`done\`.
- **assigned_to**: the agent label the task is addressed to, or \`null\`
  meaning any agent may take it. Labels match case-insensitively.
- **claimed_by**: the agent label that claimed the task, or \`null\`.
- **result**: a short outcome string stamped on completion, or \`null\`.

## Confidence

Recall scores every note with a public formula:

    score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap)

- **cap** is the provenance ceiling: 0.95 for a human-written note, 0.85 for
  an agent note citing a source (a \`source:\` line or a URL in the body),
  0.60 for a bare agent claim. No amount of crediting lifts a note past its
  cap.
- Each credit lifts the score by 0.05, up to three credits; a fresh
  uncredited note sits 0.10 under its cap.
- **staleness** is 0.05 per full 90 days since \`last_credited\` (or
  \`created\`, if never credited), capped at 0.15. Silence decays trust.
- Scores are rounded to two decimals and floored at 0.20.

Tiers: \`proven\` means credited at least once AND scoring 0.80 or higher;
\`standing\` means 0.60 or higher; everything else is \`verify\`, meaning
check it before you build on it.

## Links

Write another note's title in double brackets, like \`[[Docs routing
decision]]\`, anywhere in a body. Those wikilinks form the graph: when a note
is recalled, every note that links to it comes along as a backlink with its
surrounding lines. Titles match case-insensitively.

## The one rule: never overwrite

Notes are never edited and never deleted. When a fact changes, a NEW note is
written with \`supersedes\` pointing at the old note's id, and the old file
gains a \`superseded_by\` field so tools know to skip it. History always
survives, and \`git log\` on this directory is the story of what the team
learned.

Note bodies are append-only forever; exactly two counters may be stamped in
place: \`credits\` and \`last_credited\`, written when work that relied on a
note verifiably completed. That credit pair is the second sanctioned
mutation of an existing file, alongside the \`superseded_by\` stamp described
above. Task notes allow a third stamp set, on task-type notes only:
\`status\`, \`claimed_by\`, and \`result\`, which move a task through its
lifecycle. Nothing else about an existing file is ever touched, and no stamp
ever changes a body.

Superseded notes are excluded from recall by default.

## Git

Commit this directory. It is designed to be versioned with the project it
describes: plain files, stable names, append-only history. Do not add it to
.gitignore, and do not put secrets in notes.
`;

interface Args {
  command: string | null;
  /** positional arguments after the command (e.g. note ids for credit) */
  rest: string[];
  dir: string;
  limit: number;
}

function fail(msg: string): never {
  console.error(`[cookbook-brain] ${msg}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, rest: [], dir: "", limit: 20 };
  let dirFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === "--dir") {
      dirFlag = argv[++i];
      if (!dirFlag) fail("--dir requires a path");
    } else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) fail("--limit requires a positive integer");
      args.limit = n;
    } else if (a.startsWith("--")) {
      fail(`unknown option: ${a}`);
    } else if (args.command === null) {
      args.command = a;
    } else if (args.command === "credit") {
      args.rest.push(a);
    } else {
      fail(`unexpected argument: ${a}`);
    }
  }
  args.dir = path.resolve(dirFlag ?? process.env.BRAIN_DIR ?? "./brain");
  return args;
}

function cmdInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const schemaPath = path.join(dir, "SCHEMA.md");
  if (fs.existsSync(schemaPath)) {
    console.log(`[cookbook-brain] ${dir} already initialized (SCHEMA.md exists)`);
  } else {
    fs.writeFileSync(schemaPath, SCHEMA_MD);
    console.log(`[cookbook-brain] created ${dir}`);
    console.log(`[cookbook-brain] wrote ${schemaPath} (the format, in plain language)`);
  }
  console.log(`
Git advice: COMMIT this directory. The brain is plain markdown meant to be
versioned with your project, so do not add it to .gitignore. If your brain
must stay private to you, put it outside the repo and point at it with
--dir or BRAIN_DIR instead of ignoring it.

Next: hook it up to your agent.
  claude mcp add brain -- npx cookbook-brain serve
`);
}

function fmtAuthor(n: Note): string {
  return n.author.agent ? `${n.author.human} via ${n.author.agent}` : n.author.human;
}

function cmdLog(dir: string, limit: number): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  const brain = loadBrain(dir);
  const notes = [...brain.notes].sort((a, b) => (a.id > b.id ? -1 : 1)).slice(0, limit);
  if (notes.length === 0) {
    console.log(`[cookbook-brain] ${dir} has no notes yet`);
    return;
  }
  const active = activeNotes(brain).length;
  console.log(`cookbook-brain: ${brain.notes.length} note(s) in ${dir} (${active} active), newest first\n`);
  const typeW = Math.max(...notes.map((n) => n.type.length));
  for (const n of notes) {
    const flags = n.superseded_by !== undefined ? "  [superseded]" : "";
    console.log(`  ${n.id}  ${n.type.padEnd(typeW)}  credits ${String(n.credits).padStart(2)}  ${n.title}${flags}`);
    console.log(`  ${" ".repeat(n.id.length)}  ${" ".repeat(typeW)}  by ${fmtAuthor(n)}, ${n.created.slice(0, 10)}`);
  }
  if (brain.problems.length > 0) {
    console.log(`\n${brain.problems.length} file(s) had problems; run: cookbook-brain doctor`);
  }
}

function cmdCredit(dir: string, ids: string[]): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  if (ids.length === 0) fail("credit requires at least one note id (find ids with: cookbook-brain log)");
  try {
    const credited = creditNotes(dir, ids);
    console.log(`cookbook-brain: credited ${credited.length} note(s)\n`);
    for (const n of credited) {
      const confidence = confidenceFor(n);
      console.log(`  ${n.id}  credits ${String(n.credits).padStart(2)}  confidence ${confidence.toFixed(2)} (${tierFor(confidence, n.credits)})  ${n.title}`);
    }
  } catch (e) {
    console.error(`[cookbook-brain] ${(e as Error).message}`);
    process.exit(1);
  }
}

function ageDays(created: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(created)) / (24 * 60 * 60 * 1000)));
  if (days === 0) return "today";
  return days === 1 ? "1 day old" : `${days} days old`;
}

function cmdTasks(dir: string): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  const brain = loadBrain(dir);
  const tasks = listTasks(brain, "all").filter((t) => t.status !== "done");
  if (tasks.length === 0) {
    console.log(`cookbook-brain: no open or claimed tasks in ${dir}`);
    return;
  }
  console.log(`cookbook-brain: ${tasks.length} waiting task(s) in ${dir}, oldest first\n`);
  for (const t of tasks) {
    const who =
      t.status === "claimed"
        ? `claimed by ${t.claimed_by}`
        : t.assigned_to
          ? `for ${t.assigned_to}`
          : "for any agent";
    console.log(`  ${t.id}  ${(t.status ?? "open").padEnd(7)}  ${t.title}`);
    console.log(`  ${" ".repeat(t.id.length)}  ${" ".repeat(7)}  ${who}, ${ageDays(t.created)}`);
  }
}

function cmdDoctor(dir: string): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  const brain = loadBrain(dir);
  const problems = diagnose(dir);
  console.log(`cookbook-brain doctor: ${brain.notes.length} parseable note(s) in ${dir}`);
  if (problems.length === 0) {
    console.log("ok: every note parses, every wikilink resolves, every supersedes chain and task is consistent");
    return;
  }
  console.log(`${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.log(`  ${path.basename(p.file)}: ${p.message}`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init":
      cmdInit(args.dir);
      break;
    case "serve": {
      const { serve } = await import("./server.ts");
      await serve(args.dir);
      break;
    }
    case "log":
      cmdLog(args.dir, args.limit);
      break;
    case "credit":
      cmdCredit(args.dir, args.rest);
      break;
    case "tasks":
      cmdTasks(args.dir);
      break;
    case "doctor":
      cmdDoctor(args.dir);
      break;
    case null:
      fail("no command given");
      break;
    default:
      fail(`unknown command: ${args.command}`);
  }
}

await main();
