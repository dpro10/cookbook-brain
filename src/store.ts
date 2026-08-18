/**
 * cookbook-brain storage engine.
 *
 * A brain is a directory of markdown files, one note per file. Each file has
 * a small frontmatter block (hand-rolled parser, no YAML dependency) and a
 * markdown body. [[Wikilinks]] between note titles form the graph.
 *
 * The one rule: never overwrite. Updates create a new note whose
 * `supersedes` field points at the old id; the old file gains a
 * `superseded_by` field (the only frontmatter mutation this engine will
 * ever perform on an existing file).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NOTE_TYPES = ["decision", "gotcha", "convention", "note", "open_thread", "task"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const TASK_STATUSES = ["open", "claimed", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Author {
  human: string;
  /** null when the human wrote the note themselves */
  agent: string | null;
}

export interface Note {
  id: string;
  type: NoteType;
  title: string;
  author: Author;
  created: string;
  supersedes: string | null;
  /** present only on notes that have been superseded */
  superseded_by?: string;
  /**
   * present only on notes written by a dream merge or promotion: the ids of
   * the notes this one consolidated. Each consolidated note gets its
   * superseded_by stamped to point here. supersedes stays single-valued for
   * ordinary one-to-one edits.
   */
  consolidates?: string[];
  credits: number;
  last_credited: string | null;
  /** task notes only: open until claimed, claimed until done */
  status?: TaskStatus;
  /** task notes only: agent label the task is addressed to, or null meaning any agent may take it */
  assigned_to?: string | null;
  /** task notes only: agent label that claimed the task, or null while open */
  claimed_by?: string | null;
  /** task notes only: short outcome string stamped on completion, or null until done */
  result?: string | null;
  body: string;
  /** absolute path of the file this note was read from or written to */
  file: string;
}

export interface Backlink {
  id: string;
  title: string;
  type: NoteType;
  /** the lines around the [[wikilink]] mention in the linking note */
  context: string;
}

export interface RecallResult {
  id: string;
  type: NoteType;
  title: string;
  author: Author;
  created: string;
  credits: number;
  confidence: number;
  tier: Tier;
  body: string;
  backlinks: Backlink[];
}

export type Tier = "proven" | "standing" | "verify";

export interface BrainProblem {
  file: string;
  message: string;
}

export interface Brain {
  dir: string;
  notes: Note[];
  byId: Map<string, Note>;
  /** lowercased title -> note ids bearing that title */
  byTitle: Map<string, string[]>;
  problems: BrainProblem[];
}

// ---- ids ----

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 10 chars of millisecond timestamp + 16 chars of randomness, Crockford base32. Lexically sortable by creation time. */
export function ulid(now: number = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.randomBytes(16);
  let rs = "";
  for (let i = 0; i < 16; i++) rs += CROCKFORD[rand[i] % 32];
  return ts + rs;
}

// ---- frontmatter ----

/** Quote a scalar for frontmatter when it could confuse the parser; otherwise write it bare. */
function fmScalar(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (value === "" || /[:#"\[\]\n]|^\s|\s$|^null$|^\d+$/.test(value)) return JSON.stringify(value);
  return value;
}

function parseScalar(raw: string): string | null {
  const s = raw.trim();
  if (s === "null" || s === "") return null;
  if (s.startsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s;
    }
  }
  return s;
}

/** Parse a `[a, b, c]` frontmatter list. Returns null when the value is not bracketed. */
function parseList(raw: string): string[] | null {
  const s = raw.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return null;
  const inner = s.slice(1, -1).trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((part) => parseScalar(part) ?? "")
    .filter((v) => v !== "");
}

export function serializeNote(note: Omit<Note, "file">): string {
  const lines = [
    "---",
    `id: ${fmScalar(note.id)}`,
    `type: ${note.type}`,
    `title: ${fmScalar(note.title)}`,
    "author:",
    `  human: ${fmScalar(note.author.human)}`,
    `  agent: ${fmScalar(note.author.agent)}`,
    `created: ${note.created}`,
    `supersedes: ${fmScalar(note.supersedes)}`,
  ];
  if (note.consolidates !== undefined) lines.push(`consolidates: [${note.consolidates.map(fmScalar).join(", ")}]`);
  if (note.superseded_by !== undefined) lines.push(`superseded_by: ${fmScalar(note.superseded_by)}`);
  lines.push(`credits: ${note.credits}`);
  lines.push(`last_credited: ${fmScalar(note.last_credited)}`);
  if (note.type === "task") {
    lines.push(`status: ${note.status ?? "open"}`);
    lines.push(`assigned_to: ${fmScalar(note.assigned_to ?? null)}`);
    lines.push(`claimed_by: ${fmScalar(note.claimed_by ?? null)}`);
    lines.push(`result: ${fmScalar(note.result ?? null)}`);
  }
  lines.push("---", "");
  const body = note.body.replace(/\s+$/, "");
  return lines.join("\n") + body + "\n";
}

export interface ParsedFile {
  note?: Note;
  problems: string[];
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse one note file. Returns problems instead of throwing so `doctor` can report everything at once. */
export function parseNoteFile(file: string, content: string): ParsedFile {
  const problems: string[] = [];
  const lines = content.split("\n");
  if (lines[0] !== "---") return { problems: ["no frontmatter block (file must start with ---)"] };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { problems: ["unterminated frontmatter block (missing closing ---)"] };

  const fields = new Map<string, string>();
  let inAuthor = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (/^author:\s*$/.test(line)) {
      inAuthor = true;
      continue;
    }
    const indented = /^\s+/.test(line);
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
    if (!m) {
      problems.push(`unparseable frontmatter line ${i + 1}: ${line.trim()}`);
      continue;
    }
    if (indented && inAuthor) {
      fields.set(`author.${m[2]}`, m[3]);
    } else {
      inAuthor = false;
      fields.set(m[2], m[3]);
    }
  }

  const get = (k: string) => (fields.has(k) ? parseScalar(fields.get(k)!) : undefined);

  const id = get("id");
  if (!id) problems.push("missing id");
  const type = get("type");
  if (!type || !NOTE_TYPES.includes(type as NoteType)) {
    problems.push(`invalid type: ${type ?? "(missing)"} (expected one of ${NOTE_TYPES.join(", ")})`);
  }
  const title = get("title");
  if (!title) problems.push("missing title");
  const human = get("author.human");
  if (human === undefined) problems.push("missing author.human");
  const agent = fields.has("author.agent") ? get("author.agent") : undefined;
  if (agent === undefined) problems.push("missing author.agent (use null for human-written notes)");
  const created = get("created");
  if (!created || !ISO_RE.test(created)) problems.push(`created is not an ISO timestamp: ${created ?? "(missing)"}`);
  const supersedes = fields.has("supersedes") ? get("supersedes") : undefined;
  if (supersedes === undefined) problems.push("missing supersedes (use null for original notes)");
  const supersededBy = fields.has("superseded_by") ? get("superseded_by") : undefined;
  let consolidates: string[] | undefined;
  if (fields.has("consolidates")) {
    const list = parseList(fields.get("consolidates")!);
    if (list === null) {
      problems.push(`consolidates is not a [bracketed] list of note ids: ${fields.get("consolidates")!.trim()}`);
    } else if (list.length === 0) {
      problems.push("consolidates must list at least one note id");
    } else {
      consolidates = list;
    }
  }
  const creditsRaw = get("credits");
  const credits = creditsRaw === null || creditsRaw === undefined ? NaN : Number(creditsRaw);
  if (!Number.isInteger(credits) || credits < 0) {
    problems.push(`credits is not a non-negative integer: ${creditsRaw ?? "(missing)"}`);
  }
  const lastCredited = fields.has("last_credited") ? get("last_credited") : undefined;
  if (lastCredited === undefined) problems.push("missing last_credited (use null when never credited)");
  else if (lastCredited !== null && !ISO_RE.test(lastCredited)) {
    problems.push(`last_credited is not an ISO timestamp: ${lastCredited}`);
  }

  let status: TaskStatus | undefined;
  let assignedTo: string | null | undefined;
  let claimedBy: string | null | undefined;
  let result: string | null | undefined;
  if (type === "task") {
    const statusRaw = get("status");
    if (!statusRaw || !TASK_STATUSES.includes(statusRaw as TaskStatus)) {
      problems.push(`invalid task status: ${statusRaw ?? "(missing)"} (expected one of ${TASK_STATUSES.join(", ")})`);
    } else {
      status = statusRaw as TaskStatus;
    }
    assignedTo = fields.has("assigned_to") ? get("assigned_to") : undefined;
    if (assignedTo === undefined) problems.push("missing assigned_to (use null when any agent may take the task)");
    claimedBy = fields.has("claimed_by") ? get("claimed_by") : undefined;
    if (claimedBy === undefined) problems.push("missing claimed_by (use null while the task is open)");
    result = fields.has("result") ? get("result") : undefined;
    if (result === undefined) problems.push("missing result (use null until the task is done)");
  }

  if (problems.length > 0) return { problems };

  const note: Note = {
    id: id!,
    type: type as NoteType,
    title: title!,
    author: { human: human ?? "", agent: agent ?? null },
    created: created!,
    supersedes: supersedes ?? null,
    credits,
    last_credited: lastCredited ?? null,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, ""),
    file,
  };
  if (supersededBy != null) note.superseded_by = supersededBy;
  if (consolidates !== undefined) note.consolidates = consolidates;
  if (type === "task") {
    note.status = status;
    note.assigned_to = assignedTo ?? null;
    note.claimed_by = claimedBy ?? null;
    note.result = result ?? null;
  }
  return { note, problems: [] };
}

// ---- filenames ----

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export function noteFilename(created: string, title: string): string {
  return `${created.slice(0, 10)}--${slugify(title)}.md`;
}

// ---- scanning ----

/** Files in the brain dir that are notes: every top-level .md except SCHEMA.md and README.md. */
export function listNoteFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "SCHEMA.md" && f !== "README.md")
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadBrain(dir: string): Brain {
  const notes: Note[] = [];
  const problems: BrainProblem[] = [];
  for (const file of listNoteFiles(dir)) {
    const parsed = parseNoteFile(file, fs.readFileSync(file, "utf8"));
    for (const p of parsed.problems) problems.push({ file, message: p });
    if (parsed.note) notes.push(parsed.note);
  }
  notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map<string, Note>();
  for (const n of notes) {
    if (byId.has(n.id)) problems.push({ file: n.file, message: `duplicate id ${n.id} (also in ${byId.get(n.id)!.file})` });
    else byId.set(n.id, n);
  }
  const byTitle = new Map<string, string[]>();
  for (const n of notes) {
    const key = n.title.toLowerCase();
    const ids = byTitle.get(key) ?? [];
    ids.push(n.id);
    byTitle.set(key, ids);
  }
  return { dir, notes, byId, byTitle, problems };
}

/** Notes that have not been superseded. Default recall works over these only. */
export function activeNotes(brain: Brain): Note[] {
  return brain.notes.filter((n) => n.superseded_by === undefined);
}

// ---- writing ----

export interface CreateInput {
  type: NoteType;
  title: string;
  body: string;
  author: Author;
  supersedes?: string | null;
  /** dream merge/promote notes only: ids of the notes being consolidated */
  consolidates?: string[];
  created?: string;
  id?: string;
  /** task notes only */
  assigned_to?: string | null;
}

export function createNote(dir: string, input: CreateInput): Note {
  if (!NOTE_TYPES.includes(input.type)) {
    throw new Error(`invalid type: ${input.type} (expected one of ${NOTE_TYPES.join(", ")})`);
  }
  if (!input.title.trim()) throw new Error("title must not be empty");
  fs.mkdirSync(dir, { recursive: true });
  const created = input.created ?? new Date().toISOString();
  const note: Omit<Note, "file"> = {
    id: input.id ?? ulid(),
    type: input.type,
    title: input.title.trim(),
    author: input.author,
    created,
    supersedes: input.supersedes ?? null,
    credits: 0,
    last_credited: null,
    body: input.body.trim(),
  };
  if (input.consolidates !== undefined) {
    if (input.consolidates.length === 0) throw new Error("consolidates must list at least one note id");
    note.consolidates = [...input.consolidates];
  }
  if (input.type === "task") {
    note.status = "open";
    note.assigned_to = input.assigned_to?.trim() || null;
    note.claimed_by = null;
    note.result = null;
  }
  let file = path.join(dir, noteFilename(created, note.title));
  if (fs.existsSync(file)) {
    // Same day + same slug: disambiguate with the id's random tail, still never overwriting.
    file = path.join(dir, `${created.slice(0, 10)}--${slugify(note.title)}-${note.id.slice(-6).toLowerCase()}.md`);
  }
  fs.writeFileSync(file, serializeNote(note), { flag: "wx" });
  return { ...note, file };
}

/**
 * Rewrite one existing note file with stamped frontmatter. Bodies are
 * append-only forever; this helper exists only for the three sanctioned
 * in-place stamps: superseded_by, the credit counters (credits +
 * last_credited), and the task lifecycle fields (status, claimed_by, result)
 * on task-type notes.
 */
function stampNote(note: Note): Note {
  const { file: _f, ...rest } = note;
  fs.writeFileSync(note.file, serializeNote(rest));
  return note;
}

/**
 * Supersede: create the replacement note, then stamp `superseded_by` on the
 * old file. The old note's body and every other field are untouched.
 */
export function supersedeNote(
  dir: string,
  oldId: string,
  input: Omit<CreateInput, "supersedes">,
): { oldNote: Note; newNote: Note } {
  const brain = loadBrain(dir);
  const oldNote = brain.byId.get(oldId);
  if (!oldNote) throw new Error(`no note with id ${oldId} in ${dir}`);
  if (oldNote.superseded_by !== undefined) {
    throw new Error(`note ${oldId} is already superseded by ${oldNote.superseded_by}`);
  }
  const newNote = createNote(dir, { ...input, supersedes: oldId });
  const stamped = stampNote({ ...oldNote, superseded_by: newNote.id });
  return { oldNote: stamped, newNote };
}

/**
 * Consolidate: write one new note whose `consolidates` field lists the source
 * ids, then stamp `superseded_by` on every source pointing at the new note.
 * This is how dream merges and promotions stay reversible: the sources keep
 * their bodies forever, and the only mutation is the sanctioned
 * superseded_by stamp. All sources are validated before anything is written,
 * so a bad id consolidates nothing.
 */
export function consolidateNotes(
  dir: string,
  sourceIds: string[],
  input: Omit<CreateInput, "supersedes" | "consolidates">,
): { sources: Note[]; newNote: Note } {
  if (sourceIds.length === 0) throw new Error("consolidate requires at least one source note id");
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("consolidate source ids must be distinct");
  const brain = loadBrain(dir);
  const sources: Note[] = [];
  for (const id of sourceIds) {
    const note = brain.byId.get(id);
    if (!note) throw new Error(`no note with id ${id} in ${dir} (nothing was consolidated)`);
    if (note.superseded_by !== undefined) {
      throw new Error(`note ${id} is already superseded by ${note.superseded_by} (nothing was consolidated)`);
    }
    sources.push(note);
  }
  const newNote = createNote(dir, { ...input, consolidates: [...sourceIds] });
  const stamped = sources.map((n) => stampNote({ ...n, superseded_by: newNote.id }));
  return { sources: stamped, newNote };
}

// ---- crediting ----

/**
 * Credit notes that verifiably helped completed work: increment `credits`
 * and stamp `last_credited` on each file, in place. This is the second
 * sanctioned mutation of an existing file (superseded_by is the first);
 * bodies are never touched. All ids are validated before any file is
 * stamped, so a bad id credits nothing.
 */
export function creditNotes(dir: string, ids: string[], now: string = new Date().toISOString()): Note[] {
  if (ids.length === 0) throw new Error("credit requires at least one note id");
  const brain = loadBrain(dir);
  const targets: Note[] = [];
  for (const id of ids) {
    const note = brain.byId.get(id);
    if (!note) throw new Error(`no note with id ${id} in ${dir} (nothing was credited)`);
    targets.push(note);
  }
  return targets.map((note) => stampNote({ ...note, credits: note.credits + 1, last_credited: now }));
}

// ---- tasks ----

export interface AssignTaskInput {
  title: string;
  /** the task body: what to do, in enough detail for a fresh session */
  instructions: string;
  /** agent label to address, or null/omitted so any agent may take it */
  assigned_to?: string | null;
  author: Author;
  created?: string;
  id?: string;
}

/** Agent labels match case-insensitively, so "Codex" and "codex" are the same worker. */
function labelsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A task note is just a note of type "task": same file format, same rules, plus lifecycle fields. */
export function assignTask(dir: string, input: AssignTaskInput): Note {
  return createNote(dir, {
    type: "task",
    title: input.title,
    body: input.instructions,
    author: input.author,
    assigned_to: input.assigned_to ?? null,
    created: input.created,
    id: input.id,
  });
}

function getTask(brain: Brain, id: string): Note {
  const note = brain.byId.get(id);
  if (!note) throw new Error(`no note with id ${id} in ${brain.dir}`);
  if (note.type !== "task") throw new Error(`note ${id} is a ${note.type}, not a task`);
  if (note.superseded_by !== undefined) throw new Error(`task ${id} has been superseded by ${note.superseded_by}`);
  return note;
}

/**
 * Claim an open task. Refuses if the task is already claimed or done, and
 * refuses a claim by an agent the task was not addressed to (assigned_to
 * null means anyone may claim). Stamps status + claimed_by in place.
 */
export function claimTask(dir: string, id: string, claimedBy: string): Note {
  const label = claimedBy.trim();
  if (!label) throw new Error("claim requires the claiming agent's label");
  const task = getTask(loadBrain(dir), id);
  if (task.status === "done") throw new Error(`task ${id} is already done (result: ${task.result ?? "none"})`);
  if (task.status === "claimed") throw new Error(`task ${id} is already claimed by ${task.claimed_by}`);
  if (task.assigned_to !== null && !labelsMatch(task.assigned_to, label)) {
    throw new Error(`task ${id} is assigned to ${task.assigned_to}, not ${label}`);
  }
  return stampNote({ ...task, status: "claimed", claimed_by: label });
}

/**
 * Complete a task: stamp status done + the result string (and claimed_by,
 * when the task was completed straight from open). Refuses if the task is
 * already done, or if it is claimed by a different agent.
 */
export function completeTask(dir: string, id: string, result: string, completedBy: string): Note {
  const label = completedBy.trim();
  if (!label) throw new Error("complete requires the completing agent's label");
  if (!result.trim()) throw new Error("complete requires a short result string");
  const task = getTask(loadBrain(dir), id);
  if (task.status === "done") throw new Error(`task ${id} is already done (result: ${task.result ?? "none"})`);
  if (task.status === "claimed" && !labelsMatch(task.claimed_by, label)) {
    throw new Error(`task ${id} is claimed by ${task.claimed_by}, not ${label}`);
  }
  if (task.status === "open" && task.assigned_to !== null && !labelsMatch(task.assigned_to, label)) {
    throw new Error(`task ${id} is assigned to ${task.assigned_to}, not ${label}`);
  }
  return stampNote({ ...task, status: "done", claimed_by: task.claimed_by ?? label, result: result.trim() });
}

export type TaskFilter = "mine" | "open" | "all";

/** Active task notes, oldest first (a queue reads front to back). */
export function taskNotes(brain: Brain): Note[] {
  return activeNotes(brain).filter((n) => n.type === "task");
}

/**
 * List tasks. "open": every unclaimed task. "mine": open tasks waiting for
 * the given agent, meaning assigned_to matches its label or is null (anyone's
 * work is your work too). "all": every task regardless of status.
 */
export function listTasks(brain: Brain, filter: TaskFilter, agentLabel?: string | null): Note[] {
  const tasks = taskNotes(brain);
  if (filter === "all") return tasks;
  const open = tasks.filter((t) => t.status === "open");
  if (filter === "open") return open;
  return open.filter((t) => t.assigned_to === null || labelsMatch(t.assigned_to, agentLabel));
}

/**
 * The tasks an agent should discover on session start: open tasks addressed
 * to its label, plus unassigned open tasks. Without a label, only the
 * unassigned ones (we cannot know what is addressed to you if you do not
 * say who you are).
 */
export function openTasksFor(brain: Brain, agentLabel?: string | null): Note[] {
  return taskNotes(brain).filter(
    (t) => t.status === "open" && (t.assigned_to === null || labelsMatch(t.assigned_to, agentLabel)),
  );
}

// ---- wikilinks ----

const WIKILINK_RE = /\[\[([^\[\]\n]+)\]\]/g;

export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

/** Lines around the first [[title]] mention in a body: the matching line plus one line either side. */
export function linkContext(body: string, title: string): string {
  const lines = body.split("\n");
  const needle = title.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const hasLink = [...lines[i].matchAll(WIKILINK_RE)].some((m) => m[1].trim().toLowerCase() === needle);
    if (hasLink) {
      return lines
        .slice(Math.max(0, i - 1), i + 2)
        .join("\n")
        .trim();
    }
  }
  return "";
}

/**
 * Backlinks to a note: every ACTIVE note whose body wikilinks this note's
 * title (case-insensitive), with the surrounding context lines.
 */
export function backlinksFor(brain: Brain, note: Note): Backlink[] {
  const target = note.title.toLowerCase();
  const out: Backlink[] = [];
  for (const n of activeNotes(brain)) {
    if (n.id === note.id) continue;
    const links = extractWikilinks(n.body).map((t) => t.toLowerCase());
    if (links.includes(target)) {
      out.push({ id: n.id, title: n.title, type: n.type, context: linkContext(n.body, note.title) });
    }
  }
  return out;
}

// ---- confidence ----

const URL_RE = /https?:\/\/\S+/;
const SOURCE_LINE_RE = /^\s*source:\s*\S+/im;

/** A note counts as sourced when its body carries a `source:` line or a URL. */
export function isSourced(body: string): boolean {
  return SOURCE_LINE_RE.test(body) || URL_RE.test(body);
}

/** The provenance ceiling: human 0.95, agent with a cited source 0.85, bare agent claim 0.60. No amount of crediting lifts a note past its cap. */
export function capFor(note: Note): number {
  if (note.author.agent === null) return 0.95;
  return isSourced(note.body) ? 0.85 : 0.6;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 0.05 per full 90 days since last_credited (or created, if never credited), capped at 0.15. */
export function stalenessFor(note: Note, now: number = Date.now()): number {
  const basis = Date.parse(note.last_credited ?? note.created);
  if (Number.isNaN(basis)) return 0;
  const fullPeriods = Math.floor(Math.max(0, now - basis) / (90 * DAY_MS));
  return Math.min(0.05 * fullPeriods, 0.15);
}

/**
 * The confidence formula, public and boring on purpose:
 *
 *   score = clamp(cap - 0.10 + 0.05 * min(credits, 3) - staleness, 0.20, cap)
 *
 * where cap is the provenance cap (capFor), each credit lifts 0.05 up to
 * three, and staleness is 0.05 per full 90 uncredited days, max 0.15. A
 * fresh uncredited note sits 0.10 under its cap; three credits earn the cap
 * back; silence decays toward "verify before trusting". Scores are rounded
 * to two decimals.
 */
export function confidenceFor(note: Note, now: number = Date.now()): number {
  const cap = capFor(note);
  const raw = cap - 0.1 + 0.05 * Math.min(note.credits, 3) - stalenessFor(note, now);
  const clamped = Math.min(cap, Math.max(0.2, raw));
  return Math.round(clamped * 100) / 100;
}

/**
 * Tiers: "proven" needs at least one credit AND a score of 0.80+, so only
 * notes that real completed work relied on can be proven. "standing" is
 * 0.60+. Everything else is "verify": check before you build on it.
 */
export function tierFor(confidence: number, credits: number): Tier {
  if (credits >= 1 && confidence >= 0.8) return "proven";
  return confidence >= 0.6 ? "standing" : "verify";
}

// ---- recall ----

export interface RecallOptions {
  query?: string;
  type?: NoteType;
  /** injectable clock for hermetic tests; confidence decays with real time otherwise */
  now?: number;
}

function toResult(brain: Brain, n: Note, now: number): RecallResult {
  const confidence = confidenceFor(n, now);
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    author: n.author,
    created: n.created,
    credits: n.credits,
    confidence,
    tier: tierFor(confidence, n.credits),
    body: n.body,
    backlinks: backlinksFor(brain, n),
  };
}

/**
 * Recall over active notes: case-insensitive substring match on title or
 * body (no query returns everything active), optional type filter, newest
 * first, each result carrying confidence, tier, credits, and backlinks with
 * context.
 */
export function recall(brain: Brain, opts: RecallOptions = {}): RecallResult[] {
  const now = opts.now ?? Date.now();
  const q = opts.query?.trim().toLowerCase();
  let matched = activeNotes(brain);
  if (opts.type) matched = matched.filter((n) => n.type === opts.type);
  if (q) matched = matched.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
  matched = [...matched].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  return matched.map((n) => toResult(brain, n, now));
}

// ---- search ----

/**
 * Ranked multi-term search over active notes. The query splits on
 * whitespace; each term scores 3 when it appears in a title and 1 when it
 * appears in a body (substring, case-insensitive), and a note's backlink
 * count adds 0.5 per backlink, because a note the rest of the brain leans
 * on is a better answer. Ties break by recency. Notes matching no term are
 * excluded. Results carry the same shape as recall.
 */
export function searchRanked(brain: Brain, query: string, now: number = Date.now()): RecallResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { note: Note; result: RecallResult; score: number }[] = [];
  for (const n of activeNotes(brain)) {
    const title = n.title.toLowerCase();
    const body = n.body.toLowerCase();
    let hits = 0;
    for (const term of terms) {
      if (title.includes(term)) hits += 3;
      if (body.includes(term)) hits += 1;
    }
    if (hits === 0) continue;
    const result = toResult(brain, n, now);
    scored.push({ note: n, result, score: hits + 0.5 * result.backlinks.length });
  }
  scored.sort((a, b) => b.score - a.score || (a.note.id > b.note.id ? -1 : a.note.id < b.note.id ? 1 : 0));
  return scored.map((s) => s.result);
}

// ---- doctor ----

/**
 * Groups of ACTIVE notes sharing a title (case-insensitive), each group in id
 * order. These make wikilinks ambiguous; doctor reports them and dream's
 * hygiene pass seeds retitle/merge proposals from them.
 */
export function duplicateActiveTitleGroups(brain: Brain): Note[][] {
  const groups = new Map<string, Note[]>();
  for (const n of activeNotes(brain)) {
    const key = n.title.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Full validation pass: parse problems, broken wikilinks, dangling or
 * inconsistent supersedes/consolidates chains, task lifecycle consistency,
 * and duplicate active titles (which make wikilinks ambiguous).
 */
export function diagnose(dir: string): BrainProblem[] {
  const brain = loadBrain(dir);
  const problems = [...brain.problems];
  for (const group of duplicateActiveTitleGroups(brain)) {
    for (const n of group.slice(1)) {
      problems.push({
        file: n.file,
        message: `duplicate title "${n.title}" (also active in ${path.basename(group[0].file)}); wikilinks to it are ambiguous, consider supersede`,
      });
    }
  }
  for (const n of brain.notes) {
    if (n.type === "task") {
      if (n.status === "done" && (n.result === null || n.result === undefined)) {
        problems.push({ file: n.file, message: "task is done but has no result (done implies result)" });
      }
      if (n.status === "claimed" && (n.claimed_by === null || n.claimed_by === undefined)) {
        problems.push({ file: n.file, message: "task is claimed but has no claimed_by (claimed implies claimed_by)" });
      }
    }
    for (const link of extractWikilinks(n.body)) {
      if (!brain.byTitle.has(link.toLowerCase())) {
        problems.push({ file: n.file, message: `broken wikilink [[${link}]] (no note has that title)` });
      }
    }
    if (n.supersedes !== null) {
      const old = brain.byId.get(n.supersedes);
      if (!old) {
        problems.push({ file: n.file, message: `dangling supersedes: ${n.supersedes} does not exist` });
      } else if (old.superseded_by !== n.id) {
        problems.push({
          file: n.file,
          message: `supersedes chain mismatch: this note supersedes ${n.supersedes}, but that note's superseded_by is ${old.superseded_by ?? "not set"}`,
        });
      }
    }
    if (n.consolidates !== undefined) {
      for (const cid of n.consolidates) {
        const source = brain.byId.get(cid);
        if (!source) {
          problems.push({ file: n.file, message: `dangling consolidates: ${cid} does not exist` });
        } else if (source.superseded_by !== n.id) {
          problems.push({
            file: n.file,
            message: `consolidates chain mismatch: this note consolidates ${cid}, but that note's superseded_by is ${source.superseded_by ?? "not set"}`,
          });
        }
      }
    }
    if (n.superseded_by !== undefined) {
      const successor = brain.byId.get(n.superseded_by);
      if (!successor) {
        problems.push({ file: n.file, message: `dangling superseded_by: ${n.superseded_by} does not exist` });
      } else if (successor.supersedes !== n.id && !(successor.consolidates?.includes(n.id) ?? false)) {
        problems.push({
          file: n.file,
          message: `supersedes chain mismatch: superseded_by ${n.superseded_by}, but that note neither supersedes nor consolidates this one (it supersedes ${successor.supersedes ?? "nothing"})`,
        });
      }
    }
  }
  return problems;
}

// ---- attribution ----

/**
 * The brain owner's name for attribution: the BRAIN_HUMAN environment
 * variable, falling back to the OS username.
 */
export function humanName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BRAIN_HUMAN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}
