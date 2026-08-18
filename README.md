# cookbook-brain

Give your agents a memory you own.

cookbook-brain stores what your AI agents learn as plain markdown files in a git repo on your disk. Claude Code, Codex, or any MCP client can remember, recall, and build on it: one brain, all of your agents. Your Claude and your Codex finally know the same things, and can even hand each other work. Every note says who wrote it, human or which agent. Nothing is ever overwritten. And notes earn trust the only way that means anything: by being right when real work depended on them.

Open the folder in Obsidian and you will see plain notes, because that is all it is.

## Quickstart

```
npx cookbook-brain init             # creates ./brain with a schema note
npx cookbook-brain harvest          # propose notes distilled from your recent Claude Code sessions
npx cookbook-brain harvest --apply  # write the proposals the refuter kept
claude mcp add brain -- npx cookbook-brain serve
```

Your brain starts full: before your first agent session ever connects, `harvest` reads your recent local Claude Code transcripts and distills the decisions, gotchas, and conventions already sitting in them into attributed notes (see "Harvest" below; it proposes only, until you say `--apply`).

Then tell your agent: "remember that the staging DB resets nightly" and it is saved, attributed, and recalled in every future session. That is the whole loop.

Other commands:

```
npx cookbook-brain log           # recent notes, newest first
npx cookbook-brain credit <id>   # credit notes whose facts held up in real work
npx cookbook-brain tasks         # open and claimed tasks, with age
npx cookbook-brain doctor        # validate every note, link, chain, and task
npx cookbook-brain migrate-filenames  # rename pre-0.7.1 date-slug files to title filenames
npx cookbook-brain index         # generate INDEX.md, a wikilinked view of the brain
npx cookbook-brain web           # read-only local viewer at http://127.0.0.1:4321
npx cookbook-brain install-hook  # every session harvests itself when it closes (report-only)
```

The brain directory resolves as `--dir` flag, then the `BRAIN_DIR` environment variable, then `./brain`. Human attribution comes from `BRAIN_HUMAN`, falling back to your OS username. Requires Node 20 or newer.

## Why files

Your agents' memory should not live in someone else's vector database. Files mean you can read every memory, diff every change, grep at 2am, back up with git, and leave any time by keeping your folder. Vendors change policies; markdown does not.

And no, there is no vector database underneath, for three concrete reasons. Embeddings need an API key and network calls, and this tool makes none: nothing leaves your disk. A vector index is opaque: you cannot grep it, diff it, or see why it returned what it did. And at the scale of a personal brain (hundreds of notes, not millions of documents), plain text search plus the link graph retrieves just as well. Vectors earn their complexity at corpus scale. This is not a corpus; it is a brain.

## The format

One note per file. Frontmatter carries the facts about the fact:

```markdown
---
id: 01J8ZQ4X2E5N9GVHBK3W7T1MCD
type: decision
title: Poll interval is 30s, not 10
aliases: ["Poll interval is 30s, not 10"]
author:
  human: diego
  agent: claude-code
created: 2026-08-18T17:20:00.000Z
supersedes: null
source: "https://status.example.com/limits"
credits: 3
last_credited: 2026-08-20T09:30:00.000Z
---
Free-tier endpoints rate-limit hard. At 10s we tripped limits on 3 of 8
targets. 30s stays under every limit tested. Related:
[[Unknown check state renders as degraded]]
```

Notes are typed (`decision`, `gotcha`, `convention`, `note`, `open_thread`, `task`) and attributed to a human plus, when an agent wrote it, the agent's label. The optional `source` field cites where a fact comes from (a URL, a file path, a ticket id); cited memory is auditable memory, and it earns a higher confidence cap. Every note also carries an `aliases` list holding its own title, which feeds Obsidian autocomplete and search (see "Using it with Obsidian" below). Wikilinks are the graph. Recall returns a note WITH its backlinks and the lines around each mention, so agents get connected context, not isolated facts. Recall also carries every active `convention` note verbatim, regardless of the query: standing rules ride along so agents apply them to all work, not just work that searched for them. Filenames ARE the titles (`Poll interval is 30s, not 10.md`), which is what lets Obsidian resolve `[[Title]]` wikilinks natively, and the directory reads like a list of what your agents know.

## Never overwrite

Updating a note creates a new note that supersedes the old one. The old file stays, marked superseded. Two reasons, both learned the hard way: every AI rewrite silently loses a little meaning, and you cannot debug a memory without its history. Your brain's git log is its audit trail.

Note bodies are append-only forever; exactly two counters may be stamped in place on an existing file: `credits` and `last_credited`, written when work that relied on a note verifiably completed. That credit pair is the second sanctioned mutation, alongside the `superseded_by` stamp. Task notes carry a third stamp set, on task-type notes only: `status`, `claimed_by`, `result`, and `abandon_reason`. Nothing else about an existing file is ever touched.

## Confidence: trust is earned, not asserted

Every recall carries a confidence score and a tier (proven / standing / verify). The formula is public and boring on purpose:

```
score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap)
```

- **Provenance caps the ceiling.** A human-written note caps at 0.95. An agent note citing a source (the `source` frontmatter field, a `source:` line, or a URL in the body): 0.85. An uncited agent claim: 0.60. No amount of repetition lifts a note past its cap.
- **Credits raise it.** A fresh uncredited note sits 0.10 under its cap. When work that recalled a note verifiably succeeds, `credit` the note (one CLI call, or let your agent do it on completion); each credit adds 0.05, and three earn the cap back.
- **Silence lowers it.** Staleness subtracts 0.05 per full 90 days since `last_credited` (or since `created`, if never credited), up to 0.15. A note nobody has credited in months decays toward "verify before trusting."

Scores round to two decimals. Tiers: `proven` means credited at least once AND scoring 0.80 or higher, so only notes that real completed work relied on can be proven. `standing` (0.60 or higher) can be relied on. Everything else is `verify`: check it before you build on it.

This is the part no other memory system ships: memory that answers not just "what did we say?" but "has this ever actually been right when it mattered?"

## Tasks: your agents can hand each other work

A task is just another note (type: task) with a status and an assignee:

```
"assign my codex a task: read docs/brief.md and draft the FAQ"
```

Your Claude writes the task note. The next time your Codex session starts and recalls the brain, the open task addressed to it is sitting there in the response's `open_tasks` section. It claims it, does the work, and completes it, and completion is where the loop closes: the completing agent records which notes it relied on (`helped_note_ids`), and those notes get credited. That is how memory earns its confidence without you ever running a bookkeeping command.

And when a claimed task turns out to be beyond an agent (missing access, repeated failures), it abandons the task instead of sitting on it: the task goes back to open with the reason recorded in `abandon_reason`, visible to the assigner and the next claimer. Failure visibility is a feature; a task that silently rots is worse than a task handed back loudly. The reason is cleared when someone claims the task next.

Honest mechanics: there is no background process. Assignment means the note waits in the folder until that agent's next session picks it up. Your agents coordinate through the brain the way a team coordinates through a whiteboard: nothing moves until someone walks past and reads it. For always-on claiming, live handoffs between people, and receipts with real cost attribution, that is the hosted product's job.

## Dreaming

Brains that only accumulate eventually silt up. `npx cookbook-brain dream` is the nightly consolidation pass: it merges duplicates, promotes twice-credited gotchas toward conventions, flags contradictions as open threads, and retitles colliding notes, with every proposal reviewed by an adversarial refuter before anything is applied. It runs on your own Claude CLI under your own login: cookbook-brain never holds an API key and makes no network calls of its own.

```
npx cookbook-brain dream               # report-only: propose and review, apply nothing
npx cookbook-brain dream --apply       # execute the proposals the refuter kept
npx cookbook-brain dream --apply --commit  # then git commit the brain directory (only paths under it)
npx cookbook-brain dream --json        # machine-readable report on stdout (report file still written)
npx cookbook-brain dream --dry-digest  # print exactly what would be sent to the model, then exit
npx cookbook-brain dream --model <id>  # pick the model; default is your claude setting
```

How a dream works, in order:

1. **Hygiene scan, no model.** A deterministic pass collects duplicate active titles, superseded notes still referenced by active wikilinks, and stale unproven notes (verify tier, older than 90 days). These findings seed the next step.
2. **Proposer.** One `claude -p` call sees a compact digest of your active notes (id, type, title, credits, age, first 280 characters of each body) and may propose operations from a closed set only: merge, promote, flag_contradiction, retitle_for_collision. Run `--dry-digest` first if you want to read exactly what leaves for the model; the refuter call additionally sends the full text of any note a proposal touches.
3. **Refuter.** A second `claude -p` call with fresh context and no memory of proposing reviews each proposal against the full text of its source notes, and must answer keep or reject with a reason. A proposal whose verdict cannot be parsed is rejected by default, never silently kept. If the refuter call itself fails or returns garbage, the whole dream is marked `refuter: absent` and nothing is applied, even with `--apply`. The report always distinguishes "no objections" from "the reviewer never showed". The refuter prompt is capped at 24,000 characters: when proposals plus their source notes would overflow it, the largest proposals are dropped from review, recorded as "not reviewed: too large", and never applied, because unreviewed proposals are never applied.
4. **Apply, only if you asked.** The default is report-only. With `--apply`, kept proposals execute reversibly: a merge writes one new note whose `consolidates` field lists the source ids and stamps each source `superseded_by`; a promotion does the same into a convention; a contradiction files an ordinary open_thread note (skipped when an active open_thread already references both notes, so the same conflict is never flagged twice); a retitle is a plain supersede. While it writes, the apply holds a `brain/.lock` file: MCP write tools wait it out, reads never block, and a lock older than ten minutes is stale (a crashed apply) and gets overridden with a warning. Undoing a dream is `git revert` on its commit, because a dream only ever adds files and stamps `superseded_by`. Add `--commit` and a successful apply commits the brain directory for you, touching only paths under it.

Every dream writes a report to `brain/dreams/DREAM_<date>.md` (a subdirectory the note scanner never reads): the digest stats, the hygiene findings, each proposal with its rationale, each refuter verdict with its reason, the mandatory `refuter: ran` or `refuter: absent` line, what was applied, and how to undo it.

One property worth noticing: notes a dream writes are authored `{ human: you, agent: "dream" }`, and the bare-agent provenance cap applies. The brain distrusts its own dreams until work proves them. A dream-merged note starts at low confidence like any other uncited agent claim, and only earns its way up by being right when real work depends on it.

### Nightly, if you want it

Dreams are designed to run while you sleep. A plain crontab line does it:

```
15 3 * * * cd /path/to/your/project && npx cookbook-brain dream >> brain/dreams/cron.log 2>&1
```

Leave off `--apply` and read the reports over coffee, or add it once you trust your refuter's taste. Either way, commit the brain afterwards so every dream is one revertable commit; `--apply --commit` does that commit for you.

## Harvest: your brain starts full

A new brain should not start empty while weeks of your real decisions sit in local session transcripts. `npx cookbook-brain harvest` reads your recent Claude Code sessions, distills them into atomic notes, and runs every proposal past the same adversarial refuter that reviews dreams. It is how a brain bootstraps on day one and how it tops up after a heavy week.

```
npx cookbook-brain harvest                  # report-only: propose notes from the last 7 days
npx cookbook-brain harvest --days 30        # scan further back
npx cookbook-brain harvest --project myapp  # only sessions whose working directory basename matches
npx cookbook-brain harvest --apply          # write the notes the refuter kept
npx cookbook-brain harvest --session <id> --since-last  # one session, only messages newer than its watermark
npx cookbook-brain harvest --dry-digest     # print exactly what would be sent to the model, then exit
npx cookbook-brain harvest --json           # machine-readable report on stdout (report file still written)
npx cookbook-brain harvest --sessions <path> --model <id>   # override the transcripts root and the model
```

Straight answers to the questions you should be asking:

- **What it reads.** Local Claude Code transcripts under `~/.claude/projects` (override with `--sessions`), from the last N days, and yes: it reads message CONTENT, the human's own messages and the assistant's main conclusions, because distilling content is the whole job. The window is applied per MESSAGE timestamp, so a session file you have kept alive for months contributes only its in-window messages, never its whole history. Tool traffic, subagent transcripts, and the tool's own `claude -p` runs (harvest and dream calls, detected by their prompt marker) are skipped. This is the deliberate opposite of metadata-only tools; it is stated here so you never discover it by surprise.
- **Where it sends it.** Compact per-session digests go to your own logged-in `claude` CLI, the same tool that produced the sessions in the first place. No API keys, no other network calls, nothing leaves your machine by any path your `claude` login does not already use. `--dry-digest` prints the exact outbound prompt.
- **What it writes.** Nothing, by default. A report at `brain/dreams/HARVEST_<date>.md` lists every proposal, every dedupe skip (facts the brain already holds), and every refuter verdict, including the mandatory `refuter: ran` or `refuter: absent` line; an unreviewed harvest applies nothing, even with `--apply`. Only `--apply` writes notes, and an applied harvest only adds new files, so undoing it is `git revert` or deleting the listed files.
- **The distrust property.** Harvested notes are authored `{ human: you, agent: "harvest" }`, and each body ends with a `source:` line citing its session with the actual message-date range of the digested slice (for example `source: session 2026-08-15, project cookbook-app`, or `source: session 2026-08-12 to 2026-08-18, project phonestack` for a long-lived session). That citation earns the sourced-agent confidence cap (0.85) through the ordinary source detection, nothing special-cased: the brain trusts its own bootstrap more than a bare claim, but less than you, until real work credits the notes upward.

Two flags make harvest surgical instead of sweeping. `--session <id>` harvests exactly one transcript (the day window still applies, defaulting to a generous 2 days in this mode). `--since-last` makes harvest incremental: it reads per-session watermarks from `brain/dreams/harvested.json` (a map of session id to the timestamp of the last message a harvest digested) and only digests messages newer than each watermark, so a session file you keep alive for months never re-digests old content. Every successful harvest, report-only included, advances the watermarks; a failed or unparseable model call advances nothing, so content is never silently lost. The file lives under `dreams/`, the note scanner never reads it, and deleting it just means the next harvest starts from the plain day window.

## Autoharvest: sessions that distill themselves

One command makes every Claude Code session harvest itself when it closes:

```
npx cookbook-brain install-hook
```

That registers a SessionEnd hook in `~/.claude/settings.json`, surgically: the file is parsed, exactly one entry is merged in, every other key and hook is preserved, and the command refuses to write at all if the file does not parse. From then on, whenever a session ends, the hook reads the SessionEnd payload, spawns a DETACHED background run of

```
cookbook-brain harvest --session <that session> --since-last --json
```

against the session's working directory, and exits immediately, so closing a session is never delayed. The `--since-last` watermark means a long-lived session is only ever digested incrementally: each close distills just what happened since the last harvest.

The straight answers, again:

- **Always report-only.** The hook cannot apply, by design and hard-coded: unattended writes to your memory need your eyes first. Kept proposals accumulate in the reports, and `cookbook-brain log` ends with a line like `2 harvest report(s) with unapplied keeps: review with cookbook-brain harvest --apply` whenever recent reports hold kept-but-unapplied notes. Review them over coffee and apply when you agree; dedupe keeps already-known facts from ever landing twice.
- **Where the output lives.** Each run appends its JSON report to `~/.cookbook-brain-autoharvest.log`, and the markdown report lands in `brain/dreams/HARVEST_<date>.md` like any harvest (the `web` viewer shows them too). The brain directory resolves from the session's own working directory (`./brain`, or `BRAIN_DIR`), so a session in a project without a brain just logs a polite failure and changes nothing.
- **The honest cost note.** A session close triggers up to two model calls (proposer and refuter) on your own `claude` CLI login. They run detached, so closing is instant, but they are real calls on your account. The mitigations are structural: a session with nothing new past its watermark exits before any model call, and the tool's own `claude -p` runs (harvest and dream calls) are detected by their prompt marker and skipped outright, so autoharvest never recurses on itself.
- **Undo is one command.** `npx cookbook-brain uninstall-hook` removes only the cookbook-brain entry and leaves every other setting and hook untouched. Sessions already running notice on their next restart, in both directions.

## What it is not

- Not a vector database (see "Why files" above; optional embeddings may come later, and will never be required).
- Not hosted. One brain, one owner, any number of YOUR agents.
- Not a chat log. It stores atomic, deliberate notes, not transcripts; even `harvest`, which reads your sessions, distills them into single-fact notes and never stores a transcript.

## Can my team share a brain?

You can share the repo the way you share any repo, and for two careful people that half-works. What breaks is what makes shared memory trustworthy: there is no live sync (you recall stale notes until someone pulls), concurrent writes mean merge conflicts, and nothing enforces attribution: anyone can edit any file, including its credits. A record that anyone can quietly rewrite is not a record.

Enforced attribution, live sync, atomic task claims, and receipts that credit memory across a whole team need a server that people cannot reach around. That is the product we sell: [cookbook.team](https://cookbook.team) is the multiplayer brain. This repo is the single-player one, and it is honestly excellent at that job.

## cookbook-brain and Obsidian

Your brain folder opens in Obsidian as a normal vault: the wikilinks light up, the graph view draws your agents' knowledge, backlinks just work. Obsidian is the best reader ever built for this format, and you should absolutely point it at your brain.

So what does this add that an Obsidian vault plus one of the existing vault MCP servers does not? Those servers open a door: the agent can read, edit, and delete your notes. This tool adds the discipline for what walks through it. Vault servers let an agent overwrite your note; here, every change is a new attributed note superseding the old one. Vault notes are all equally trusted forever; here, notes carry provenance and earn confidence from outcomes. And a vault has no idea which of your agents wrote what or how they hand off work; here, that is the whole point.

Obsidian is where you read your brain. cookbook-brain is what keeps your agents from wrecking it.

## Using it with Obsidian

### Open it as a vault

Open the brain directory (or any folder containing it) with Obsidian's "Open folder as vault". No plugins needed for the basics: wikilinks resolve, the graph view draws what your agents know, and backlinks just work.

### Why the links resolve: filenames are the titles

Note bodies link by title (`[[Poll interval is 30s]]`), and every note's filename IS its title (`Poll interval is 30s.md`), so Obsidian resolves those links natively. This is not a stylistic choice: Obsidian resolves raw wikilinks by filename only. Frontmatter aliases power autocomplete and search, not link resolution (we proved this empirically before switching conventions), so any scheme with slugged filenames leaves every `[[Title]]` link as a ghost node in the graph.

Titles are sanitized only where they must be: `/ \ : # ^ [ ] |` and control characters become hyphens; spaces, punctuation, and case survive. When two notes sanitize to the same filename, the newcomer gets a short id suffix like `Title (4x2xmc).md`. Every cookbook-brain tool still resolves that note by title, but a raw Obsidian `[[Title]]` click will land on the plain-named file, so `doctor` warns about suffixed files; retitle one of the pair if it bothers you. Titles that themselves contain characters like `:` can never match a filename in Obsidian, so keep titles filename-friendly.

### Migrating a pre-0.7.1 brain

Brains written before 0.7.1 have date-slug filenames (`2026-08-18--poll-interval-is-30s.md`), which Obsidian cannot resolve `[[Title]]` links to. One command fixes the whole directory:

```
npx cookbook-brain migrate-filenames
```

It renames every note file to the title convention with plain fs renames (git records renames; contents stay byte-identical), prints every `old -> new` pair, never overwrites (collisions get the id suffix), and regenerates `INDEX.md` if you have one. Reports and `harvested.json` under `dreams/` are logs, not notes, and are never touched.

### Aliases: autocomplete and search

Every note also carries its own title in the `aliases` frontmatter field, so Obsidian's autocomplete and quick switcher offer notes by title even mid-rename. Notes written by cookbook-brain 0.5 and earlier lack the field; `cookbook-brain doctor` warns about them, and

```
npx cookbook-brain doctor --fix-aliases
```

backfills `aliases: [<title>]` onto every active note missing it. That stamp is a sanctioned frontmatter addition, documented in SCHEMA.md alongside the supersede and credit stamps, and it never touches a body.

### Properties view

Obsidian reads the frontmatter as properties: open any note and you see `type`, `author`, `created`, `credits`, `last_credited`, and on tasks `status`, `assigned_to`, `claimed_by`, `result`. That makes Obsidian search and the properties panel a free query surface over the brain's metadata.

### The brain inside your vault

Already keep a vault? Put the brain in a subfolder of it and point the tools there:

```
npx cookbook-brain init --dir ~/Vault/brain
claude mcp add brain -- npx cookbook-brain serve --dir ~/Vault/brain
```

Your agents' memory then lives alongside your own notes, your vault notes can link into brain notes like any others, and `BRAIN_DIR` works the same way if you prefer an environment variable. The scanner only reads top-level `.md` files in that one folder, so the rest of your vault is never touched.

### Hand-editing

Your files, edit freely; the append-only discipline binds the agents' tools, not your hands. Fix a typo, reword a body, delete a note you never wanted: it is your brain. The never-overwrite rule exists so no AI quietly rewrites history, not to keep you out. After a bulk hand-edit, `cookbook-brain doctor` will tell you if anything broke a link, a supersede chain, or a task.

### Dataview snippets

These require the community Dataview plugin. Adjust `FROM "brain"` if your brain folder is named differently.

All credited decisions (the closest frontmatter-only proxy for the proven tier; the exact tier math needs the confidence formula, which `web` shows):

````
```dataview
TABLE credits, last_credited, author.agent AS agent
FROM "brain"
WHERE type = "decision" AND credits >= 1 AND !superseded_by
SORT credits DESC
```
````

Gotchas never credited (traps recorded but never yet confirmed by real work):

````
```dataview
TABLE created, author.agent AS agent
FROM "brain"
WHERE type = "gotcha" AND credits = 0 AND !superseded_by
SORT created ASC
```
````

Open tasks by assignee:

````
```dataview
TABLE assigned_to, abandon_reason, created
FROM "brain"
WHERE type = "task" AND status = "open" AND !superseded_by
SORT assigned_to ASC
```
````

### The homepage and the tier view

`npx cookbook-brain index` generates `INDEX.md` at the brain root: every active note as a wikilink, grouped by type with conventions first, each with its tier and credits. It makes a good vault homepage; it is a view, not a note, so regenerating overwrites it and the scanner ignores it. And for the one thing Obsidian does not show, the live confidence and tier math, run `npx cookbook-brain web`: a read-only viewer at `http://127.0.0.1:4321` with confidence bars, tier badges, the task board, and the dream and harvest reports.

## When your team is ready

Your brain and cookbook.team speak the same language: the same note types, the same tiers, the same source discipline, the same task verbs. So migration is one instruction to an agent connected to both: read every active note in my brain and remember it into my team workspace, same type, title, body, and source. Attribution carries. Your conventions start riding every teammate's recall the moment they land.

Credits do not migrate, deliberately: team confidence is earned from team outcomes, and imported claims start at cited-agent trust until the team's work proves them. The distrust-until-proven principle applies to migration itself.

Keep the brain after you upgrade. Many people will want both: the brain for personal context, the workspace for team context. They are altitudes, not rivals.

## Acknowledgments and the honest map

Mem0, Zep, and Letta are excellent hosted/infra memory layers with capabilities this tool does not have (managed scale, temporal graphs, enterprise features). QM ships scoped per-person memory for teams. cookbook-brain differs on three axes: your memory is files you own rather than rows in a service, every note is attributed and append-only, and confidence is earned from outcomes rather than asserted at write time. If you want a managed memory API, use them. If you want a brain you can read, use this.

## Why we built this

At [cookbook.team](https://cookbook.team) we build the multiplayer version: a shared workspace where a team's humans and agents work one board, share one brain, and every task files a receipt that credits the memory it used. cookbook-brain is that memory layer, single-player, free, yours. If your team ever wants the shared version, you know where the kitchen is.

MIT, copyright Diego Prozzi.
