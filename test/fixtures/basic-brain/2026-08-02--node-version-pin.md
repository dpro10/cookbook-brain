---
id: 01J8A000000000000000000002
type: gotcha
title: Node version pin
author:
  human: diego
  agent: Claude Code
created: 2026-08-02T11:30:00.000Z
supersedes: null
credits: 0
last_credited: null
---
CI runs Node 20 but local dev drifted to 22, which broke the sharp binary.
Pin the version in .nvmrc and engines.

source: https://github.com/lovell/sharp/issues/9999
