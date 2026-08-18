export type Tier = "sprout" | "builder" | "maker" | "pro" | "tbd";

export interface NotebookEntry {
  timestamp: string;
  summary: string;
  learned?: string;
  flag?: string;
}

export interface Notebook {
  id: string;
  name: string;
  /** ISO date of birth (YYYY-MM-DD), or null if unknown. Source of truth for age. */
  dob: string | null;
  /** Snapshot age in years. Kept for prompt convenience; recompute from dob in long-running deployments. */
  age: number | null;
  tier: Tier;
  voicePrintHash?: string;
  whoTheyAre: string;
  howTheyLearn: string;
  currentWork: string;
  runningJokesAndStories: string;
  care: string;
  parentNotes: string;
  goals: string;
  lastInteractions: NotebookEntry[];
  updatedAt: string;
}
