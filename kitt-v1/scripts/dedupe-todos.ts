import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { todoKey, writeJsonAtomic } from "../src/household/comms-bus.js";

// One-off cleanup for duplicates created before the comms-bus fix.
// Stop KITT (pnpm dev) before running this, so the watcher isn't writing
// todos.json at the same time.

interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  dueHint?: string;
  priority: "low" | "medium" | "high";
  entity: string;
  source: string;
  sourceMsgId?: string;
  done: boolean;
  doneAt?: string;
  createdAt: string;
}

const TODOS_FILE = path.join(os.homedir(), ".kitt", "household", "todos.json");
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  const text = await fs.readFile(TODOS_FILE, "utf-8");
  const todos = JSON.parse(text) as TodoItem[];
  const before = todos.length;

  const cutoff = Date.now() - DONE_RETENTION_MS;
  const kept: TodoItem[] = [];
  const seen = new Map<string, TodoItem>();

  for (const todo of todos) {
    if (todo.done) {
      const doneTime = new Date(todo.doneAt ?? todo.createdAt).getTime();
      if (doneTime < cutoff) continue;
    }

    const key = todoKey(todo.title, todo.entity);
    const existing = seen.get(key);
    if (!existing || new Date(todo.createdAt) > new Date(existing.createdAt)) {
      seen.set(key, todo);
    }
  }

  kept.push(...seen.values());
  kept.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  await writeJsonAtomic(TODOS_FILE, kept);
  console.log(`Todos: ${before} → ${kept.length} (removed ${before - kept.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
