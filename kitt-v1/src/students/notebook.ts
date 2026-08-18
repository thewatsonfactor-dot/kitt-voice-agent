import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Notebook, NotebookEntry } from "./schema.js";

const STUDENTS_DIR = path.join(os.homedir(), ".kitt", "students");

export async function loadNotebook(id: string): Promise<Notebook | null> {
  try {
    const text = await fs.readFile(path.join(STUDENTS_DIR, `${id}.json`), "utf-8");
    return JSON.parse(text) as Notebook;
  } catch {
    return null;
  }
}

export async function saveNotebook(notebook: Notebook): Promise<void> {
  notebook.updatedAt = new Date().toISOString();
  await fs.mkdir(STUDENTS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(STUDENTS_DIR, `${notebook.id}.json`),
    JSON.stringify(notebook, null, 2),
  );
}

export async function appendEntry(id: string, entry: NotebookEntry): Promise<void> {
  const notebook = await loadNotebook(id);
  if (!notebook) throw new Error(`Notebook not found: ${id}`);
  notebook.lastInteractions.unshift(entry);
  notebook.lastInteractions = notebook.lastInteractions.slice(0, 20);
  await saveNotebook(notebook);
}

export async function appendParentNote(id: string, note: string): Promise<void> {
  const notebook = await loadNotebook(id);
  if (!notebook) throw new Error(`Notebook not found: ${id}`);
  const today = new Date().toISOString().slice(0, 10);
  notebook.parentNotes = `${today}: ${note}\n${notebook.parentNotes}`.trim();
  await saveNotebook(notebook);
}

export async function listStudents(): Promise<string[]> {
  try {
    const files = await fs.readdir(STUDENTS_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}
