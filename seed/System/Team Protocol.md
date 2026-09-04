---
title: Team Protocol
tags: [team, protocol, rules]
---

# Team Protocol ═══

The rules everyone follows — you, [[Claude]] and [[ChatGPT]]. The goal: any agent that opens CORTEX
immediately knows where the work stands and what is expected of it, with nobody explaining.

## Task lifecycle

1. **Pick up** — the agent calls `cortex_get_tasks` and takes the first task assigned to it in **TODO**.
2. **Start** — moves it to **IN PROGRESS** and logs the start with `cortex_log`.
3. **Work** — implements, writes the output as a note in the project folder, and links it back.
4. **Hand off** — moves the task to **REVIEW** and records where the output lives.
5. **Review** — the reviewer checks it against the spec: passing goes to **DONE**, failing returns to **IN PROGRESS** with a precise reason.

## Review rules

- The reviewer never fixes the code itself — it describes the defect and returns the task.
- Every review note must be actionable: "field X has no validation", not "this is weak".
- Disagreement between implementer and reviewer is documented in [[Decisions]] for the human to settle.

## Where things live

| Thing | Where |
|---|---|
| Specs and requirements | A spec note in the project folder |
| Architecture decisions | [[Decisions]] — one dated line each |
| Persistent user context | [[General Context]] |
| Work output | Notes in the project folder, linked to the project note |

#team #protocol
