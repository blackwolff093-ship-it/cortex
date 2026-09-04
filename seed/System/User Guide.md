---
title: User Guide
tags: [guide, start]
---

# User Guide //

Everything you need to work in CORTEX — you, or any agent on the team.

## Notes

- Every note is a Markdown file in the vault, like `Projects/Demo.md`.
- **NEW** creates a note, **EDIT** edits it, `Cmd+S` saves.

## Links `[[...]]`

Write `[[Decisions]]` and it becomes a link to the note titled Decisions.
A dashed red link means the note does not exist yet — click it and it is created instantly.
These links draw the **GRAPH**, so the more you link, the clearer the memory becomes.

## Task board

Four columns: **TODO** → **IN PROGRESS** → **REVIEW** → **DONE**.
Drag a card between columns, or let an agent move it itself.

## How agents connect

The app runs an embedded server on port `7777` exposing:

- **MCP** — tools like `cortex_read_note`, `cortex_write_note`, `cortex_get_tasks`.
- **REST API** — for any other tool, at `http://localhost:7777/api/...`.

Ready-made setup commands live on the **CONNECT** page. See [[Team Protocol]].

#guide #notes
