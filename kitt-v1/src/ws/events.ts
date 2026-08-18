import type { AgentState, AgentSnapshot } from "../agent/orchestrator.js";
import type { ModeName } from "../modes/index.js";
import type { LogLine } from "../lib/log.js";

export type ServerToClient =
  | { type: "snapshot"; data: AgentSnapshot }
  | { type: "state"; state: AgentState }
  | { type: "mode";  mode: ModeName }
  | { type: "transcript"; text: string }
  | { type: "reply"; text: string }
  | { type: "log"; line: LogLine }
  | { type: "latency"; kind: "local" | "cloud"; ms: number }
  | { type: "cost"; usd: number; inputTokens: number; outputTokens: number }
  | { type: "memory_size"; count: number; bytes: number };

export type ClientToServer =
  | { type: "type"; text: string }
  | { type: "set_mode"; mode: ModeName }
  | { type: "interrupt" };
