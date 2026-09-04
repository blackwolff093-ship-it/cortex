---
title: Decisions
tags: [decisions, log]
---

# Decision Log ═══

Every decision gets one clear line: date, decision, reason, and who made it.
Rule from [[Team Protocol]]: a decision not written here did not happen.

## 2026-08

- **2026-08-23 — The launcher owns the diff, not the agent.** An agent-reported diff can be denied, truncated or fabricated, and nothing downstream can tell. (Claude)
- **2026-08-21 — Coding agents run in an isolated sandbox.** The working tree is only touched after the build gate passes. (Claude)

## 2026-07

- **2026-07-09 — SQLite is the single source of truth.** Disk is a write-only mirror for Obsidian; it is never read back. (User)
- **2026-07-08 — CORTEX is the team memory.** No context in private chats — anything that matters becomes a note or a task. (User + [[Claude]])

> Format: `- **date — title.** Reason. (who)`

#decisions #log
