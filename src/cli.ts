/**
 * cookbook-brain CLI.
 *
 * Commands:
 *   init     create a ./brain directory with a SCHEMA.md explaining the format
 *   serve    run the stdio MCP server over the brain directory
 *   log      list recent notes, newest first
 *   doctor   validate every note and the link/supersede graph
 *
 * The brain directory resolves as: --dir flag, then the BRAIN_DIR environment
 * variable, then ./brain.
 */
import fs from "node:fs";
import path from "node:path";
import { activeNotes, diagnose, loadBrain, type Note } from "./store.ts";

const USAGE = `cookbook-brain: agent memory as plain markdown files you own

Usage: npx cookbook-brain <command> [options]

Commands:
  init      create the brain directory (with SCHEMA.md) in the current project
  serve     run the stdio MCP server so agents can remember and recall
  log       list recent notes, newest first
  doctor    validate every note, wikilink, and supersedes chain

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
- **type**: one of \`decision\`, \`gotcha\`, \`convention\`, \`note\`, \`open_thread\`.
- **title**: short and stable. Other notes link to it by title.
- **author.human**: the person this note is attributed to.
- **author.agent**: the agent that wrote it, or \`null\` if the human wrote it
  themselves.
- **created**: ISO timestamp.
- **supersedes**: the id of the note this one replaces, or \`null\`.
- **credits**: how many times this note rode into work that verifiably
  completed. Written now, used to lift confidence in a later release.
- **last_credited**: when that last happened, or \`null\`.

## Links

Write another note's title in double brackets, like \`[[Docs routing
decision]]\`, anywhere in a body. Those wikilinks form the graph: when a note
is recalled, every note that links to it comes along as a backlink with its
surrounding lines. Titles match case-insensitively.

## The one rule: never overwrite

Notes are never edited and never deleted. When a fact changes, a NEW note is
written with \`supersedes\` pointing at the old note's id, and the old file
gains a single \`superseded_by\` field so tools know to skip it. That one
added field is the only change ever made to an existing file. History always
survives, and \`git log\` on this directory is the story of what the team
learned.

Superseded notes are excluded from recall by default.

## Git

Commit this directory. It is designed to be versioned with the project it
describes: plain files, stable names, append-only history. Do not add it to
.gitignore, and do not put secrets in notes.
`;

interface Args {
  command: string | null;
  dir: string;
  limit: number;
}

function fail(msg: string): never {
  console.error(`[cookbook-brain] ${msg}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, dir: "", limit: 20 };
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

function cmdDoctor(dir: string): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  const brain = loadBrain(dir);
  const problems = diagnose(dir);
  console.log(`cookbook-brain doctor: ${brain.notes.length} parseable note(s) in ${dir}`);
  if (problems.length === 0) {
    console.log("ok: every note parses, every wikilink resolves, every supersedes chain is consistent");
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
