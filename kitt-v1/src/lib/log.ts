import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

type Level = "info" | "warn" | "error" | "debug" | "ok";

export interface LogLine {
  ts: string;
  level: Level;
  key: string;
  message: string;
}

export type LogSubscriber = (line: LogLine) => void;
const subs = new Set<LogSubscriber>();

export function onLog(s: LogSubscriber)  { subs.add(s);    return () => subs.delete(s); }

export function log(level: Level, key: string, message: string) {
  const ts = new Date().toISOString();
  const line: LogLine = { ts, level, key, message };
  const stamp = ts.slice(11, 23);
  const tag = level === "warn" ? "⚠" : level === "error" ? "✖" : level === "ok" ? "✓" : "·";
  console.log(`${stamp} ${tag} [${key}] ${message}`);
  subs.forEach((s) => s(line));
}

// Pricing snapshot (USD per million tokens). Updated when model/pricing changes.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3.0,  out: 15.0 },
  "claude-haiku-4-5":  { in: 0.8,  out: 4.0  },
};

export function priceFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

export async function recordCost(model: string, inputTokens: number, outputTokens: number): Promise<number> {
  const usd = priceFor(model, inputTokens, outputTokens);
  await db.cost.create({ data: { model, inputTokens, outputTokens, usd } });
  return usd;
}

export async function todaySpendUsd(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db.cost.findMany({ where: { ts: { gte: start } } });
  return rows.reduce((sum, r) => sum + r.usd, 0);
}

export async function isUnderCap(): Promise<{ under: boolean; spent: number; cap: number }> {
  const cap = parseFloat(process.env.DAILY_COST_CAP_USD ?? "2.00");
  const spent = await todaySpendUsd();
  return { under: spent < cap, spent, cap };
}
