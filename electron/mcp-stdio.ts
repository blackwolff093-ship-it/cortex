/**
 * CORTEX stdio MCP server — a thin stdio→HTTP proxy.
 *
 * Bundled to dist-electron/mcp-stdio.cjs and run under PLAIN NODE by MCP
 * clients (Claude Code, Claude Desktop):
 *   node dist-electron/mcp-stdio.cjs --agent claude
 *
 * It has NO database access — every tool call is forwarded to the embedded
 * REST API of the running CORTEX app (http://localhost:7777). Must never
 * import ./db or better-sqlite3.
 *
 * NOTHING may write to stdout except the MCP transport — use console.error.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, type CortexBackend } from './mcp-tools';

function parseAgentArg(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent' && argv[i + 1]) return argv[i + 1];
    if (a.startsWith('--agent=') && a.length > '--agent='.length) return a.slice('--agent='.length);
  }
  return process.env.CORTEX_AGENT || 'agent';
}

const defaultAgent = parseAgentArg(process.argv.slice(2));
const base = `http://localhost:${process.env.CORTEX_PORT || 7777}`;

async function api(
  method: string,
  pathname: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown; agent?: string } = {}
): Promise<any> {
  const url = new URL(pathname, base);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  // Percent-encode: header values must be Latin1, but agent names can be
  // non-ASCII (e.g. --agent كلود). The server decodes in agentOf().
  const headers: Record<string, string> = {
    'X-Agent': encodeURIComponent(opts.agent || defaultAgent)
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause;
    const connectionFailure =
      cause?.code === 'ECONNREFUSED' ||
      cause?.code === 'ENOTFOUND' ||
      (err instanceof TypeError && /fetch failed/i.test(err.message));
    if (connectionFailure) {
      throw new Error(
        'CORTEX app is not running — tell the user to launch the CORTEX app, then retry.'
      );
    }
    throw err;
  }

  if (!res.ok) {
    let msg = '';
    try {
      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        msg = typeof parsed?.error === 'string' ? parsed.error : text;
      } catch {
        msg = text;
      }
    } catch {
      /* ignore body read errors */
    }
    throw new Error(`CORTEX API error (${res.status}): ${msg || res.statusText}`);
  }
  return res.json();
}

const httpBackend: CortexBackend = {
  listNotes: () => api('GET', '/api/notes'),
  readNote: (p) => api('GET', '/api/note', { query: { path: p } }),
  writeNote: (p, c, agent) =>
    api('PUT', '/api/note', { query: { path: p }, body: { content: c, agent }, agent }),
  appendNote: (p, c, agent) =>
    api('POST', '/api/note/append', { query: { path: p }, body: { content: c, agent }, agent }),
  deleteNote: async (p, agent) => {
    try {
      await api('DELETE', '/api/note', { query: { path: p, agent }, agent });
      return true;
    } catch (err) {
      if (err instanceof Error && /\(404\)/.test(err.message)) return false;
      throw err;
    }
  },
  search: (q) => api('GET', '/api/search', { query: { q } }),
  getTasks: () => api('GET', '/api/tasks'),
  addTask: (t) =>
    api('POST', '/api/tasks', {
      body: { text: t.text, assignee: t.assignee, status: t.status, project: t.project, agent: t.agent },
      agent: t.agent
    }),
  updateTask: (id, patch, agent) =>
    api('PATCH', '/api/task', {
      query: { id },
      body: { status: patch.status, assignee: patch.assignee, text: patch.text, project: patch.project, agent },
      agent
    }),
  deleteTask: async (id, agent) => {
    try {
      await api('DELETE', '/api/task', { query: { id, agent }, agent });
      return true;
    } catch (err) {
      if (err instanceof Error && /\(404\)/.test(err.message)) return false;
      throw err;
    }
  },
  getProtocol: () => api('GET', '/api/protocol'),
  addProtocol: (t) =>
    api('POST', '/api/protocol', {
      body: { kind: t.kind, title: t.title, body: t.body, agent: t.agent },
      agent: t.agent
    }),
  getActivity: (limit) =>
    api('GET', '/api/activity', { query: { limit: limit !== undefined ? String(limit) : undefined } }),
  log: (message, agent) => api('POST', '/api/log', { body: { message, agent }, agent }),
  findSimilar: (p) => api('GET', '/api/notes/similar', { query: { path: p } }),
  orchCreateTask: (t) =>
    api('POST', '/api/orchestrator/tasks', {
      body: {
        title: t.title,
        description: t.description,
        context_files: t.context_files,
        execution_mode: t.execution_mode,
        project: t.project,
        needs_planning: t.needs_planning,
        agent: t.agent
      },
      agent: t.agent
    }),
  orchClaimTask: (agentName, roleKey) =>
    api('POST', '/api/orchestrator/claim', {
      body: { agent_name: agentName, role_key: roleKey },
      agent: agentName
    }),
  orchWaitForTask: (agentName, roleKey, timeoutSeconds) =>
    api('POST', '/api/orchestrator/wait', {
      body: { agent_name: agentName, role_key: roleKey, timeout_seconds: timeoutSeconds },
      agent: agentName
    }),
  orchSubmitWork: (taskId, diff, summary, agent) =>
    api('POST', '/api/orchestrator/submit', {
      body: { task_id: taskId, diff_payload: diff, summary, agent },
      agent
    }),
  orchReviewTask: (taskId, verdict, feedback, agent) =>
    api('POST', '/api/orchestrator/review', {
      body: { task_id: taskId, status: verdict, feedback, agent },
      agent
    }),
  orchStatus: (agentName) =>
    api('GET', '/api/orchestrator/status', { query: { for: agentName }, agent: agentName }),
  orchGetTask: (taskId) => api('GET', '/api/orchestrator/task', { query: { id: String(taskId) } }),
  orchHeartbeat: (taskId, agent) =>
    api('POST', '/api/orchestrator/heartbeat', { body: { task_id: taskId, agent }, agent }),
  askLocalModel: async (prompt, context, model) => {
    const { text } = await api('POST', '/api/ai/ask', { body: { prompt, context, model } });
    return text;
  },
  listSkills: () => api('GET', '/api/skills'),
  getSkill: (name) => api('GET', '/api/skills/one', { query: { name } })
};

async function main(): Promise<void> {
  const server = await createMcpServer(defaultAgent, httpBackend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[cortex-mcp] stdio proxy connected as agent "${defaultAgent}" → ${base}`);
}

main().catch((err: unknown) => {
  console.error('[cortex-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
