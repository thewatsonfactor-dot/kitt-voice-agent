import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { agent } from "./agent/orchestrator.js";
import { onLog } from "./lib/log.js";
import { startImapWatcher } from "./comms/imap-watcher.js";
import type { ClientToServer, ServerToClient } from "./ws/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "7878");
const KITT_DIR = join(os.homedir(), ".kitt");

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, ...agent.snapshot() });
});

// ── Dashboard API ─────────────────────────────────────────────────────────────

app.get("/api/dashboard", async (_req, res) => {
  try {
    const [todosRaw, studentsRaw, messagesRaw, todayRaw, strategyRaw] =
      await Promise.allSettled([
        fs.readFile(join(KITT_DIR, "household", "todos.json"), "utf-8"),
        readStudents(),
        fs.readFile(join(KITT_DIR, "household", "comms-messages.json"), "utf-8"),
        fs.readFile(join(KITT_DIR, "household", "today.json"), "utf-8"),
        readStrategy(),
      ]);

    const todos    = todosRaw.status    === "fulfilled" ? JSON.parse(todosRaw.value)    : [];
    const students = studentsRaw.status === "fulfilled" ? studentsRaw.value             : [];
    const messages = messagesRaw.status === "fulfilled" ? JSON.parse(messagesRaw.value) : [];
    const today    = todayRaw.status    === "fulfilled" ? JSON.parse(todayRaw.value)    : {};
    const strategy = strategyRaw.status === "fulfilled" ? strategyRaw.value             : "";

    const openTodos  = todos.filter((t: any) => !t.done);
    const last24h    = new Date(Date.now() - 86_400_000).toISOString();
    const recentMsgs = messages.filter((m: any) => m.createdAt > last24h);

    res.json({
      ok: true,
      snapshot: agent.snapshot(),
      todos: openTodos,
      students,
      messages: recentMsgs.slice(-50),
      today,
      strategy,
      stats: {
        openTodos:      openTodos.length,
        highTodos:      openTodos.filter((t: any) => t.priority === "high").length,
        immediateTodos: openTodos.filter((t: any) =>
          ["immediately", "ASAP"].includes(t.dueHint ?? "")).length,
        unreadMessages: messages.filter((m: any) => !m.read).length,
        recentMessages: recentMsgs.length,
        students:       students.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.patch("/api/todos/:id", async (req, res) => {
  try {
    const todosPath = join(KITT_DIR, "household", "todos.json");
    const todos: any[] = JSON.parse(await fs.readFile(todosPath, "utf-8"));
    const todo = todos.find(t => t.id === req.params.id);
    if (!todo) return res.status(404).json({ ok: false });
    Object.assign(todo, req.body);
    if (req.body.done) todo.doneAt = new Date().toISOString();
    await fs.writeFile(todosPath, JSON.stringify(todos, null, 2));
    res.json({ ok: true, todo });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

async function readStudents() {
  const dir = join(KITT_DIR, "students");
  try {
    const files = await fs.readdir(dir);
    return Promise.all(
      files
        .filter(f => f.endsWith(".json"))
        .map(async f => JSON.parse(await fs.readFile(join(dir, f), "utf-8")))
    );
  } catch { return []; }
}

async function readStrategy() {
  const dir = join(KITT_DIR, "strategy");
  try {
    const files = (await fs.readdir(dir))
      .filter(f => f.endsWith(".md"))
      .sort()
      .reverse();
    if (!files.length) return "";
    return fs.readFile(join(dir, files[0]), "utf-8");
  } catch { return ""; }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(msg: ServerToClient) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(json); });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", data: agent.snapshot() } satisfies ServerToClient));

  ws.on("message", (raw) => {
    let msg: ClientToServer;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "type")      agent.type(msg.text);
    if (msg.type === "set_mode")  agent.setMode(msg.mode);
    if (msg.type === "interrupt") agent.interrupt();
  });
});

agent.on("state",        (s) => broadcast({ type: "state", state: s }));
agent.on("mode",         (m) => broadcast({ type: "mode",  mode: m }));
agent.on("transcript",   (t) => broadcast({ type: "transcript", text: t }));
agent.on("reply",        (t) => broadcast({ type: "reply", text: t }));
agent.on("snapshot",     (d) => broadcast({ type: "snapshot", data: d }));
agent.on("latency",      (p) => broadcast({ type: "latency", kind: p.kind, ms: p.ms }));
agent.on("cost",         (p) => broadcast({ type: "cost", ...p }));
agent.on("memory_size",  (p) => broadcast({ type: "memory_size", ...p }));

onLog((line) => broadcast({ type: "log", line }));

server.listen(PORT, async () => {
  console.log(`KITT // http://localhost:${PORT}`);
  await agent.start();
  startImapWatcher();
});

process.on("SIGINT", () => { console.log("\nKITT // shutting down"); process.exit(0); });
