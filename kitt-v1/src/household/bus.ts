import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const BUS_DIR = path.join(os.homedir(), ".kitt", "household");

export interface AgentMessage {
  id: string;
  from: "alfred" | "kitt" | "daniel" | "kaischa";
  to: "alfred" | "kitt" | "both";
  text: string;
  about?: string;
  createdAt: string;
  read: boolean;
}

export interface FamilyFlag {
  id: string;
  raisedBy: "alfred" | "kitt" | "daniel" | "kaischa";
  about?: string;
  severity: "note" | "attention" | "priority";
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface TodaysPlan {
  date: string;
  weather?: string;
  whereDanielIs?: string;
  whereKaischaIs?: string;
  meals?: { breakfast?: string; lunch?: string; dinner?: string };
  notes?: string;
}

export interface PantryCalendar {
  pantry: string[];
  upcoming: { date: string; what: string }[];
}

export interface BusSnapshot {
  today: TodaysPlan | null;
  messages: AgentMessage[];
  flags: FamilyFlag[];
  pantryCalendar: PantryCalendar | null;
}

async function readJson<T>(filename: string): Promise<T | null> {
  try {
    const text = await fs.readFile(path.join(BUS_DIR, filename), "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJson(filename: string, data: unknown): Promise<void> {
  await fs.mkdir(BUS_DIR, { recursive: true });
  await fs.writeFile(path.join(BUS_DIR, filename), JSON.stringify(data, null, 2));
}

export async function readBus(): Promise<BusSnapshot> {
  return {
    today: await readJson<TodaysPlan>("today.json"),
    messages: (await readJson<AgentMessage[]>("messages.json")) ?? [],
    flags: (await readJson<FamilyFlag[]>("flags.json")) ?? [],
    pantryCalendar: await readJson<PantryCalendar>("pantry-calendar.json"),
  };
}

export async function setToday(plan: TodaysPlan): Promise<void> {
  await writeJson("today.json", plan);
}

export async function postMessage(
  msg: Omit<AgentMessage, "id" | "createdAt" | "read">,
): Promise<void> {
  const messages = (await readJson<AgentMessage[]>("messages.json")) ?? [];
  messages.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    read: false,
    ...msg,
  });
  await writeJson("messages.json", messages);
}

export async function markMessageRead(id: string): Promise<void> {
  const messages = (await readJson<AgentMessage[]>("messages.json")) ?? [];
  const target = messages.find((m) => m.id === id);
  if (target) target.read = true;
  await writeJson("messages.json", messages);
}

export async function getUnreadFor(
  agent: "alfred" | "kitt",
): Promise<AgentMessage[]> {
  const messages = (await readJson<AgentMessage[]>("messages.json")) ?? [];
  return messages.filter((m) => !m.read && (m.to === agent || m.to === "both"));
}

export async function raiseFlag(
  flag: Omit<FamilyFlag, "id" | "createdAt" | "resolved">,
): Promise<void> {
  const flags = (await readJson<FamilyFlag[]>("flags.json")) ?? [];
  flags.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    resolved: false,
    ...flag,
  });
  await writeJson("flags.json", flags);
}

export async function resolveFlag(id: string): Promise<void> {
  const flags = (await readJson<FamilyFlag[]>("flags.json")) ?? [];
  const target = flags.find((f) => f.id === id);
  if (target) target.resolved = true;
  await writeJson("flags.json", flags);
}

export async function getActiveFlags(): Promise<FamilyFlag[]> {
  const flags = (await readJson<FamilyFlag[]>("flags.json")) ?? [];
  return flags.filter((f) => !f.resolved);
}

export async function setPantryCalendar(state: PantryCalendar): Promise<void> {
  await writeJson("pantry-calendar.json", state);
}
