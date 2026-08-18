/**
 * cookbook-brain MCP server (stdio).
 *
 * Exposes the brain directory to any MCP client as four tools: remember,
 * recall, supersede, and search. Human attribution comes from the BRAIN_HUMAN
 * environment variable, falling back to the OS username.
 */
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  NOTE_TYPES,
  createNote,
  loadBrain,
  recall,
  supersedeNote,
  type NoteType,
  type RecallOptions,
} from "./store.ts";

export function humanName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BRAIN_HUMAN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(e: unknown) {
  return { content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true };
}

const typeField = z
  .enum(NOTE_TYPES)
  .describe(
    "decision: a choice the team made and why. gotcha: a trap that cost time, so nobody pays for it twice. convention: a standing rule to follow. open_thread: an unresolved question. note: anything else worth keeping.",
  );

const agentLabelField = z
  .string()
  .optional()
  .describe(
    'Your agent name, e.g. "Claude Code". Always pass it when you are an agent writing on your own initiative. Omit it ONLY when you are transcribing words the human wrote themselves; human-authored notes carry more weight, so never claim that attribution for your own conclusions.',
  );

export function buildServer(dir: string, env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "cookbook-brain", version: "0.1.0" });

  server.registerTool(
    "remember",
    {
      title: "Remember a note in the brain",
      description:
        "Write one durable note to the team brain. Use this the moment you learn something worth keeping: a decision and its why, a gotcha that cost real time, a convention the team should follow, or an open thread. Keep notes ATOMIC (one fact per note) and cite your evidence in the body with a `source:` line or a URL; sourced notes earn higher recall confidence. Link related notes by writing their titles as [[wikilinks]] in the body. Do not remember secrets, transient state, or anything you could re-derive in seconds. To correct an existing note, use supersede instead of writing a near-duplicate.",
      inputSchema: {
        type: typeField,
        title: z.string().describe("Short, specific, and stable: other notes will link to this title with [[wikilinks]]."),
        body: z
          .string()
          .describe(
            "Markdown. Say what is true, why it matters, and how you know (source: line or URL). Reference related notes as [[Their Title]].",
          ),
        agent_label: agentLabelField,
      },
    },
    async ({ type, title, body, agent_label }) => {
      try {
        const note = createNote(dir, {
          type: type as NoteType,
          title,
          body,
          author: { human: humanName(env), agent: agent_label?.trim() || null },
        });
        return json({ id: note.id, type: note.type, title: note.title, author: note.author, created: note.created, file: note.file });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const recallDescription =
    "Read the team brain before you act. Returns active notes (superseded ones are excluded) matching the query by title or body, plus every note's backlinks with surrounding context so you see how facts connect. Each note carries a confidence score and a tier: `standing` notes (0.85+) can be relied on as-is; `verify` notes are unproven agent claims, so check them before building on them. Confidence currently reflects provenance (human 0.95, sourced agent 0.85, bare agent claim 0.60); the credits field shows verified-use counts that will lift confidence in the next release. Call this at the start of a task, before making a decision the team may have already made, and before writing code in an area with known gotchas.";

  const runRecall = (opts: RecallOptions) => {
    const results = recall(loadBrain(dir), opts);
    return json({ count: results.length, notes: results });
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
      },
    },
    async ({ query, type }) => {
      try {
        return runRecall({ query, type: type as NoteType | undefined });
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
        agent_label: agentLabelField,
      },
    },
    async ({ old_id, type, title, body, agent_label }) => {
      try {
        const { oldNote, newNote } = supersedeNote(dir, old_id, {
          type: type as NoteType,
          title,
          body,
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
      title: "Search the brain",
      description:
        "Search active notes by a query string. Same results as recall with a query; kept as its own tool for clients that treat search as a distinct verb. " +
        recallDescription,
      inputSchema: {
        query: z.string().describe("Case-insensitive substring matched against titles and bodies."),
      },
    },
    async ({ query }) => {
      try {
        return runRecall({ query });
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
