/**
 * CORTEX MCP layer — tool definitions shared by the embedded HTTP endpoint (/mcp)
 * and the stdio proxy (mcp-stdio.ts).
 *
 * IMPORTANT: this file must NEVER import ./db or better-sqlite3 (directly or
 * transitively) — it is also bundled into mcp-stdio.cjs which runs under plain
 * node without the Electron ABI.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Express, Request, Response } from 'express';

export type CortexBackend = {
  listNotes(): any;
  readNote(p: string): any;
  writeNote(p: string, c: string, agent: string): any;
  appendNote(p: string, c: string, agent: string): any;
  deleteNote(p: string, agent: string): any;
  search(q: string): any;
  getTasks(): any;
  addTask(t: { text: string; assignee?: string; status?: string; project?: string; agent: string }): any;
  updateTask(
    id: string,
    patch: { status?: string; assignee?: string; text?: string; project?: string | null },
    agent: string
  ): any;
  deleteTask(id: string, agent: string): any;
  getProtocol(): any;
  addProtocol(t: { kind: string; title: string; body?: string; agent: string }): any;
  getActivity(limit?: number): any;
  log(message: string, agent: string): any;
  askLocalModel(prompt: string, context?: string, model?: string): any;
  findSimilar(path: string): any;
  orchCreateTask(t: {
    title: string;
    description: string;
    context_files?: string[];
    execution_mode?: string;
    project?: string;
    needs_planning?: boolean;
    agent: string;
  }): any;
  orchClaimTask(agentName: string, roleKey: string): any;
  orchWaitForTask(agentName: string, roleKey: string, timeoutSeconds: number): any;
  orchSubmitWork(taskId: number, diff: string, summary: string, agent: string): any;
  orchReviewTask(taskId: number, verdict: string, feedback: string, agent: string): any;
  orchStatus(agentName: string): any;
  orchGetTask(taskId: number): any;
  orchHeartbeat(taskId: number, agent: string): any;
  listSkills(): any;
  getSkill(name: string): any;
};

function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: 'ERROR: ' + msg }], isError: true };
}

const BASE_INSTRUCTIONS =
  'CORTEX is the shared memory of this team: a markdown notes vault, a kanban task board, an activity log, and a PROTOCOL of standing rules & skills — all used by the user and AI agents (Claude, ChatGPT) together. Read notes before answering questions about the team/projects; write notes to persist knowledge for others; log significant actions.';

/** Fold the team's enabled rules into the session instructions so every agent
 *  sees the standing stack/conventions the moment it connects — no repetition. */
async function buildInstructions(backend: CortexBackend): Promise<string> {
  try {
    const proto = await backend.getProtocol();
    const rules: Array<{ title: string; body: string; enabled: boolean }> = proto?.rules ?? [];
    const active = rules.filter((r) => r.enabled);
    
    let realSkillsCount = 0;
    try {
      const realSkills = await backend.listSkills();
      realSkillsCount = Array.isArray(realSkills) ? realSkills.length : 0;
    } catch(e) {}

    if (active.length === 0 && realSkillsCount === 0) return BASE_INSTRUCTIONS;
    
    const skills: Array<{ title: string }> = proto?.skills ?? [];
    const rulesText = active
      .map((r) => `### ${r.title}\n${(r.body ?? '').trim()}`.trim())
      .join('\n\n');
    const skillNote =
      skills.length > 0
        ? `\n\nThe team also has ${skills.length} reusable SKILL(s); call \`cortex_get_protocol\` to read them before building.`
        : '';
    const newSkillNote = realSkillsCount > 0
        ? `\n\nThe team also has ${realSkillsCount} reusable MCP SKILL(s); call \`cortex_list_skills\` to read them before building.`
        : '';
    return `${BASE_INSTRUCTIONS}\n\n## TEAM RULES — apply these before starting any work:\n${rulesText}${skillNote}${newSkillNote}`;
  } catch {
    return BASE_INSTRUCTIONS;
  }
}

export async function createMcpServer(defaultAgent: string, backend: CortexBackend): Promise<McpServer> {
  const server = new McpServer(
    { name: 'cortex', version: '1.0.0' },
    { instructions: await buildInstructions(backend) }
  );

  // Every tool accepts an optional `agent` string that overrides the default identity.
  const agentSchema = z
    .string()
    .optional()
    .describe('Identity to attribute this action to (e.g. "claude", "chatgpt"). Defaults to who you are configured as — usually leave it unset.');

  const who = (agent?: string): string => (agent && agent.trim() ? agent.trim() : defaultAgent);

  server.registerTool(
    'cortex_list_notes',
    {
      title: 'List CORTEX notes',
      description:
        "List every markdown note in CORTEX, the team's shared memory vault (path, title, tags, last-modified, size). Notes are shared between the user and all AI agents (Claude, ChatGPT). Call this first to see what shared knowledge already exists before reading or writing notes.",
      inputSchema: { agent: agentSchema }
    },
    async () => {
      try {
        return ok(await backend.listNotes());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_read_note',
    {
      title: 'Read a CORTEX note',
      description:
        'Read one markdown note from CORTEX, the team\'s shared memory vault, by its vault-relative path (e.g. "Projects/Viga.md"). Returns content, tags, outgoing [[wiki-links]] and backlinks (which notes reference this one) — follow those to gather related context.',
      inputSchema: {
        path: z.string().describe('Vault-relative note path, e.g. "Projects/Viga.md". Forward slashes; ".md" optional.'),
        agent: agentSchema
      }
    },
    async ({ path }) => {
      try {
        const note = await backend.readNote(path);
        if (note === null || note === undefined) {
          return { content: [{ type: 'text', text: 'ERROR: note not found: ' + path }], isError: true };
        }
        return ok(note);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_write_note',
    {
      title: 'Write a CORTEX note',
      description:
        "Write/update a markdown note in CORTEX, the team's shared memory vault. The user and other AI agents (Claude, ChatGPT) will see it immediately. Creates the note if it does not exist, otherwise REPLACES its full content (use cortex_append_note to add without overwriting). Use [[Note Title]] wiki-links to connect notes, and #tags to categorize. Notes may be in English or Arabic.",
      inputSchema: {
        path: z.string().describe('Vault-relative path like "Projects/Viga.md" (".md" is added if missing). Use folders to organize.'),
        content: z.string().describe('Full markdown content. Supports headings, task checkboxes "- [ ]", [[wiki-links]], #tags, and optional YAML frontmatter (title:, tags:).'),
        agent: agentSchema
      }
    },
    async ({ path, content, agent }) => {
      try {
        return ok(await backend.writeNote(path, content, who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_append_note',
    {
      title: 'Append to a CORTEX note',
      description:
        "Append markdown to the end of a note in CORTEX, the team's shared memory vault (creates the note if missing). Prefer this over cortex_write_note when adding updates, findings, or log entries so you never clobber what the user or other agents wrote.",
      inputSchema: {
        path: z.string().describe('Vault-relative note path, e.g. "Projects/Viga.md".'),
        content: z.string().describe('Markdown to append; it is added after a newline at the end of the note.'),
        agent: agentSchema
      }
    },
    async ({ path, content, agent }) => {
      try {
        return ok(await backend.appendNote(path, content, who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_delete_note',
    {
      title: 'Delete a CORTEX note',
      description:
        "Permanently delete a note from CORTEX, the team's shared memory vault. This removes it for the user and all AI agents and cannot be undone — only delete when clearly obsolete or when asked to.",
      inputSchema: {
        path: z.string().describe('Vault-relative path of the note to delete.'),
        agent: agentSchema
      }
    },
    async ({ path, agent }) => {
      try {
        const existed = await backend.deleteNote(path, who(agent));
        return ok({ deleted: !!existed, path });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_search',
    {
      title: 'Search CORTEX notes',
      description:
        "Search all notes in CORTEX, the team's shared memory vault. This is SEMANTIC search fused with keyword search (English and Arabic): it matches by MEANING, so a natural-language question finds the right note even when it shares no words with it. Ask it the way you would ask a person (\"how does login work?\") rather than guessing keywords — you will usually get the right note on the first call, which saves you reading the whole vault.",
      inputSchema: {
        query: z.string().describe('Search terms (plain words work best).'),
        agent: agentSchema
      }
    },
    async ({ query }) => {
      try {
        return ok(await backend.search(query));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_find_similar',
    {
      title: 'Find notes similar to one note',
      description:
        "Find the notes most semantically similar to a given note, each flagged with whether it is already [[wiki-linked]] from it. Use it to discover related context you would otherwise miss, to propose missing links, or to spot near-duplicate notes before creating another one.",
      inputSchema: {
        path: z.string().describe('Vault-relative note path, e.g. "Projects/VigaBank.md".'),
        agent: agentSchema
      }
    },
    async ({ path }) => {
      try {
        return ok(await backend.findSimilar(path));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_get_tasks',
    {
      title: 'Get the CORTEX kanban board',
      description:
        'Get the shared kanban task board: columns TODO, IN PROGRESS, REVIEW, DONE. Tasks are shared between the user and AI agents; the assignee field uses the @assignee convention ("claude", "chatgpt", "user"). Check for tasks assigned to you and update their status as you work.',
      inputSchema: { agent: agentSchema }
    },
    async () => {
      try {
        return ok(await backend.getTasks());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_add_task',
    {
      title: 'Add a CORTEX task',
      description:
        'Add a task card to the shared kanban board (columns: TODO, IN PROGRESS, REVIEW, DONE). Assign it to "claude", "chatgpt", or "user" so the right teammate — human or AI — picks it up. Tag it with a project so it shows up on that project\'s board in the CORTEX UI.',
      inputSchema: {
        text: z.string().describe('Task description (English or Arabic).'),
        assignee: z.string().optional().describe('Who should do it: "claude", "chatgpt", or "user". Omit for unassigned.'),
        status: z.string().optional().describe('Starting column: "TODO" (default), "IN PROGRESS", "REVIEW", or "DONE".'),
        project: z.string().optional().describe('Vault path of the Projects/*.md note this task belongs to, e.g. "Projects/VigaBank.md". Omit for a general task not tied to one project.'),
        agent: agentSchema
      }
    },
    async ({ text, assignee, status, project, agent }) => {
      try {
        return ok(await backend.addTask({ text, assignee, status, project, agent: who(agent) }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_update_task',
    {
      title: 'Update a CORTEX task',
      description:
        'Update a task on the shared kanban board by id: move it between columns (status "TODO" / "IN PROGRESS" / "REVIEW" / "DONE"), reassign it, rewrite its text, or retag its project. Move tasks you are working on to "IN PROGRESS" and finished ones to "REVIEW" or "DONE" so the user and other agents can follow progress.',
      inputSchema: {
        id: z.string().describe('Task id (shown on each card / returned by cortex_get_tasks).'),
        status: z.string().optional().describe('New column: "TODO", "IN PROGRESS", "REVIEW", or "DONE".'),
        assignee: z.string().optional().describe('New assignee: "claude", "chatgpt", or "user".'),
        text: z.string().optional().describe('New task text.'),
        project: z.string().optional().describe('Vault path of the Projects/*.md note to tag this task with, e.g. "Projects/VigaBank.md". Pass an empty string to untag it.'),
        agent: agentSchema
      }
    },
    async ({ id, status, assignee, text, project, agent }) => {
      try {
        return ok(await backend.updateTask(id, { status, assignee, text, project }, who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_delete_task',
    {
      title: 'Delete a CORTEX task',
      description:
        'Permanently remove a task from the shared kanban board by id. Use when a task is obsolete, a duplicate, or was created by mistake — not for finished work (move that to "DONE" with cortex_update_task instead).',
      inputSchema: {
        id: z.string().describe('Task id (shown on each card / returned by cortex_get_tasks).'),
        agent: agentSchema
      }
    },
    async ({ id, agent }) => {
      try {
        const deleted = await backend.deleteTask(id, who(agent));
        return ok({ deleted: !!deleted, id });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_get_protocol',
    {
      title: 'Get CORTEX rules, skills & project types',
      description:
        "Read the team's standing PROTOCOL: RULES (the required tech stack, conventions, and constraints to apply before any work), SKILLS (reusable playbooks), and TEMPLATES (project-type starter templates the user picks from when creating a new project). The active rules are already injected into your session instructions — call this to re-read them, consult a skill, or see how a given project type is set up.",
      inputSchema: { agent: agentSchema }
    },
    async () => {
      try {
        return ok(await backend.getProtocol());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_add_protocol',
    {
      title: 'Add a CORTEX rule or skill',
      description:
        'Add a new standing RULE or SKILL to the shared protocol. Use "rule" for a constraint/convention that should apply to all future work (it will be shown to every agent automatically), or "skill" for a reusable playbook. Propose these when the user establishes a durable preference; do not use for one-off task notes (use cortex_write_note instead).',
      inputSchema: {
        kind: z
          .enum(['rule', 'skill', 'template'])
          .describe('"rule" (a standing constraint shown to every agent), "skill" (a reusable playbook), or "template" (a new-project starter type).'),
        title: z.string().describe('Short title, e.g. "Default Stack", "Set up Supabase", or "Desktop App".'),
        body: z.string().optional().describe('Markdown body. For a template, this becomes the new project note (use {{name}} / {{date}} placeholders).'),
        agent: agentSchema
      }
    },
    async ({ kind, title, body, agent }) => {
      try {
        return ok(await backend.addProtocol({ kind, title, body, agent: who(agent) }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_get_activity',
    {
      title: 'Get CORTEX activity log',
      description:
        'Get the recent shared activity log — every note write, task change, and log message from the user and all AI agents, newest first. Use it to catch up on what the team did since you last looked.',
      inputSchema: {
        limit: z.number().int().positive().optional().describe('Max entries to return (default 100).'),
        agent: agentSchema
      }
    },
    async ({ limit }) => {
      try {
        return ok(await backend.getActivity(limit));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_log',
    {
      title: 'Log a message to CORTEX',
      description:
        "Post a short status message to CORTEX's shared activity log so the user and other AI agents see what you are doing (e.g. \"starting research on X\", \"finished draft, see [[Report]]\"). Use it for coordination — not for storing knowledge (use notes for that).",
      inputSchema: {
        message: z.string().describe('Short status/coordination message.'),
        agent: agentSchema
      }
    },
    async ({ message, agent }) => {
      try {
        return ok(await backend.log(message, who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_ask_local_model',
    {
      title: 'Ask the user\'s local AI model',
      description:
        "Delegate a sub-task to the model running INSIDE the CORTEX app (on-device, offline) — free, private, no API cost, and it doesn't spend your own context. Good for quick drafting, summarizing, brainstorming, or bulk text transforms. Less capable than you: offload grunt work to it, not decisions.",
      inputSchema: {
        prompt: z.string().describe('The task/question for the local model.'),
        context: z.string().optional().describe('Extra background text to include as system context (e.g. note content).'),
        model: z.string().optional().describe('Override the configured local model name (see CORTEX Connect tab for available models).'),
        agent: agentSchema
      }
    },
    async ({ prompt, context, model }) => {
      try {
        return ok(await backend.askLocalModel(prompt, context, model));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- Orchestrator pipeline ------------------------------------------------

  server.registerTool(
    'cortex_orchestrator_create_task',
    {
      title: 'Create an orchestrator pipeline task',
      description:
        "PLANNER ROLE. Break a goal into one discrete, implementable task and put it into the multi-agent pipeline. The task is dispatched to whichever agent is configured as the 'coder' role, then flows automatically through the optional Security and QA reviewers, and finally comes back to the planner for final approval. Create ONE task per unit of work — not one task for a whole project.",
      inputSchema: {
        title: z.string().describe('Short imperative title, e.g. "Add rate limiting to the login endpoint".'),
        description: z
          .string()
          .describe('What must be built and how it will be judged. The coder sees only this — include acceptance criteria.'),
        context_files: z
          .array(z.string())
          .optional()
          .describe('Repo-relative file paths the coder should start from, e.g. ["electron/server.ts"].'),
        execution_mode: z
          .enum(['auto', 'manual'])
          .optional()
          .describe('"auto" (default) flows between roles automatically; "manual" pauses at every hop until the user clicks to release it in the CORTEX UI.'),
        project: z.string().optional().describe('Optional vault path of a Projects/*.md note this belongs to.'),
        needs_planning: z
          .boolean()
          .optional()
          .describe('true = park it for the planner to break down first (use for a raw goal). Omit when YOU are the planner and have already broken it down — it then goes straight to the coder.'),
        agent: agentSchema
      }
    },
    async ({ title, description, context_files, execution_mode, project, needs_planning, agent }) => {
      try {
        return ok(
          await backend.orchCreateTask({
            title,
            description,
            context_files,
            execution_mode,
            project,
            needs_planning,
            agent: who(agent)
          })
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_claim_task',
    {
      title: 'Claim the next pipeline task for your role',
      description:
        "Take the next available task for a role you are assigned to. Returns the full task (description, context_files, the coder's diff_payload, and any reviewer feedback) or null when there is nothing waiting — null is normal, not an error. Claiming is atomic: no two agents can hold the same task. After claiming: if your role is 'coder', do the work and call cortex_orchestrator_submit_work; for 'security', 'qa' or 'planner', judge it and call cortex_orchestrator_review_task.",
      inputSchema: {
        role_key: z
          .enum(['planner', 'coder', 'security', 'qa'])
          .describe('The pipeline role you are acting as. You must be the agent assigned to it (see cortex_orchestrator_status).'),
        agent_name: z
          .string()
          .optional()
          .describe('Your agent name as configured for that role. Defaults to your own identity.'),
        agent: agentSchema
      }
    },
    async ({ role_key, agent_name, agent }) => {
      try {
        const r = await backend.orchClaimTask(agent_name || who(agent), role_key);
        if (!r || r.task === null || r.task === undefined) {
          const contended = r?.reason === 'contended';
          return ok({
            task: null,
            reason: r?.reason ?? 'empty',
            queued: r?.queued ?? 0,
            message: contended
              ? `Another agent claimed it first — ${r.queued} still queued, retry immediately.`
              : `No task is waiting for the "${role_key}" role right now.`
          });
        }
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_wait_for_task',
    {
      title: 'Wait for the next pipeline task',
      description:
        'Call this once and wait — DO NOT poll in a loop. Hangs until a task is available for your role, or the timeout expires. Returns the task immediately if one is already waiting. If it times out, you can call it again or do other work.',
      inputSchema: {
        role_key: z
          .enum(['planner', 'coder', 'security', 'qa'])
          .describe('The pipeline role you are acting as. You must be the agent assigned to it (see cortex_orchestrator_status).'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe('How long to wait. Defaults to 90.'),
        agent_name: z
          .string()
          .optional()
          .describe('Your agent name as configured for that role. Defaults to your own identity.'),
        agent: agentSchema
      }
    },
    async ({ role_key, timeout_seconds, agent_name, agent }) => {
      try {
        const r = await backend.orchWaitForTask(agent_name || who(agent), role_key, timeout_seconds ?? 90);
        if (!r || r.task === null || r.task === undefined) {
          return ok({
            task: null,
            reason: r?.reason ?? 'timeout'
          });
        }
        return ok(r);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_submit_work',
    {
      title: 'Submit implemented work to the pipeline',
      description:
        "CODER ROLE ONLY. Submit what you built for a task you have claimed. This advances the pipeline: to Security review if enabled, else QA if enabled, else back to the planner for final review — unless the task is gated, in which case it waits for the user. Put the actual change in diff_payload so reviewers can judge it without re-reading the repo.",
      inputSchema: {
        task_id: z.number().int().positive().describe('Task id returned by cortex_orchestrator_claim_task.'),
        diff_payload: z
          .string()
          .describe('The concrete output: a unified diff, the changed code, or the artifact you produced. Reviewers see this.'),
        summary: z.string().optional().describe('One or two lines on what you did and anything the reviewer should watch.'),
        agent: agentSchema
      }
    },
    async ({ task_id, diff_payload, summary, agent }) => {
      try {
        return ok(await backend.orchSubmitWork(task_id, diff_payload, summary ?? '', who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_review_task',
    {
      title: 'Approve or reject a pipeline task',
      description:
        "SECURITY / QA / PLANNER ROLES. Submit your verdict on a task you have claimed. APPROVED advances it to the next stage (and, from the planner, marks it COMPLETED). REJECTED sends it back to the coder with your feedback — feedback is REQUIRED when rejecting, and must say specifically what to change. A task rejected too many times is marked FAILED for the user to look at, so reject with actionable detail rather than repeatedly.",
      inputSchema: {
        task_id: z.number().int().positive().describe('Task id you claimed.'),
        status: z.enum(['APPROVED', 'REJECTED']).describe('Your verdict.'),
        feedback: z
          .string()
          .optional()
          .describe('Required when REJECTED: exactly what is wrong and what to change. Optional praise/notes when APPROVED.'),
        agent: agentSchema
      }
    },
    async ({ task_id, status, feedback, agent }) => {
      try {
        return ok(await backend.orchReviewTask(task_id, status, feedback ?? '', who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_status',
    {
      title: 'Inspect the orchestrator pipeline',
      description:
        'CALL THIS FIRST. Tells you who the pipeline thinks you are ("you"), exactly which roles you may claim ("your_roles"), how the pipeline is configured (enabled roles, assigned agents, auto vs manual hand-off), and every task in flight. You cannot guess your role_key — read it from your_roles.',
      inputSchema: { agent: agentSchema }
    },
    async ({ agent }) => {
      try {
        return ok(await backend.orchStatus(who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_get_task',
    {
      title: 'Read one pipeline task in full',
      description:
        "Read everything about a pipeline task: its description and acceptance criteria, the context files, the coder's submitted diff, the CURRENT feedback, and feedback_history — every verdict ever given on it, oldest first. Reviewers should read feedback_history before judging, so they do not repeat a demand that was already made, and coders should read it to see what has already been rejected.",
      inputSchema: {
        task_id: z.number().int().positive().describe('Task id.'),
        agent: agentSchema
      }
    },
    async ({ task_id }) => {
      try {
        const brief = await backend.orchGetTask(task_id);
        if (!brief) {
          return { content: [{ type: 'text', text: `ERROR: task #${task_id} not found` }], isError: true };
        }
        return ok(brief);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_orchestrator_heartbeat',
    {
      title: 'Keep your claim on a long task alive',
      description:
        'Refresh your claim on a task you are still working on. A claim goes stale after 30 minutes and another agent may then take the task, so call this periodically during long work — otherwise your submission can be rejected because you no longer hold the task.',
      inputSchema: {
        task_id: z.number().int().positive().describe('Task id you claimed.'),
        agent: agentSchema
      }
    },
    async ({ task_id, agent }) => {
      try {
        return ok(await backend.orchHeartbeat(task_id, who(agent)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_list_skills',
    {
      title: 'List available skills',
      description: 'List all enabled agent skills with their name, description, and status.',
      inputSchema: {}
    },
    async () => {
      try {
        return ok(await backend.listSkills());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    'cortex_get_skill',
    {
      title: 'Get a specific skill',
      description: 'Fetch the full body of a skill and its companion files by name.',
      inputSchema: {
        name: z.string().describe('Name of the skill to fetch.')
      }
    },
    async ({ name }) => {
      try {
        return ok(await backend.getSkill(name));
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

/**
 * Mount a STATELESS MCP Streamable HTTP endpoint at /mcp.
 * Must be mounted BEFORE express.json() — the transport reads the raw body stream.
 */
export function mountHttpMcp(app: Express, backend: CortexBackend): void {
  app.post('/mcp', (req: Request, res: Response) => {
    void (async () => {
      const server = await createMcpServer(process.env.CORTEX_AGENT || 'ai-agent', backend);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err: unknown) => {
      console.error('[cortex-mcp] /mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    });
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
