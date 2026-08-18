import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface TodoItem {
  id: string;
  title: string;
  notes?: string;
  dueHint?: string;
  priority: "low" | "medium" | "high";
  entity: string;
  source: string;
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

    const key = `${todo.title}\0${todo.entity}`;
    const existing = seen.get(key);
    if (!existing || new Date(todo.createdAt) > new Date(existing.createdAt)) {
      seen.set(key, todo);
    }
  }

  kept.push(...seen.values());
  kept.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  await fs.writeFile(TODOS_FILE, JSON.stringify(kept, null, 2));
  console.log(`Todos: ${before} → ${kept.length} (removed ${before - kept.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
