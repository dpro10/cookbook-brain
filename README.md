# cookbook-brain

Give your agents a memory you own.

cookbook-brain stores what your agents learn as plain markdown files in a directory you commit next to your code. One note per file, typed and attributed, linked with wikilinks, never overwritten. Any MCP-speaking agent can remember and recall from it; you can read every byte with `cat` and review every change with `git diff`. There is no database, no embedding service, no cloud, and no lock-in: the format IS the export.

## Quickstart

```
npx cookbook-brain init
claude mcp add brain -- npx cookbook-brain serve
```

That creates a `./brain` directory (with a `SCHEMA.md` explaining the format to any human who wanders in) and hooks it up to Claude Code. From then on your agent can call `remember`, `recall`, `supersede`, and `search` as MCP tools. Other commands:

```
npx cookbook-brain log       # recent notes, newest first
npx cookbook-brain doctor    # validate every note, wikilink, and supersede chain
npx cookbook-brain serve --dir ../shared-brain   # serve a brain somewhere else
```

The brain directory resolves as `--dir` flag, then the `BRAIN_DIR` environment variable, then `./brain`. Human attribution comes from `BRAIN_HUMAN`, falling back to your OS username. Requires Node 20 or newer.

## The format

One note per file. A small frontmatter block, then markdown:

```markdown
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
```

Notes are typed (`decision`, `gotcha`, `convention`, `note`, `open_thread`) and attributed to a human plus, when an agent wrote it, the agent's label. Writing another note's title in `[[double brackets]]` links them: recall returns each note with its backlinks and the lines around the mention, so an agent sees how facts connect, not just which strings matched. Filenames are `<date>--<slug-of-title>.md`, so the directory reads like a journal.

## Never overwrite

The one rule of the format. Notes are never edited and never deleted. When a fact changes, the `supersede` tool writes a NEW note whose `supersedes` field points at the old id; the old file gains a single `superseded_by` field (the only mutation ever made to an existing file) and drops out of default recall. Nothing your team learned is ever silently rewritten. `git log` on the brain directory is the story of what your agents figured out, mistake by mistake, correction by correction, and `doctor` verifies the whole chain stays consistent.

## Confidence

Every recalled note carries a confidence score and a tier. In this release, confidence is a provenance cap:

| provenance | confidence | tier |
| --- | --- | --- |
| written by a human | 0.95 | standing |
| agent claim with a cited source (a `source:` line or a URL in the body) | 0.85 | standing |
| bare agent claim | 0.60 | verify |

`standing` notes can be relied on as-is; `verify` notes are unproven claims an agent should check before building on them. Notes also carry a `credits` count, incremented when a note rode into work that verifiably completed. The credits lift lands in the next release: verified use will raise confidence toward the cap, so notes that keep proving true rise, honestly earned. The response shape ships now so nothing breaks when the lift arrives.

## What it is not

- Not a vector database. Recall is substring match plus the link graph. At the scale of a project brain (hundreds of notes, not millions), grep-shaped recall you can reproduce by hand beats embeddings you cannot inspect.
- Not a note-taking app. Humans are welcome to write notes, but the tool descriptions, the attribution model, and the never-overwrite rule are all designed for agents writing under supervision.
- Not a sync service. Git is the sync. Branch it, merge it, review brain changes in pull requests like everything else.
- Not a context dump. The tools teach agents to keep notes atomic and cited; a brain full of pasted transcripts is a worse brain.

## Acknowledgments

Mem0, Zep, and Letta built the agent-memory category and proved agents with persistent memory outperform agents without it; Zep's temporal knowledge graphs in particular shaped how we think about provenance. QM showed how much demand there is for an open-source company-memory harness. cookbook-brain takes a narrower position than all of them: memory as files you own, in the repo you already version, with provenance you can audit line by line.

## Why we built this

[cookbook.team](https://cookbook.team) is a shared workspace where teams and their AI agents work as one, and the team's memory is typed, attributed, outcome-weighted, and cross-vendor. cookbook-brain is the single-player taste of that brain: the same note shapes, the same never-overwrite rule, on your own disk. When your brain needs to be shared by a whole team and credited by verified outcomes, that is what Cookbook is for.

MIT, copyright Diego Prozzi.
