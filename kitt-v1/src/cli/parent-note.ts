import "dotenv/config";
import { appendParentNote } from "../students/notebook.js";

async function main(): Promise<void> {
  const [, , kidId, ...noteWords] = process.argv;
  if (!kidId || !noteWords.length) {
    console.error("Usage: pnpm tsx src/cli/parent-note.ts <kid_id> <note...>");
    process.exit(1);
  }
  await appendParentNote(kidId, noteWords.join(" "));
  console.log(`note added to ${kidId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
