/**
 * cookbook-brain web: a read-only local viewer.
 *
 * One tiny node http server, bound to 127.0.0.1 only, serving exactly two
 * endpoints: `/` (a single self-contained HTML page: no frameworks, no CDN,
 * all CSS and JS inline) and `/api/brain.json` (the brain as JSON: active
 * notes with confidence, tier, credits, and backlinks; the task board;
 * conventions; and the dream/harvest reports).
 *
 * Read-only by construction: there are no mutating endpoints AT ALL. Any
 * method other than GET or HEAD gets a 405, every unknown path a 404, and no
 * request handler ever writes to disk. The multiplayer version with live
 * sync and enforced attribution is cookbook.team; this is the single-player
 * window onto your own files.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  activeConventions,
  confidenceFor,
  listTasks,
  loadBrain,
  recall,
  tierFor,
  type Note,
} from "./store.ts";

export const DEFAULT_WEB_PORT = 4321;

const DAY_MS = 24 * 60 * 60 * 1000;

function webTaskView(t: Note, now: number) {
  return {
    id: t.id,
    title: t.title,
    status: t.status ?? "open",
    assigned_to: t.assigned_to ?? null,
    claimed_by: t.claimed_by ?? null,
    result: t.result ?? null,
    abandon_reason: t.abandon_reason ?? null,
    created: t.created,
    age_days: Math.max(0, Math.floor((now - Date.parse(t.created)) / DAY_MS)),
    instructions: t.body,
  };
}

/**
 * The whole brain as one JSON payload, computed fresh per request so the
 * page always shows the files as they are right now. Reports are the
 * markdown files under brain/dreams/, newest first by filename.
 */
export function brainSnapshot(dir: string, now: number = Date.now()) {
  const brain = loadBrain(dir);
  const notes = recall(brain, { now });
  const conventions = activeConventions(brain).map((n) => {
    const confidence = confidenceFor(n, now);
    return { id: n.id, title: n.title, body: n.body, credits: n.credits, confidence, tier: tierFor(confidence, n.credits) };
  });
  const tasks = listTasks(brain, "all").map((t) => webTaskView(t, now));
  const dreamsDir = path.join(dir, "dreams");
  let reports: { name: string; content: string }[] = [];
  if (fs.existsSync(dreamsDir)) {
    reports = fs
      .readdirSync(dreamsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .map((f) => ({ name: f, content: fs.readFileSync(path.join(dreamsDir, f), "utf8") }));
  }
  return {
    brain: dir,
    generated: new Date(now).toISOString(),
    notes,
    conventions,
    tasks,
    reports,
    problem_count: brain.problems.length,
  };
}

/** The page. Static shell with the section structure; all data arrives client-side from /api/brain.json. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cookbook-brain</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0e1116; color: #d6dde6; font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .09em; color: #8b95a3; border-bottom: 1px solid #232a33; padding-bottom: 6px; margin: 42px 0 6px; }
h3 { font-size: 14px; color: #aeb8c4; margin: 20px 0 4px; }
h4 { font-size: 15px; margin: 0; font-weight: 600; }
.meta { color: #77808c; font-size: 12px; }
.card { background: #151a21; border: 1px solid #232a33; border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.card.verify { opacity: .62; }
.cardhead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.badge { flex: none; font-size: 10px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .07em; }
.badge.proven { background: #123b26; color: #5eeaa0; }
.badge.standing { background: #262d36; color: #aeb8c4; }
.badge.verify { background: #1b1f26; color: #6b7480; border: 1px solid #2a313b; }
.confwrap { height: 4px; background: #232a33; border-radius: 2px; margin: 8px 0 2px; overflow: hidden; }
.confbar { height: 100%; border-radius: 2px; background: #8b95a3; }
.proven .confbar { background: #5eeaa0; }
.standing .confbar { background: #8b95a3; }
.verify .confbar { background: #3a424d; }
pre.body { white-space: pre-wrap; word-break: break-word; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #b9c2cd; margin: 8px 0 0; }
.backlinks { margin-top: 8px; }
a.backlink { color: #7cc4ff; text-decoration: none; margin-right: 12px; font-size: 13px; }
a.backlink:hover { text-decoration: underline; }
.board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
@media (max-width: 720px) { .board { grid-template-columns: 1fr; } }
.col h3 { margin-top: 8px; }
.abandon { color: #e2b45a; font-size: 13px; margin: 6px 0 0; }
.result { color: #9fb8a8; font-size: 13px; margin: 6px 0 0; }
details.report { background: #151a21; border: 1px solid #232a33; border-radius: 8px; padding: 8px 14px; margin: 10px 0; }
details.report summary { cursor: pointer; color: #aeb8c4; font-size: 14px; }
.flash { outline: 2px solid #5eeaa0; }
footer { margin-top: 64px; color: #77808c; font-size: 13px; border-top: 1px solid #232a33; padding-top: 14px; }
</style>
</head>
<body>
<main>
  <h1>cookbook-brain</h1>
  <p id="summary" class="meta">loading…</p>
  <section id="conventions-section">
    <h2>Conventions</h2>
    <div id="conventions"></div>
  </section>
  <section id="notes-section">
    <h2>Notes</h2>
    <div id="notes"></div>
  </section>
  <section id="tasks-section">
    <h2>Task board</h2>
    <div id="board" class="board"></div>
  </section>
  <section id="reports-section">
    <h2>Reports</h2>
    <div id="reports"></div>
  </section>
  <footer>Read-only view. The live multiplayer version is cookbook.team</footer>
</main>
<script>
const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function goTo(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1500);
}
function credits(n) { return n + " credit" + (n === 1 ? "" : "s"); }
function confBar(confidence) {
  const wrap = el("div", "confwrap");
  const bar = el("div", "confbar");
  bar.style.width = Math.round(confidence * 100) + "%";
  wrap.title = "confidence " + confidence.toFixed(2);
  wrap.appendChild(bar);
  return wrap;
}
function noteCard(n, withBody) {
  const card = el("article", "card " + n.tier);
  card.id = "note-" + n.id;
  const head = el("div", "cardhead");
  head.appendChild(el("h4", null, n.title));
  head.appendChild(el("span", "badge " + n.tier, n.tier));
  card.appendChild(head);
  const author = n.author ? (n.author.agent ? n.author.human + " via " + n.author.agent : n.author.human) : null;
  const parts = [];
  if (author) parts.push(author);
  if (n.created) parts.push(n.created.slice(0, 10));
  parts.push(credits(n.credits));
  parts.push("confidence " + n.confidence.toFixed(2));
  card.appendChild(el("div", "meta", parts.join(" · ")));
  card.appendChild(confBar(n.confidence));
  if (withBody) card.appendChild(el("pre", "body", n.body));
  if (n.backlinks && n.backlinks.length > 0) {
    const bl = el("div", "backlinks");
    bl.appendChild(el("span", "meta", "backlinks: "));
    for (const b of n.backlinks) {
      const a = el("a", "backlink", "[[" + b.title + "]]");
      a.href = "#note-" + b.id;
      a.title = b.context || "";
      a.addEventListener("click", (ev) => { ev.preventDefault(); goTo("note-" + b.id); });
      bl.appendChild(a);
    }
    card.appendChild(bl);
  }
  return card;
}
const NOTE_GROUPS = [
  ["decision", "Decisions"],
  ["gotcha", "Gotchas"],
  ["open_thread", "Open threads"],
  ["note", "Notes"],
];
function taskCard(t) {
  const card = el("article", "card");
  card.id = "note-" + t.id;
  card.appendChild(el("h4", null, t.title));
  const who =
    t.status === "claimed" ? "claimed by " + t.claimed_by :
    t.status === "done" ? "done by " + (t.claimed_by || "unknown") :
    t.assigned_to ? "for " + t.assigned_to : "for any agent";
  card.appendChild(el("div", "meta", who + " · " + t.age_days + "d old"));
  if (t.abandon_reason) card.appendChild(el("p", "abandon", "abandoned earlier: " + t.abandon_reason));
  if (t.result) card.appendChild(el("p", "result", "result: " + t.result));
  card.appendChild(el("pre", "body", t.instructions));
  return card;
}
async function load() {
  let data;
  try {
    const res = await fetch("/api/brain.json");
    data = await res.json();
  } catch (e) {
    $("summary").textContent = "could not load /api/brain.json: " + e;
    return;
  }
  const problems = data.problem_count > 0 ? " · " + data.problem_count + " file problem(s), run doctor" : "";
  $("summary").textContent = data.brain + " · " + data.notes.length + " active note(s) · " + data.tasks.length + " task(s)" + problems;

  const conv = $("conventions");
  if (data.conventions.length === 0) conv.appendChild(el("p", "meta", "none"));
  for (const c of data.conventions) conv.appendChild(noteCard(c, true));

  const notes = $("notes");
  let grouped = 0;
  for (const [type, heading] of NOTE_GROUPS) {
    const group = data.notes.filter((n) => n.type === type);
    if (group.length === 0) continue;
    grouped += group.length;
    notes.appendChild(el("h3", null, heading));
    for (const n of group) notes.appendChild(noteCard(n, true));
  }
  if (grouped === 0) notes.appendChild(el("p", "meta", "none"));

  const board = $("board");
  for (const status of ["open", "claimed", "done"]) {
    const tasks = data.tasks.filter((t) => t.status === status);
    const col = el("div", "col");
    col.appendChild(el("h3", null, status + " (" + tasks.length + ")"));
    if (tasks.length === 0) col.appendChild(el("p", "meta", "none"));
    for (const t of tasks) col.appendChild(taskCard(t));
    board.appendChild(col);
  }

  const reports = $("reports");
  if (data.reports.length === 0) reports.appendChild(el("p", "meta", "none yet: dream and harvest write their reports here"));
  data.reports.forEach((r, i) => {
    const d = el("details", "report");
    if (i === 0) d.open = true;
    d.appendChild(el("summary", null, r.name));
    d.appendChild(el("pre", "body", r.content));
    reports.appendChild(d);
  });
}
load();
</script>
</body>
</html>
`;

/**
 * The read-only request handler as a server. GET and HEAD only: everything
 * else is a 405, because this server has no mutating endpoints at all.
 */
export function createWebServer(dir: string): http.Server {
  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0];
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("read-only view: this server accepts GET only and has no mutating endpoints");
      return;
    }
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(method === "HEAD" ? undefined : PAGE);
      return;
    }
    if (url === "/api/brain.json") {
      let body: string;
      try {
        body = JSON.stringify(brainSnapshot(dir), null, 2);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`could not read the brain: ${(e as Error).message}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found (endpoints: / and /api/brain.json)");
  });
}

/** Start the viewer on 127.0.0.1 only. Never binds a public interface. */
export function serveWeb(dir: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createWebServer(dir);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
