/**
 * cookbook-brain MCP server (stdio).
 *
 * Exposes the brain directory to any MCP client as ten tools: remember,
 * recall, supersede, search, credit, assign_task, list_tasks, claim_task,
 * complete_task, and abandon_task. Human attribution comes from the
 * BRAIN_HUMAN environment variable, falling back to the OS username.
 *
 * Write tools respect the brain lock a dream --apply holds while it writes;
 * reads never block on it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  NOTE_TYPES,
  abandonTask,
  activeConventions,
  assertNotLocked,
  assignTask,
  claimTask,
  completeTask,
  confidenceFor,
  createNote,
  creditNotes,
  humanName,
  listTasks,
  loadBrain,
  openTasksFor,
  recall,
  searchRanked,
  supersedeNote,
  type Note,
  type NoteType,
  type RecallOptions,
  type TaskFilter,
} from "./store.ts";

export { humanName };

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(e: unknown) {
  return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function taskView(t: Note, now: number = Date.now()) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    assigned_to: t.assigned_to ?? null,
    claimed_by: t.claimed_by ?? null,
    result: t.result ?? null,
    abandon_reason: t.abandon_reason ?? null,
    created: t.created,
    age_days: Math.max(0, Math.floor((now - Date.parse(t.created)) / DAY_MS)),
    instructions: t.body,
  };
}

const typeField = z
  .enum(NOTE_TYPES)
  .describe(
    "decision: a choice the team made and why. gotcha: a trap that cost time, so nobody pays for it twice. convention: a standing rule to follow. open_thread: an unresolved question. note: anything else worth keeping. task: work waiting for an agent (prefer the assign_task tool, which sets the lifecycle fields for you).",
  );

const agentLabelField = z
  .string()
  .optional()
  .describe(
    'Your agent name, e.g. "Claude Code". Always pass it when you are an agent writing on your own initiative. Omit it ONLY when you are transcribing words the human wrote themselves; human-authored notes carry more weight, so never claim that attribution for your own conclusions.',
  );

const requiredLabelField = z
  .string()
  .describe(
    'Your agent label, e.g. "claude-code" or "codex". Required: the task lifecycle records exactly who took and finished the work. Labels match case-insensitively.',
  );

const sourceField = z
  .string()
  .optional()
  .describe(
    "Where this fact comes from: a URL, file path, or ticket id. Cited memory is auditable memory: a note with a source earns the higher sourced confidence cap (0.85 instead of 0.60 for agent notes), and future readers can check the claim against its origin.",
  );

export function buildServer(dir: string, env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "cookbook-brain", version: "0.6.1" });

  server.registerTool(
    "remember",
    {
      title: "Remember a note in the brain",
      description:
        "Write one durable note to the team brain. Use this the moment you learn something worth keeping: a decision and its why, a gotcha that cost real time, a convention the team should follow, or an open thread. Keep notes ATOMIC (one fact per note) and cite your evidence in the `source` field (or a `source:` line or URL in the body); cited memory is auditable memory, and sourced notes earn higher recall confidence. Link related notes by writing their titles as [[wikilinks]] in the body. Do not remember secrets, transient state, or anything you could re-derive in seconds. To correct an existing note, use supersede instead of writing a near-duplicate.",
      inputSchema: {
        type: typeField,
        title: z.string().describe("Short, specific, and stable: other notes will link to this title with [[wikilinks]]."),
        body: z
          .string()
          .describe(
            "Markdown. Say what is true, why it matters, and how you know (source field, or a source: line or URL in the body). Reference related notes as [[Their Title]].",
          ),
        source: sourceField,
        agent_label: agentLabelField,
      },
    },
    async ({ type, title, body, source, agent_label }) => {
      try {
        assertNotLocked(dir);
        const note = createNote(dir, {
          type: type as NoteType,
          title,
          body,
          source,
          author: { human: humanName(env), agent: agent_label?.trim() || null },
        });
        return json({ id: note.id, type: note.type, title: note.title, author: note.author, created: note.created, file: note.file });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const confidenceExplainer =
    "Each note carries a confidence score and a tier. The formula: score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap), where cap is the provenance ceiling (human 0.95, agent with a cited source 0.85, bare agent claim 0.60) and staleness is 0.05 per full 90 uncredited days, max 0.15. Tiers: `proven` (credited at least once AND 0.80+) has been right when real work depended on it; `standing` (0.60+) can be relied on; `verify` notes should be checked before you build on them.";

  const recallDescription =
    "Read the team brain before you act. Returns active notes (superseded ones are excluded) matching the query by title or body, plus every note's backlinks with surrounding context so you see how facts connect. " +
    confidenceExplainer +
    " The response also carries `conventions`: EVERY active convention note, verbatim, regardless of your query; these are the team's standing rules, so apply these to your work. It also carries an `open_tasks` section: open tasks addressed to your agent_label (or to any agent), so pass your label and you will discover waiting work naturally. Call this at the start of a task, before making a decision the team may have already made, and before writing code in an area with known gotchas.";

  const runRecall = (opts: RecallOptions, agentLabel?: string | null) => {
    const brain = loadBrain(dir);
    const results = recall(brain, opts);
    const openTasks = openTasksFor(brain, agentLabel).map((t) => taskView(t));
    // conventions ride every recall verbatim: standing rules apply to all
    // work, not just work that happened to search for them
    const conventions = activeConventions(brain).map((n) => ({ id: n.id, title: n.title, body: n.body }));
    return json({ count: results.length, notes: results, conventions, open_tasks: openTasks });
  };

  server.registerTool(
    "recall",
    {
      title: "Recall notes from the brain",
      description: recallDescription,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring matched against titles and bodies. Omit to get every active note."),
        type: z.enum(NOTE_TYPES).optional().describe("Only return notes of this type."),
        agent_label: z
          .string()
          .optional()
          .describe(
            'Your agent label, e.g. "codex". Pass it so open tasks addressed to you appear in open_tasks; without it only unassigned tasks can surface.',
          ),
      },
    },
    async ({ query, type, agent_label }) => {
      try {
        return runRecall({ query, type: type as NoteType | undefined }, agent_label?.trim() || null);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "supersede",
    {
      title: "Supersede a note with a corrected one",
      description:
        "Replace a note that is wrong or outdated. The brain NEVER overwrites: this writes a new note whose `supersedes` field points at the old id, and the old note is kept on disk (marked superseded_by, excluded from recall) so history survives. Use this instead of remember when your new fact contradicts or updates an existing note; recall first to find the old note's id. State in the body what changed and why.",
      inputSchema: {
        old_id: z.string().describe("The id of the note being replaced (get it from recall)."),
        type: typeField,
        title: z.string().describe("Title for the replacement note. Keep the old title if the fact is the same, just corrected."),
        body: z.string().describe("Markdown. Include what changed since the old note and the evidence for the correction."),
        source: sourceField,
        agent_label: agentLabelField,
      },
    },
    async ({ old_id, type, title, body, source, agent_label }) => {
      try {
        assertNotLocked(dir);
        const { oldNote, newNote } = supersedeNote(dir, old_id, {
          type: type as NoteType,
          title,
          body,
          source,
          author: { human: humanName(env), agent: agent_label?.trim() || null },
        });
        return json({
          superseded: { id: oldNote.id, title: oldNote.title, superseded_by: oldNote.superseded_by },
          note: { id: newNote.id, type: newNote.type, title: newNote.title, supersedes: newNote.supersedes, file: newNote.file },
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search the brain (ranked)",
      description:
        "Ranked multi-term search over active notes. The query splits on whitespace; a term hitting a title scores 3, a term hitting a body scores 1, and each backlink adds 0.5, because a note the rest of the brain leans on is a better answer. Ties break by recency. Use search when you have keywords and want the best note first; use recall when you want everything matching an exact phrase, or the full active set. " +
        confidenceExplainer,
      inputSchema: {
        query: z.string().describe("One or more search terms, whitespace-separated. Each term matches titles and bodies case-insensitively."),
      },
    },
    async ({ query }) => {
      try {
        const results = searchRanked(loadBrain(dir), query);
        return json({ count: results.length, notes: results });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "credit",
    {
      title: "Credit notes that proved true in completed work",
      description:
        "Report that work which relied on these notes verifiably succeeded. Each note's `credits` counter is incremented and `last_credited` stamped, which raises its recall confidence toward its provenance cap (and uncredited notes decay over time, so crediting is how good notes stay trusted). " +
        confidenceExplainer +
        " Call this after you finish work that a recalled note made correct or faster; if you are completing a brain task, prefer complete_task with helped_note_ids, which credits for you. Do not credit notes you merely read: credit is for notes that were RIGHT when it mattered.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Note ids to credit (from recall or search)."),
        reason: z
          .string()
          .optional()
          .describe(
            "One line on what the work was and how the notes helped. Echoed back in the response for the transcript; NOT written to any file, so note bodies stay append-only.",
          ),
      },
    },
    async ({ ids, reason }) => {
      try {
        assertNotLocked(dir);
        const credited = creditNotes(dir, ids);
        return json({
          credited: credited.map((n) => ({
            id: n.id,
            title: n.title,
            credits: n.credits,
            last_credited: n.last_credited,
            confidence: confidenceFor(n),
          })),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "assign_task",
    {
      title: "Assign a task for an agent to pick up later",
      description:
        "Leave work waiting in the brain for another agent (or any agent). A task is just a note of type `task`: the instructions are the body, the lifecycle lives in frontmatter, and everything is a plain file you can read. Honest mechanics: there is no background process; the task waits in the folder until the addressed agent's next session recalls the brain and finds it in open_tasks. Write instructions a fresh session can act on without your context: name files, link relevant notes with [[wikilinks]], state what done looks like.",
      inputSchema: {
        title: z.string().describe("Short, specific task title, e.g. \"Draft the FAQ from docs/brief.md\"."),
        instructions: z
          .string()
          .describe("The task body: what to do, where the inputs live, what done looks like. Assume the reader has none of your context."),
        assigned_to: z
          .string()
          .optional()
          .describe('Agent label to address, e.g. "codex". Omit to let any agent take it. Labels match case-insensitively.'),
        source: sourceField,
        agent_label: agentLabelField,
      },
    },
    async ({ title, instructions, assigned_to, source, agent_label }) => {
      try {
        assertNotLocked(dir);
        const task = assignTask(dir, {
          title,
          instructions,
          assigned_to: assigned_to?.trim() || null,
          source,
          author: { human: humanName(env), agent: agent_label?.trim() || null },
        });
        return json({ task: taskView(task), file: task.file });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks in the brain",
      description:
        'List task notes. filter "mine" (the default): open tasks waiting for YOUR label, meaning assigned_to matches your agent_label or is null, so pass agent_label with it. filter "open": every unclaimed task. filter "all": every task including claimed and done. Tasks return oldest first: the queue reads front to back.',
      inputSchema: {
        filter: z
          .enum(["mine", "open", "all"])
          .optional()
          .describe('Defaults to "mine". mine: open tasks assigned to your label or unassigned. open: all unclaimed. all: every status.'),
        agent_label: agentLabelField,
      },
    },
    async ({ filter, agent_label }) => {
      try {
        const tasks = listTasks(loadBrain(dir), (filter ?? "mine") as TaskFilter, agent_label?.trim() || null);
        return json({ count: tasks.length, tasks: tasks.map((t) => taskView(t)) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim an open task",
      description:
        "Take an open task before working on it, so two agents never do the same work. Refuses if the task is already claimed or done, and refuses if the task is addressed to a different agent's label. Claiming stamps status + claimed_by on the task file; the instructions body is never touched. After claiming, do the work, then call complete_task.",
      inputSchema: {
        id: z.string().describe("The task's note id (from open_tasks in recall, or list_tasks)."),
        agent_label: requiredLabelField,
      },
    },
    async ({ id, agent_label }) => {
      try {
        assertNotLocked(dir);
        const task = claimTask(dir, id, agent_label);
        return json({ task: taskView(task) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "abandon_task",
    {
      title: "Abandon a claimed task, with the reason on the record",
      description:
        "Give up on a task you claimed but cannot complete (it needs tools or access you do not have, or repeated attempts failed). The task goes back to open with claimed_by cleared, so another agent can take it, and your reason is recorded on the task's abandon_reason field: always hand a task back loudly rather than leaving it to rot, because the assigner needs to know WHY it came back. Failure visibility is the point. Only the claimer may abandon; the reason is cleared when someone claims the task next.",
      inputSchema: {
        id: z.string().describe("The task's note id."),
        reason: z
          .string()
          .describe("Why you are handing the task back: what you tried, what blocked you, what the next claimer should know."),
        agent_label: requiredLabelField,
      },
    },
    async ({ id, reason, agent_label }) => {
      try {
        assertNotLocked(dir);
        const task = abandonTask(dir, id, reason, agent_label);
        return json({
          task: taskView(task),
          message: "Task returned to open with your reason on the record. Another agent can now claim it.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a task and credit the notes that helped",
      description:
        "Close the loop on a task: stamp it done with a short result string, and credit the brain notes that proved true along the way. Pass helped_note_ids with the ids of every note you recalled that was RIGHT and mattered to the outcome; each one is credited (credits + last_credited), which raises its recall confidence. This is how the brain's memory earns trust without anyone running a bookkeeping command. Refuses if the task is already done or claimed by someone else.",
      inputSchema: {
        id: z.string().describe("The task's note id."),
        result: z.string().describe("One or two sentences: what was done and where the output lives. Stamped on the task note."),
        helped_note_ids: z
          .array(z.string())
          .optional()
          .describe("Ids of notes that were correct and useful for this work. Each gets credited. Omit if nothing from the brain helped."),
        agent_label: requiredLabelField,
      },
    },
    async ({ id, result, helped_note_ids, agent_label }) => {
      try {
        assertNotLocked(dir);
        const task = completeTask(dir, id, result, agent_label);
        const helped = helped_note_ids ?? [];
        const credited = helped.length > 0 ? creditNotes(dir, helped) : [];
        return json({
          task: taskView(task),
          credited: credited.map((n) => ({ id: n.id, title: n.title, credits: n.credits, confidence: confidenceFor(n) })),
          message:
            credited.length > 0
              ? `Task done. Credited ${credited.length} note(s) that helped; their recall confidence just rose.`
              : "Task done. No notes credited: pass helped_note_ids next time if brain notes made the work correct or faster.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

export async function serve(dir: string): Promise<void> {
  const server = buildServer(dir);
  await server.connect(new StdioServerTransport());
  console.error(`[cookbook-brain] serving ${dir} over stdio (human: ${humanName()})`);
}
