import { db } from "../lib/log.js";
import type { ModeName } from "../modes/index.js";

const MAX_LOAD_ENTRIES = 12;

export async function loadMemory(mode: ModeName): Promise<string> {
  const rows = await db.memory.findMany({
    where: { mode },
    orderBy: { createdAt: "desc" },
    take: MAX_LOAD_ENTRIES,
  });
  if (rows.length === 0) return "";
  return rows.reverse()
    .map((r) => `- [${r.kind}] ${r.content}`)
    .join("\n");
}

export async function storeMemory(mode: ModeName, kind: string, content: string): Promise<void> {
  await db.memory.create({ data: { mode, kind, content } });
}

export async function memorySize(mode: ModeName): Promise<{ count: number; bytes: number }> {
  const rows = await db.memory.findMany({ where: { mode }, select: { content: true } });
  const bytes = rows.reduce((b, r) => b + r.content.length, 0);
  return { count: rows.length, bytes };
}
