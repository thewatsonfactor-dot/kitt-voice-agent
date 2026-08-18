import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { CommMessage, TodoItem } from "./comms-bus.js";
import type { TodaysPlan } from "./bus.js";
import { readBus } from "./bus.js";

const KITT_DIR = path.join(os.homedir(), ".kitt");
const MAX_HIGH_TODOS = 20;
const MAX_OTHER_TODOS = 10;
const MAX_UNREAD_EMAILS = 15;
const MAX_STRATEGY_CHARS = 1500;

export interface DashboardSnapshot {
  openTodos: TodoItem[];
  highTodos: TodoItem[];
  unreadEmails: CommMessage[];
  today: TodaysPlan | null;
  students: string[];
  strategy: string;
  stats: {
    openTodos: number;
    highTodos: number;
    immediateTodos: number;
    unreadEmails: number;
    recentEmails24h: number;
    students: number;
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function readStudents(): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(KITT_DIR, "students"));
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

async function readStrategy(): Promise<string> {
  try {
    const dir = path.join(KITT_DIR, "strategy");
    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
    if (!files.length) return "";
    const text = await fs.readFile(path.join(dir, files[0]), "utf-8");
    return text.slice(0, MAX_STRATEGY_CHARS);
  } catch {
    return "";
  }
}

export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [todos, messages, students, strategy, bus] = await Promise.all([
    readJsonFile<TodoItem[]>(path.join(KITT_DIR, "household", "todos.json")),
    readJsonFile<CommMessage[]>(path.join(KITT_DIR, "household", "comms-messages.json")),
    readStudents(),
    readStrategy(),
    readBus(),
  ]);

  const allTodos = todos ?? [];
  const allMessages = messages ?? [];
  const openTodos = allTodos.filter((t) => !t.done);
  const highTodos = openTodos.filter((t) => t.priority === "high");
  const last24h = new Date(Date.now() - 86_400_000).toISOString();
  const unreadEmails = allMessages.filter((m) => !m.read);
  const recentEmails24h = allMessages.filter((m) => m.createdAt > last24h);

  return {
    openTodos,
    highTodos,
    unreadEmails,
    today: bus.today,
    students,
    strategy,
    stats: {
      openTodos: openTodos.length,
      highTodos: highTodos.length,
      immediateTodos: openTodos.filter((t) =>
        ["immediately", "ASAP"].includes(t.dueHint ?? ""),
      ).length,
      unreadEmails: unreadEmails.length,
      recentEmails24h: recentEmails24h.length,
      students: students.length,
    },
  };
}

function formatTodo(t: TodoItem): string {
  const due = t.dueHint ? ` · due: ${t.dueHint}` : "";
  return `- [${t.priority.toUpperCase()}] ${t.title} (${t.entity})${due}`;
}

function formatEmail(m: CommMessage): string {
  const snippet = m.body.replace(/\s+/g, " ").trim().slice(0, 100);
  return `- [${m.entity}] ${m.from} · "${m.subject}"${snippet ? ` · ${snippet}` : ""}`;
}

export function formatDashboardContext(snap: DashboardSnapshot): string {
  const highBlock = snap.highTodos.slice(0, MAX_HIGH_TODOS).map(formatTodo).join("\n")
    || "(none)";
  const otherTodos = snap.openTodos
    .filter((t) => t.priority !== "high")
    .slice(0, MAX_OTHER_TODOS)
    .map(formatTodo)
    .join("\n") || "(none)";
  const emailBlock = snap.unreadEmails.slice(-MAX_UNREAD_EMAILS).map(formatEmail).join("\n")
    || "(none)";
  const todayBlock = snap.today
    ? JSON.stringify(snap.today, null, 2)
    : "(no plan posted today)";
  const strategyBlock = snap.strategy.trim() || "(none)";
  const studentBlock = snap.students.length
    ? snap.students.join(", ")
    : "(none)";

  const { stats } = snap;
  const overflowNote =
    snap.highTodos.length > MAX_HIGH_TODOS
      ? `\n(${snap.highTodos.length - MAX_HIGH_TODOS} more high-priority todos not shown)`
      : "";
  const emailOverflow =
    snap.unreadEmails.length > MAX_UNREAD_EMAILS
      ? `\n(${snap.unreadEmails.length - MAX_UNREAD_EMAILS} more unread emails not shown)`
      : "";

  return [
    "",
    "LIVE DASHBOARD — use this when Jeffery asks about todos, email, priorities, or today's plan.",
    `Stats: ${stats.openTodos} open todos · ${stats.highTodos} high · ${stats.immediateTodos} ASAP · ${stats.unreadEmails} unread email · ${stats.recentEmails24h} email in 24h`,
    "",
    "HIGH-PRIORITY TODOS:",
    highBlock + overflowNote,
    "",
    "OTHER OPEN TODOS (sample):",
    otherTodos,
    "",
    "UNREAD EMAIL (most recent):",
    emailBlock + emailOverflow,
    "",
    "TODAY'S PLAN:",
    todayBlock,
    "",
    "STUDENTS (Alfred):",
    studentBlock,
    "",
    "STRATEGY DOC (excerpt):",
    strategyBlock,
  ].join("\n");
}

export async function buildDashboardContext(): Promise<string> {
  const snap = await loadDashboardSnapshot();
  return formatDashboardContext(snap);
}
