---
id: 01J8A000000000000000000003
type: note
title: Cache folder location
author:
  human: diego
  agent: Codex
created: 2026-08-03T09:15:00.000Z
supersedes: null
credits: 0
last_credited: null
---
The build cache lives in .cache/turbo at the repo root.
This follows from [[use PNPM everywhere]] since pnpm hoists differently.
Clearing it fixes most phantom build failures.
