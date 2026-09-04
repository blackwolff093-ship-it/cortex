# Contributing to CORTEX

Thanks for looking. This project genuinely needs help, and small PRs are as welcome as large ones.

## Setup

```bash
npm install
npm run dev      # Vite HMR + Electron
```

The app opens a window and an embedded server on `localhost:7777`. Your data lives in the OS
application-support directory; set `CORTEX_DB=/path/to/test.db` to work against a scratch database
instead.

## Before you open a PR

1. `npx tsc --noEmit -p tsconfig.json` must print nothing.
2. `npm run build` must succeed.
3. If you changed anything the UI renders, include a screenshot.

## Things that must not change

- The embedded server binds `127.0.0.1` only and validates the `Host` header. CORS reflects
  `localhost:7777` / `localhost:5173`, never `*`. This is what stops a hostile web page from reaching
  a user's vault.
- MCP is mounted **before** the JSON body parser in `electron/server.ts`. The SSE transport needs the
  raw stream; moving it breaks MCP silently.
- `electron/mcp-tools.ts` must not import `db` or `better-sqlite3` — it is bundled into
  `mcp-stdio.cjs`, which runs in plain Node outside the Electron ABI.

## Adding an MCP tool

Five places, in order:

1. Declare it on the `CortexBackend` type — `electron/mcp-tools.ts`
2. Register the tool and its schema in `createMcpServer` — `electron/mcp-tools.ts`
3. Implement the HTTP call in `httpBackend` — `electron/mcp-stdio.ts`
4. Implement the database logic in `dbBackend` — `electron/db.ts`
5. Add the REST route it maps to — `electron/server.ts`

## Adding a view

Four places: the `Route` type and `parseHash` in `src/lib/store.tsx`, the `MainView` switch in
`src/App.tsx`, and the `NAV` list in `src/components/Sidebar.tsx`.

## Adding an agent launcher

Implement `launch<Agent>(taskId, roleKey, rootDir, stdioPath)` returning
`{ ok, conversation_id?, error? }`, then route to it from `dispatchTask` in `electron/agentapi.ts`.
Read `electron/claude-launcher.ts` first — it shows the sandbox model a coding agent is expected to
follow, and why the launcher (not the agent) owns the diff and the submission.

## Code style

Match the file you are editing. Comments explain *why*, not *what*. The visual language is black
background, neon green, monospace, dense readouts — keep it.
