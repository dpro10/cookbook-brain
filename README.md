# cookbook-brain

Give your agents a memory you own.

cookbook-brain stores what your AI agents learn as plain markdown files in a git repo on your disk. Claude Code, Codex, or any MCP client can remember, recall, and build on it: one brain, all of your agents. Your Claude and your Codex finally know the same things, and can even hand each other work. Every note says who wrote it, human or which agent. Nothing is ever overwritten. And notes earn trust the only way that means anything: by being right when real work depended on them.

Open the folder in Obsidian and you will see plain notes, because that is all it is.

## Quickstart

```
npx cookbook-brain init          # creates ./brain with a schema note
claude mcp add brain -- npx cookbook-brain serve
```

Then tell your agent: "remember that the staging DB resets nightly" and it is saved, attributed, and recalled in every future session. That is the whole loop.

Other commands:

```
npx cookbook-brain log           # recent notes, newest first
npx cookbook-brain credit <id>   # credit notes whose facts held up in real work
npx cookbook-brain tasks         # open and claimed tasks, with age
npx cookbook-brain doctor        # validate every note, link, chain, and task
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
author:
  human: diego
  agent: claude-code
created: 2026-08-18T17:20:00.000Z
supersedes: null
credits: 3
last_credited: 2026-08-20T09:30:00.000Z
---
Free-tier endpoints rate-limit hard. At 10s we tripped limits on 3 of 8
targets. 30s stays under every limit tested. Related:
[[Unknown check state renders as degraded]]
```

Notes are typed (`decision`, `gotcha`, `convention`, `note`, `open_thread`, `task`) and attributed to a human plus, when an agent wrote it, the agent's label. Wikilinks are the graph. Recall returns a note WITH its backlinks and the lines around each mention, so agents get connected context, not isolated facts. Filenames are `<date>--<slug-of-title>.md`, so the directory reads like a journal.

## Never overwrite

Updating a note creates a new note that supersedes the old one. The old file stays, marked superseded. Two reasons, both learned the hard way: every AI rewrite silently loses a little meaning, and you cannot debug a memory without its history. Your brain's git log is its audit trail.

Note bodies are append-only forever; exactly two counters may be stamped in place on an existing file: `credits` and `last_credited`, written when work that relied on a note verifiably completed. That credit pair is the second sanctioned mutation, alongside the `superseded_by` stamp. Task notes carry a third stamp set, on task-type notes only: `status`, `claimed_by`, and `result`. Nothing else about an existing file is ever touched.

## Confidence: trust is earned, not asserted

Every recall carries a confidence score and a tier (proven / standing / verify). The formula is public and boring on purpose:

```
score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap)
```

- **Provenance caps the ceiling.** A human-written note caps at 0.95. An agent note citing a source (a `source:` line or a URL in the body): 0.85. An uncited agent claim: 0.60. No amount of repetition lifts a note past its cap.
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

Honest mechanics: there is no background process. Assignment means the note waits in the folder until that agent's next session picks it up. Your agents coordinate through the brain the way a team coordinates through a whiteboard: nothing moves until someone walks past and reads it. For always-on claiming, live handoffs between people, and receipts with real cost attribution, that is the hosted product's job.

## Dreaming

`npx cookbook-brain dream` ships in the next release: a nightly consolidation pass that finds duplicates, proposes merges, promotes repeated gotchas toward conventions, and flags contradictions, with every proposal reviewed by an adversarial refuter before anything is applied. Applied changes will be supersede-only, so every dream stays reversible with git, and it will run on your own Claude CLI under your own login: cookbook-brain never holds an API key and makes no network calls of its own.

## What it is not

- Not a vector database (see "Why files" above; optional embeddings may come later, and will never be required).
- Not hosted. One brain, one owner, any number of YOUR agents.
- Not a chat log. It stores atomic, deliberate notes, not transcripts.

## Can my team share a brain?

You can share the repo the way you share any repo, and for two careful people that half-works. What breaks is what makes shared memory trustworthy: there is no live sync (you recall stale notes until someone pulls), concurrent writes mean merge conflicts, and nothing enforces attribution: anyone can edit any file, including its credits. A record that anyone can quietly rewrite is not a record.

Enforced attribution, live sync, atomic task claims, and receipts that credit memory across a whole team need a server that people cannot reach around. That is the product we sell: [cookbook.team](https://cookbook.team) is the multiplayer brain. This repo is the single-player one, and it is honestly excellent at that job.

## cookbook-brain and Obsidian

Your brain folder opens in Obsidian as a normal vault: the wikilinks light up, the graph view draws your agents' knowledge, backlinks just work. Obsidian is the best reader ever built for this format, and you should absolutely point it at your brain.

So what does this add that an Obsidian vault plus one of the existing vault MCP servers does not? Those servers open a door: the agent can read, edit, and delete your notes. This tool adds the discipline for what walks through it. Vault servers let an agent overwrite your note; here, every change is a new attributed note superseding the old one. Vault notes are all equally trusted forever; here, notes carry provenance and earn confidence from outcomes. And a vault has no idea which of your agents wrote what or how they hand off work; here, that is the whole point.

Obsidian is where you read your brain. cookbook-brain is what keeps your agents from wrecking it.

## Acknowledgments and the honest map

Mem0, Zep, and Letta are excellent hosted/infra memory layers with capabilities this tool does not have (managed scale, temporal graphs, enterprise features). QM ships scoped per-person memory for teams. cookbook-brain differs on three axes: your memory is files you own rather than rows in a service, every note is attributed and append-only, and confidence is earned from outcomes rather than asserted at write time. If you want a managed memory API, use them. If you want a brain you can read, use this.

## Why we built this

At [cookbook.team](https://cookbook.team) we build the multiplayer version: a shared workspace where a team's humans and agents work one board, share one brain, and every task files a receipt that credits the memory it used. cookbook-brain is that memory layer, single-player, free, yours. If your team ever wants the shared version, you know where the kitchen is.

MIT, copyright Diego Prozzi.
