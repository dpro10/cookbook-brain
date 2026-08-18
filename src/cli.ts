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
 *            (--fix-aliases stamps title aliases onto pre-alias notes)
 *   index    generate the INDEX.md view at the brain root
 *   web      serve the read-only local viewer on 127.0.0.1
 *   dream    offline consolidation: propose, refute, and (with --apply) apply
 *   harvest  bootstrap memory from local Claude Code transcripts: digest,
 *            propose, refute, and (with --apply) write new notes
 *
 * The brain directory resolves as: --dir flag, then the BRAIN_DIR environment
 * variable, then ./brain.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  INDEX_FILENAME,
  activeNotes,
  confidenceFor,
  creditNotes,
  diagnose,
  fixTitleAliases,
  humanName,
  listTasks,
  loadBrain,
  missingTitleAlias,
  renderIndexMd,
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
  index           generate INDEX.md at the brain root: every active note as a
                  [[wikilink]] with its tier and credits, conventions first
                  (a view, not a note: regenerating overwrites it)
  web             serve a read-only local viewer at http://127.0.0.1:4321
                  (one page, no frameworks; localhost only, GET only)
  dream           consolidate overnight: merge duplicates, promote proven
                  gotchas, flag contradictions; an adversarial refuter reviews
                  every proposal; report-only unless --apply
  harvest         bootstrap memory from your local Claude Code sessions:
                  digest recent transcripts, propose atomic notes, and have an
                  adversarial refuter review them; report-only unless --apply

Options:
  --dir <path>   brain directory (default ./brain; BRAIN_DIR env also works)
  --fix-aliases  doctor: stamp a title alias onto active notes missing one, so
                 Obsidian resolves [[Title]] wikilinks (a sanctioned stamp)
  --port <n>     web: port for the read-only viewer (default 4321)
  --apply        dream/harvest: execute proposals the refuter kept (default: report-only)
  --commit       dream: after a successful apply, git commit the brain directory
                 (only paths under it); requires --apply and a git repo
  --json         dream/harvest: print a machine-readable JSON report to stdout
                 (the markdown report file is still written)
  --model <id>   dream/harvest: model id passed to claude -p --model (default: your claude setting)
  --dry-digest   dream/harvest: print exactly what would be sent to the model, then exit
  --sessions <path>  harvest: transcripts root (default ~/.claude/projects)
  --days <n>     harvest: how many days of sessions to scan (default 7)
  --project <name>   harvest: only sessions whose working directory basename matches
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
aliases: [Vercel strips trailing slashes on rewrites]
author:
  human: diego
  agent: Claude Code
created: 2026-08-18T17:20:00.000Z
supersedes: null
source: https://vercel.com/docs/rewrites
credits: 0
last_credited: null
---
Rewrites in vercel.json silently drop the trailing slash before matching,
so a rule targeting /docs/ never fires. Match /docs instead.

Related: [[Docs routing decision]]
\`\`\`

The fields:

- **id**: a ULID. Sortable by creation time, unique, never reused.
- **type**: one of \`decision\`, \`gotcha\`, \`convention\`, \`note\`,
  \`open_thread\`, \`task\`.
- **title**: short and stable. Other notes link to it by title.
- **aliases**: a list that always carries the note's title. Filenames are
  date-slugged, so Obsidian resolves \`[[Title]]\` wikilinks through this
  field. Every new note gets it automatically; older notes can be stamped
  with \`cookbook-brain doctor --fix-aliases\` (a sanctioned frontmatter
  addition, see below).
- **author.human**: the person this note is attributed to.
- **author.agent**: the agent that wrote it, or \`null\` if the human wrote it
  themselves.
- **created**: ISO timestamp.
- **supersedes**: the id of the note this one replaces, or \`null\`.
- **source**: optional citation for where the fact comes from: a URL, a file
  path, a ticket id. Cited memory is auditable memory: a note with a
  \`source\` field earns the sourced-agent confidence cap (0.85), exactly
  like the body heuristic below. Omit the field rather than leaving it blank.
- **consolidates**: merge and promotion notes written by \`dream\` only: the
  ids of the notes this one consolidated, as a \`[bracketed, list]\`. Each
  consolidated note has its \`superseded_by\` stamped to point at this note.
  \`supersedes\` stays single-valued and is for ordinary one-to-one edits.
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
- **abandon_reason**: present only after a claimed task was abandoned: why
  the claimer handed it back. Cleared on the next claim; the reason survives
  in git history.

## Confidence

Recall scores every note with a public formula:

    score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap)

- **cap** is the provenance ceiling: 0.95 for a human-written note, 0.85 for
  an agent note citing a source (the \`source\` frontmatter field, a
  \`source:\` line, or a URL in the body), 0.60 for a bare agent claim. No
  amount of crediting lifts a note past its cap.
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
\`status\`, \`claimed_by\`, \`result\`, and \`abandon_reason\`, which move a
task through its lifecycle. One more sanctioned addition exists for notes
written before aliases did: \`cookbook-brain doctor --fix-aliases\` stamps
\`aliases: [<title>]\` onto an active note missing it, so Obsidian wikilinks
resolve. Nothing else about an existing file is ever touched, and no stamp
ever changes a body.

Superseded notes are excluded from recall by default.

## Dreams

\`cookbook-brain dream\` is an offline consolidation pass: it proposes
merges, promotions of proven gotchas to conventions, contradiction flags,
and retitles, and an adversarial refuter reviews every proposal before
anything is applied (and nothing is applied without \`--apply\`). Notes a
dream writes are authored \`{ human: <brain owner>, agent: "dream" }\`, so
the bare-agent provenance cap applies: the brain distrusts its own dreams
until work proves them. Dream reports live in the \`dreams/\` subdirectory,
which the note scanner never reads. While a dream applies its changes it
holds a \`.lock\` file in this directory; write tools wait it out, reads
never block, and a lock older than ten minutes is stale and ignored.

## Harvest

\`cookbook-brain harvest\` bootstraps and tops up the brain from your local
Claude Code session transcripts: it digests recent sessions, proposes NEW
atomic notes from a closed set (decision, gotcha, convention, open_thread),
and the same adversarial-refuter contract as dreaming applies: every
proposal is reviewed, unreviewed proposals are never applied, and nothing
is applied without \`--apply\`. Notes a harvest writes are authored
\`{ human: <brain owner>, agent: "harvest" }\`, and each body ends with a
\`source:\` line citing the session it was distilled from, so the
sourced-agent confidence cap (0.85) applies through the ordinary source
detection. The brain trusts its own bootstrap more than a bare claim, but
less than you. Harvest reports live in the \`dreams/\` subdirectory as
\`HARVEST_<date>.md\`.

## The generated index

\`cookbook-brain index\` writes an INDEX.md file at this directory's root:
every active note as a \`[[wikilink]]\` with its tier and credits, grouped by
type with conventions first. INDEX.md is a VIEW, not a note: regenerating
overwrites it wholesale, and the note scanner ignores it by name, exactly
like this SCHEMA.md. Point Obsidian at it as the vault homepage.

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
  /** dream + harvest */
  apply: boolean;
  commit: boolean;
  json: boolean;
  model?: string;
  dryDigest: boolean;
  /** harvest only */
  sessions?: string;
  days: number;
  project?: string;
  /** doctor only */
  fixAliases: boolean;
  /** web only */
  port: number;
}

function fail(msg: string): never {
  console.error(`[cookbook-brain] ${msg}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, rest: [], dir: "", limit: 20, apply: false, commit: false, json: false, dryDigest: false, days: 7, fixAliases: false, port: 4321 };
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
    } else if (a === "--apply") {
      args.apply = true;
    } else if (a === "--commit") {
      args.commit = true;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--dry-digest") {
      args.dryDigest = true;
    } else if (a === "--model") {
      args.model = argv[++i];
      if (!args.model) fail("--model requires a model id");
    } else if (a === "--sessions") {
      args.sessions = argv[++i];
      if (!args.sessions) fail("--sessions requires a path");
    } else if (a === "--days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) fail("--days requires a positive integer");
      args.days = n;
    } else if (a === "--fix-aliases") {
      args.fixAliases = true;
    } else if (a === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) fail("--port requires an integer between 1 and 65535");
      args.port = n;
    } else if (a === "--project") {
      args.project = argv[++i];
      if (!args.project) fail("--project requires a name");
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
    if (t.abandon_reason != null) {
      console.log(`  ${" ".repeat(t.id.length)}  ${" ".repeat(7)}  abandoned earlier: ${t.abandon_reason}`);
    }
  }
}

function cmdDoctor(dir: string, fixAliases: boolean): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  if (fixAliases) {
    // the sanctioned alias stamp: adds aliases: [<title>] in place, touches nothing else
    const stamped = fixTitleAliases(dir);
    if (stamped.length === 0) {
      console.log("aliases: nothing to fix; every active note already carries an alias matching its title");
    } else {
      console.log(`aliases: stamped a title alias onto ${stamped.length} note(s):`);
      for (const n of stamped) console.log(`  ${path.basename(n.file)}: aliases now include "${n.title}"`);
    }
  }
  const brain = loadBrain(dir);
  const problems = diagnose(dir);
  console.log(`cookbook-brain doctor: ${brain.notes.length} parseable note(s) in ${dir}`);
  const missing = missingTitleAlias(brain);
  if (missing.length > 0) {
    console.log(
      `${missing.length} alias warning(s) (not errors): active notes missing an alias matching their title, so Obsidian [[wikilinks]] to them will not resolve. Stamp them with: cookbook-brain doctor --fix-aliases`,
    );
    for (const n of missing) console.log(`  ${path.basename(n.file)}: no alias matching "${n.title}"`);
  }
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

function cmdIndex(dir: string): void {
  if (!fs.existsSync(dir)) fail(`no brain directory at ${dir} (run: cookbook-brain init)`);
  const brain = loadBrain(dir);
  const file = path.join(dir, INDEX_FILENAME);
  // deliberately overwrites: INDEX.md is a generated view, not a note
  fs.writeFileSync(file, renderIndexMd(brain));
  console.log(`cookbook-brain: wrote ${file} (${activeNotes(brain).length} active note(s))`);
  console.log("INDEX.md is a view, not a note: regenerating overwrites it, and the note scanner ignores it.");
  if (brain.problems.length > 0) {
    console.log(`${brain.problems.length} file(s) had problems and were left out; run: cookbook-brain doctor`);
  }
}

async function cmdWeb(args: Args): Promise<void> {
  if (!fs.existsSync(args.dir)) fail(`no brain directory at ${args.dir} (run: cookbook-brain init)`);
  const { serveWeb } = await import("./web.ts");
  const server = await serveWeb(args.dir, args.port);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : args.port;
  console.log(`cookbook-brain: read-only viewer for ${args.dir}`);
  console.log(`  http://127.0.0.1:${port}  (localhost only; endpoints: / and /api/brain.json)`);
  console.log("No mutating endpoints exist. Ctrl-C to stop.");
}

interface CommitResult {
  committed: boolean;
  note: string;
}

/**
 * dream --commit: after a successful apply, commit ONLY paths under the
 * brain directory, so a repo dirty elsewhere never gets swept into the dream
 * commit. Non-fatal on every failure path: the dream and its report already
 * happened; the commit is bookkeeping.
 */
function commitBrainDir(dir: string, appliedCount: number, now: Date): CommitResult {
  const git = (cmdArgs: string[]) => spawnSync("git", cmdArgs, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  const inRepo = git(["rev-parse", "--is-inside-work-tree"]);
  if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") {
    return { committed: false, note: "not committed: the brain directory is not inside a git repository" };
  }
  const add = git(["add", "-A", "--", "."]);
  if (add.status !== 0) {
    return { committed: false, note: `not committed: git add failed: ${(add.stderr ?? "").trim().slice(0, 300)}` };
  }
  const message = `dream: ${now.toISOString().slice(0, 10)} applied ${appliedCount} proposals`;
  const commit = git(["commit", "-m", message, "--", "."]);
  if (commit.status !== 0) {
    return { committed: false, note: `not committed: git commit failed: ${(commit.stderr ?? commit.stdout ?? "").trim().slice(0, 300)}` };
  }
  return { committed: true, note: `committed the brain directory: "${message}"` };
}

async function cmdDream(args: Args): Promise<void> {
  if (!fs.existsSync(args.dir)) fail(`no brain directory at ${args.dir} (run: cookbook-brain init)`);
  if (args.commit && !args.apply) fail("--commit requires --apply (a report-only dream changes nothing to commit)");
  const { buildDigest, dream, findClaudeBinary, hygieneFindings, proposerPrompt } = await import("./dream.ts");

  if (args.dryDigest) {
    // Trust feature: print exactly what would leave for the proposer model, make no calls.
    const brain = loadBrain(args.dir);
    const now = Date.now();
    process.stdout.write(proposerPrompt(buildDigest(brain, now).text, hygieneFindings(brain, now)));
    return;
  }

  if (!findClaudeBinary()) {
    console.error(
      [
        "[cookbook-brain] dream needs the Claude Code CLI: no `claude` binary was found on your PATH.",
        "Dreaming runs on your own logged-in `claude` (install it from https://claude.com/claude-code, then run `claude` once to log in).",
        "cookbook-brain never reads or requires API keys, so there is nothing else to configure.",
      ].join("\n"),
    );
    process.exit(2);
  }

  const outcome = dream({ dir: args.dir, apply: args.apply, model: args.model, human: humanName() });
  const appliedOk = outcome.applied.filter((a) => a.ok).length;

  let commit: CommitResult | null = null;
  if (args.commit) {
    commit =
      appliedOk > 0
        ? commitBrainDir(args.dir, appliedOk, new Date())
        : { committed: false, note: "not committed: nothing was applied, so there is nothing to commit" };
  }

  if (args.json) {
    // machine-readable report on stdout, and nothing else
    process.stdout.write(
      JSON.stringify(
        {
          date: new Date().toISOString(),
          brain: args.dir,
          mode: args.apply ? "apply" : "report-only",
          active_notes: outcome.activeCount,
          hygiene_findings: outcome.hygieneTotal,
          proposals: outcome.proposals,
          refuter_ran: outcome.refuterRan,
          verdicts: outcome.verdicts,
          skipped_review: outcome.skippedReview,
          kept: outcome.keptCount,
          applied: outcome.applied,
          lock_note: outcome.lockNote,
          commit,
          report_file: outcome.reportFile,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(`cookbook-brain dream: ${outcome.activeCount} active note(s) digested, ${outcome.hygieneTotal} hygiene finding(s)`);
  console.log(
    `proposals: ${outcome.proposals.length} (${outcome.keptCount} kept)  refuter: ${outcome.refuterRan ? "ran" : "absent"}`,
  );
  if (outcome.skippedReview.length > 0) {
    console.log(`not reviewed (too large for the refuter prompt cap): proposal ${outcome.skippedReview.join(", proposal ")}`);
  }
  if (outcome.lockNote) console.log(`lock: ${outcome.lockNote}`);
  if (!args.apply) {
    console.log("applied: nothing (report-only run; re-run with --apply to execute kept proposals)");
  } else if (!outcome.refuterRan) {
    console.log("applied: nothing (the refuter was absent, and unreviewed dreams are never applied)");
  } else {
    console.log(`applied: ${appliedOk} change(s)`);
    for (const a of outcome.applied) console.log(`  ${a.ok ? "ok " : "FAIL"} ${a.description}`);
  }
  if (commit) console.log(`commit: ${commit.note}`);
  console.log(`report: ${outcome.reportFile}`);
}

async function cmdHarvest(args: Args): Promise<void> {
  if (!fs.existsSync(args.dir)) fail(`no brain directory at ${args.dir} (run: cookbook-brain init)`);
  const { DEFAULT_SESSIONS_ROOT, buildHarvestDigest, harvest, harvestProposerPrompt, scanSessions } = await import("./harvest.ts");
  const { findClaudeBinary } = await import("./dream.ts");
  const sessionsRoot = args.sessions ? path.resolve(args.sessions) : DEFAULT_SESSIONS_ROOT;

  if (args.dryDigest) {
    // Trust feature: print exactly what would leave for the proposer model, make no calls.
    const scanned = scanSessions(sessionsRoot, { days: args.days, project: args.project });
    process.stdout.write(harvestProposerPrompt(buildHarvestDigest(scanned).text));
    return;
  }

  if (!findClaudeBinary()) {
    console.error(
      [
        "[cookbook-brain] harvest needs the Claude Code CLI: no `claude` binary was found on your PATH.",
        "Harvest reads your local session transcripts and sends compact digests to your own logged-in `claude`",
        "(install it from https://claude.com/claude-code, then run `claude` once to log in).",
        "cookbook-brain never reads or requires API keys, so there is nothing else to configure.",
      ].join("\n"),
    );
    process.exit(2);
  }

  const outcome = harvest({
    dir: args.dir,
    sessionsRoot,
    days: args.days,
    project: args.project,
    apply: args.apply,
    model: args.model,
    human: humanName(),
  });
  const appliedOk = outcome.applied.filter((a) => a.ok).length;

  if (args.json) {
    // machine-readable report on stdout, and nothing else
    process.stdout.write(
      JSON.stringify(
        {
          date: new Date().toISOString(),
          brain: args.dir,
          sessions_root: sessionsRoot,
          days: args.days,
          project: args.project ?? null,
          mode: args.apply ? "apply" : "report-only",
          sessions_scanned: outcome.sessionsScanned,
          sessions_digested: outcome.sessionsDigested,
          dropped_for_budget: outcome.droppedForBudget,
          proposals: outcome.proposals,
          invalid: outcome.invalid,
          deduped: outcome.deduped,
          refuter_ran: outcome.refuterRan,
          verdicts: outcome.verdicts,
          skipped_review: outcome.skippedReview,
          kept: outcome.keptCount,
          applied: outcome.applied,
          lock_note: outcome.lockNote,
          report_file: outcome.reportFile,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log(
    `cookbook-brain harvest: ${outcome.sessionsScanned} session(s) in the last ${args.days} day(s), ${outcome.sessionsDigested} digested` +
      (outcome.droppedForBudget.length > 0 ? `, ${outcome.droppedForBudget.length} dropped for the digest budget` : ""),
  );
  console.log(
    `proposals: ${outcome.proposals.length} (${outcome.keptCount} kept)  deduped: ${outcome.deduped.length}  refuter: ${outcome.refuterRan ? "ran" : "absent"}`,
  );
  if (outcome.skippedReview.length > 0) {
    console.log(`not reviewed (too large for the refuter prompt cap): proposal ${outcome.skippedReview.join(", proposal ")}`);
  }
  if (outcome.lockNote) console.log(`lock: ${outcome.lockNote}`);
  if (!args.apply) {
    console.log("applied: nothing (report-only run; re-run with --apply to write the kept notes)");
  } else if (!outcome.refuterRan) {
    console.log("applied: nothing (the refuter was absent, and unreviewed harvests are never applied)");
  } else {
    console.log(`applied: ${appliedOk} note(s)`);
    for (const a of outcome.applied) console.log(`  ${a.ok ? "ok " : "FAIL"} ${a.description}`);
  }
  console.log(`report: ${outcome.reportFile}`);
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
      cmdDoctor(args.dir, args.fixAliases);
      break;
    case "index":
      cmdIndex(args.dir);
      break;
    case "web":
      await cmdWeb(args);
      break;
    case "dream":
      await cmdDream(args);
      break;
    case "harvest":
      await cmdHarvest(args);
      break;
    case null:
      fail("no command given");
      break;
    default:
      fail(`unknown command: ${args.command}`);
  }
}

await main();
