import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Notebook } from "../students/schema.js";
import type { BusSnapshot } from "../household/bus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_PATH = path.join(__dirname, "alfred.system.md");

function summarizeNotebook(n: Notebook): string {
  const lines = [
    `Who they are: ${n.whoTheyAre || "(not yet noted)"}`,
    `How they learn: ${n.howTheyLearn || "(not yet noted)"}`,
    `Currently working on: ${n.currentWork || "(not yet noted)"}`,
    `Running jokes & stories: ${n.runningJokesAndStories || "(none yet)"}`,
    `Care notes: ${n.care || "(none yet)"}`,
    `Their goals: ${n.goals || "(not yet stated)"}`,
    "",
    "Last 5 conversations:",
    ...n.lastInteractions
      .slice(0, 5)
      .map((e) => `  - [${e.timestamp.slice(0, 10)}] ${e.summary}`),
  ];
  return lines.join("\n");
}

function summarizeBus(bus: BusSnapshot): {
  todayBlock: string;
  flagsBlock: string;
  messagesBlock: string;
} {
  const todayBlock = bus.today
    ? JSON.stringify(bus.today, null, 2)
    : "(no plan posted yet today)";

  const unread = bus.messages.filter(
    (m) => !m.read && (m.to === "alfred" || m.to === "both"),
  );
  const messagesBlock = unread.length
    ? unread
        .map(
          (m) =>
            `From ${m.from}${m.about ? ` (about ${m.about})` : ""}: ${m.text}`,
        )
        .join("\n")
    : "(none)";

  const activeFlags = bus.flags.filter((f) => !f.resolved);
  const flagsBlock = activeFlags.length
    ? activeFlags
        .map(
          (f) =>
            `[${f.severity}] ${f.text}${f.about ? ` (about ${f.about})` : ""}`,
        )
        .join("\n")
    : "(none)";

  return { todayBlock, flagsBlock, messagesBlock };
}

export async function buildAlfredPrompt(
  notebook: Notebook,
  bus: BusSnapshot,
): Promise<string> {
  let template = await fs.readFile(TEMPLATE_PATH, "utf-8");
  const { todayBlock, flagsBlock, messagesBlock } = summarizeBus(bus);

  template = template
    .replace(/{{CHILD_NAME}}/g, notebook.name)
    .replace(/{{CHILD_AGE}}/g, notebook.age == null ? "unknown" : String(notebook.age))
    .replace(/{{CHILD_TIER}}/g, notebook.tier)
    .replace(/{{NOTEBOOK_SUMMARY}}/g, summarizeNotebook(notebook))
    .replace(/{{PARENT_NOTES}}/g, notebook.parentNotes || "(none recent)")
    .replace(/{{TODAY_PLAN}}/g, todayBlock)
    .replace(/{{FAMILY_FLAGS}}/g, flagsBlock);

  return template + `\n\nUnread messages from Kitt:\n${messagesBlock}`;
}
