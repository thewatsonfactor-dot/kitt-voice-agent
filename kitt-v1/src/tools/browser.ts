import { spawn } from "node:child_process";
import { log } from "../lib/log.js";
import { db } from "../lib/log.js";
import type { ModeName } from "../modes/index.js";

const URL_RE = /^https?:\/\/[^\s'"`<>]+$/i;

export async function browserOpen(input: { url: string }, mode: ModeName): Promise<{ ok: boolean; result: string }> {
  if (!URL_RE.test(input.url)) {
    const result = `rejected: url failed validation`;
    await db.toolCall.create({ data: { mode, tool: "browser_open", input: JSON.stringify(input), ok: false, result } });
    return { ok: false, result };
  }
  return new Promise((resolve) => {
    const p = spawn("open", ["-a", "Google Chrome", input.url], { stdio: "ignore" });
    p.on("close", async (code) => {
      const ok = code === 0;
      const result = ok ? `opened ${input.url}` : `open exited ${code}`;
      log(ok ? "ok" : "error", "tool", result);
      await db.toolCall.create({ data: { mode, tool: "browser_open", input: JSON.stringify(input), ok, result } });
      resolve({ ok, result });
    });
  });
}

/** Heuristic: pull a URL out of an utterance like "open google", "go to gmail.com". */
export function inferUrl(utterance: string): string | null {
  const u = utterance.toLowerCase().trim();
  const httpMatch = u.match(/https?:\/\/\S+/);
  if (httpMatch) return httpMatch[0];

  const named: Record<string, string> = {
    "google":   "https://google.com",
    "gmail":    "https://mail.google.com",
    "calendar": "https://calendar.google.com",
    "drive":    "https://drive.google.com",
    "youtube":  "https://youtube.com",
    "github":   "https://github.com",
  };
  for (const [k, v] of Object.entries(named)) {
    if (u.includes(k)) return v;
  }
  const dotMatch = u.match(/\b([a-z0-9-]+\.(com|net|io|app|dev|tech|co))\b/);
  if (dotMatch) return `https://${dotMatch[1]}`;
  return null;
}
