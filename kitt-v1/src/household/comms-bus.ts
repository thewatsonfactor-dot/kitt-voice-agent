import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const BUS_DIR = path.join(os.homedir(), ".kitt", "household");

export type CommSource = "gmail" | "imessage" | "calendar" | "voice";

export interface CommMessage {
  id: string;
  source: CommSource;
  entity: string;
  from: string;
  subject: string;
  body: string;
  date: string;
  msgId: string;
  read: boolean;
  needsReply: boolean;
  createdAt: string;
}

export interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  dueHint?: string;
  priority: "low" | "medium" | "high";
  entity: string;
  source: string;
  /** Message-ID of the email/message this todo was extracted from, if any. */
  sourceMsgId?: string;
  done: boolean;
  doneAt?: string;
  createdAt: string;
}

const MESSAGES_FILE = "comms-messages.json";
const TODOS_FILE = "todos.json";
const PROCESSED_FILE = "processed-messages.json";
const MAX_MESSAGES = 500;
const MAX_PROCESSED = 2000;

// ── File safety ──────────────────────────────────────────────────────────────
//
// Every bus file is read-modify-write JSON. Two things used to go wrong:
//  1. The six IMAP accounts poll in parallel, so their writes interleaved and
//     the last writer won (lost todos, lost "already processed" ids).
//  2. A crash mid-write left half a JSON file; the next read failed, returned
//     [], and the next write replaced the whole list with almost nothing.
// withFileLock() serialises writers per file inside this process, and
// writeJsonAtomic() writes a temp file and renames it into place, so a reader
// never sees a half-written file.

const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(filename: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(filename) ?? Promise.resolve();
  const run = prev.then(fn);
  // The chain must keep going even if this step throws.
  const tail = run.catch(() => undefined);
  fileLocks.set(filename, tail);
  void tail.then(() => { if (fileLocks.get(filename) === tail) fileLocks.delete(filename); });
  return run;
}

/** Reads a JSON array. Missing or empty file → []. Corrupt file → throws, so nobody overwrites it. */
async function readJson<T>(filename: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(BUS_DIR, filename), "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  if (!text.trim()) return [];
  try {
    return JSON.parse(text) as T[];
  } catch {
    throw new Error(`${path.join(BUS_DIR, filename)} is not valid JSON; refusing to overwrite it`);
  }
}

/** For read-only views: a corrupt file shows as empty instead of crashing the caller. */
async function readJsonOrEmpty<T>(filename: string): Promise<T[]> {
  try { return await readJson<T>(filename); } catch { return []; }
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

async function writeJson(filename: string, data: unknown): Promise<void> {
  await writeJsonAtomic(path.join(BUS_DIR, filename), data);
}

/**
 * Key used to decide whether two todos are "the same". Claude rewords titles
 * slightly between runs ("Call Ali back" vs "call Ali back."), so compare on
 * lower-cased words only, within the same entity.
 */
export function todoKey(title: string, entity: string): string {
  const norm = (title ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${entity}\0${norm}`;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function postCommMessage(msg: Omit<CommMessage, "id" | "createdAt">): Promise<CommMessage> {
  return withFileLock(MESSAGES_FILE, async () => {
    const messages = await readJson<CommMessage>(MESSAGES_FILE);
    const existing = messages.find(m => m.msgId === msg.msgId);
    if (existing) return existing;
    const newMsg: CommMessage = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...msg };
    messages.push(newMsg);
    await writeJson(MESSAGES_FILE, messages.slice(-MAX_MESSAGES));
    return newMsg;
  });
}

export async function getUnreadMessages(entity?: string): Promise<CommMessage[]> {
  const messages = await readJsonOrEmpty<CommMessage>(MESSAGES_FILE);
  return messages.filter(m => !m.read && (!entity || m.entity === entity));
}

export async function getRecentMessages(hours = 24, entity?: string): Promise<CommMessage[]> {
  const messages = await readJsonOrEmpty<CommMessage>(MESSAGES_FILE);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return messages.filter(m => m.createdAt > cutoff && (!entity || m.entity === entity));
}

export function markCommRead(id: string): Promise<void> {
  return withFileLock(MESSAGES_FILE, async () => {
    const messages = await readJson<CommMessage>(MESSAGES_FILE);
    const target = messages.find(m => m.id === id);
    if (!target) return;
    target.read = true;
    await writeJson(MESSAGES_FILE, messages);
  });
}

// ── Processed-message ledger ─────────────────────────────────────────────────
//
// One shared ledger for all accounts. Before, each account loaded its own copy
// at the start of a poll and saved it at the end, wiping the ids the other
// accounts had saved in between. Those emails then looked new on the next poll
// and were sent to Claude again, which is where most duplicate todos came from.

let processedCache: Set<string> | null = null;

async function loadProcessed(): Promise<Set<string>> {
  if (!processedCache) {
    try {
      processedCache = new Set(await readJson<string>(PROCESSED_FILE));
    } catch (e) {
      // A damaged ledger only costs a re-check: hasTodosFromMessage() still
      // stops an email from producing todos twice. Start fresh rather than
      // stopping email intake.
      console.warn(`[comms-bus] ${e instanceof Error ? e.message : e}; starting a new processed-messages ledger`);
      processedCache = new Set();
    }
  }
  return processedCache;
}

export function isProcessed(msgId: string): Promise<boolean> {
  return withFileLock(PROCESSED_FILE, async () => (await loadProcessed()).has(msgId));
}

export function markProcessed(msgId: string): Promise<void> {
  return withFileLock(PROCESSED_FILE, async () => {
    let ids = await loadProcessed();
    if (ids.has(msgId)) return;
    ids.add(msgId);
    if (ids.size > MAX_PROCESSED) {
      ids = new Set([...ids].slice(-MAX_PROCESSED));
      processedCache = ids;
    }
    await writeJson(PROCESSED_FILE, [...ids]);
  });
}

/** Test hook: forget the in-memory ledger so the next call re-reads the file. */
export function _resetProcessedCache(): void { processedCache = null; }

// ── Todos ────────────────────────────────────────────────────────────────────

/** True if any todo, open or done, was already extracted from this message. */
export function hasTodosFromMessage(msgId: string): Promise<boolean> {
  return withFileLock(TODOS_FILE, async () => {
    const todos = await readJson<TodoItem>(TODOS_FILE);
    return todos.some(t => t.sourceMsgId === msgId);
  });
}

export function addTodo(todo: Omit<TodoItem, "id">): Promise<TodoItem> {
  return withFileLock(TODOS_FILE, async () => {
    const todos = await readJson<TodoItem>(TODOS_FILE);
    const key = todoKey(todo.title, todo.entity);
    const existing = todos.find(t =>
      todoKey(t.title, t.entity) === key &&
      // An open todo with the same title is a duplicate. A finished one only
      // counts if it came from this same message, so a re-read email can't
      // bring back something Daniel already checked off.
      (!t.done || (todo.sourceMsgId !== undefined && t.sourceMsgId === todo.sourceMsgId)),
    );
    if (existing) return existing;
    const newTodo: TodoItem = { id: crypto.randomUUID(), ...todo };
    todos.push(newTodo);
    await writeJson(TODOS_FILE, todos);
    return newTodo;
  });
}

const EDITABLE_TODO_FIELDS = ["title", "notes", "dueHint", "priority", "done"] as const;

/**
 * Dashboard edits go through the same lock as the IMAP watcher, so neither
 * overwrites the other. Only the fields above can be changed.
 */
export function updateTodo(id: string, patch: Record<string, unknown>): Promise<TodoItem | null> {
  return withFileLock(TODOS_FILE, async () => {
    const todos = await readJson<TodoItem>(TODOS_FILE);
    const todo = todos.find(t => t.id === id);
    if (!todo) return null;
    const clean: Record<string, unknown> = {};
    for (const f of EDITABLE_TODO_FIELDS) if (f in patch) clean[f] = patch[f];
    if ("priority" in clean && !["low", "medium", "high"].includes(String(clean.priority))) delete clean.priority;
    if ("done" in clean) clean.done = Boolean(clean.done);
    Object.assign(todo, clean);
    if (clean.done === true) todo.doneAt = new Date().toISOString();
    if (clean.done === false) delete todo.doneAt;
    await writeJson(TODOS_FILE, todos);
    return todo;
  });
}

export async function getOpenTodos(entity?: string): Promise<TodoItem[]> {
  const todos = await readJsonOrEmpty<TodoItem>(TODOS_FILE);
  return todos.filter(t => !t.done && (!entity || t.entity === entity));
}

export async function getCommsSummary() {
  const [messages, todos] = await Promise.all([
    readJsonOrEmpty<CommMessage>(MESSAGES_FILE),
    readJsonOrEmpty<TodoItem>(TODOS_FILE),
  ]);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    totalMessages: messages.length,
    unreadMessages: messages.filter(m => !m.read).length,
    needsReply: messages.filter(m => m.needsReply && !m.read).length,
    recent24h: messages.filter(m => m.createdAt > last24h).length,
    openTodos: todos.filter(t => !t.done).length,
    highPrioTodos: todos.filter(t => !t.done && t.priority === "high").length,
  };
}
