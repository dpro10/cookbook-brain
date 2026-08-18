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
import path from "node:path";

export const NOTE_TYPES = ["decision", "gotcha", "convention", "note", "open_thread"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

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
  credits: number;
  last_credited: string | null;
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
  tier: "standing" | "verify";
  body: string;
  backlinks: Backlink[];
}

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
  if (value === "" || /[:#"\[\]]|^\s|\s$|^null$|^\d+$/.test(value)) return JSON.stringify(value);
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
  if (note.superseded_by !== undefined) lines.push(`superseded_by: ${fmScalar(note.superseded_by)}`);
  lines.push(`credits: ${note.credits}`);
  lines.push(`last_credited: ${fmScalar(note.last_credited)}`);
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
  created?: string;
  id?: string;
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
  let file = path.join(dir, noteFilename(created, note.title));
  if (fs.existsSync(file)) {
    // Same day + same slug: disambiguate with the id's random tail, still never overwriting.
    file = path.join(dir, `${created.slice(0, 10)}--${slugify(note.title)}-${note.id.slice(-6).toLowerCase()}.md`);
  }
  fs.writeFileSync(file, serializeNote(note), { flag: "wx" });
  return { ...note, file };
}

/**
 * Supersede: create the replacement note, then stamp `superseded_by` on the
 * old file. Rewriting that one frontmatter field is the single mutation of an
 * existing file this engine allows; the old note's content is untouched.
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
  const stamped: Note = { ...oldNote, superseded_by: newNote.id };
  const { file: _f, ...rest } = stamped;
  fs.writeFileSync(oldNote.file, serializeNote(rest));
  return { oldNote: stamped, newNote };
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

/**
 * M1 confidence is the provenance cap only: human 0.95, agent with a cited
 * source 0.85, bare agent claim 0.60. The credit-based lift (verified use
 * raising confidence toward the cap) lands in M2; the response shape,
 * including credits, ships now.
 */
export function confidenceFor(note: Note): number {
  if (note.author.agent === null) return 0.95;
  return isSourced(note.body) ? 0.85 : 0.6;
}

export function tierFor(confidence: number): "standing" | "verify" {
  return confidence >= 0.85 ? "standing" : "verify";
}

// ---- recall ----

export interface RecallOptions {
  query?: string;
  type?: NoteType;
}

/**
 * Recall over active notes: case-insensitive substring match on title or
 * body (no query returns everything active), optional type filter, newest
 * first, each result carrying confidence, tier, credits, and backlinks with
 * context.
 */
export function recall(brain: Brain, opts: RecallOptions = {}): RecallResult[] {
  const q = opts.query?.trim().toLowerCase();
  let matched = activeNotes(brain);
  if (opts.type) matched = matched.filter((n) => n.type === opts.type);
  if (q) matched = matched.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
  matched = [...matched].sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
  return matched.map((n) => {
    const confidence = confidenceFor(n);
    return {
      id: n.id,
      type: n.type,
      title: n.title,
      author: n.author,
      created: n.created,
      credits: n.credits,
      confidence,
      tier: tierFor(confidence),
      body: n.body,
      backlinks: backlinksFor(brain, n),
    };
  });
}

// ---- doctor ----

/** Full validation pass: parse problems, broken wikilinks, dangling or inconsistent supersedes chains. */
export function diagnose(dir: string): BrainProblem[] {
  const brain = loadBrain(dir);
  const problems = [...brain.problems];
  for (const n of brain.notes) {
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
    if (n.superseded_by !== undefined) {
      const successor = brain.byId.get(n.superseded_by);
      if (!successor) {
        problems.push({ file: n.file, message: `dangling superseded_by: ${n.superseded_by} does not exist` });
      } else if (successor.supersedes !== n.id) {
        problems.push({
          file: n.file,
          message: `supersedes chain mismatch: superseded_by ${n.superseded_by}, but that note supersedes ${successor.supersedes ?? "nothing"}`,
        });
      }
    }
  }
  return problems;
}
