// Run with: pnpm test
// Uses a throwaway HOME so it never touches the real ~/.kitt folder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "kitt-test-"));
process.env.HOME = tmpHome;
const BUS = path.join(tmpHome, ".kitt", "household");
const bus = await import("../src/household/comms-bus.js");

async function readFile<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(BUS, name), "utf-8")) as T;
}
async function reset() {
  await fs.rm(BUS, { recursive: true, force: true });
  bus._resetProcessedCache();
}
const base = { priority: "medium" as const, source: "email", done: false, createdAt: new Date().toISOString() };

before(reset);
after(() => fs.rm(tmpHome, { recursive: true, force: true }));

test("six accounts marking emails processed at once keep every id", async () => {
  await reset();
  const ids = Array.from({ length: 6 }, (_, a) => Array.from({ length: 20 }, (_, i) => `<acct${a}-msg${i}@x>`)).flat();
  await Promise.all(ids.map(id => bus.markProcessed(id)));
  bus._resetProcessedCache(); // simulate a restart
  const saved = new Set(await readFile<string[]>("processed-messages.json"));
  assert.equal(saved.size, ids.length);
  for (const id of ids) assert.ok(await bus.isProcessed(id), id);
});

test("parallel addTodo calls lose nothing", async () => {
  await reset();
  await Promise.all(Array.from({ length: 50 }, (_, i) => bus.addTodo({ ...base, title: `Task ${i}`, entity: "novara" })));
  assert.equal((await readFile<unknown[]>("todos.json")).length, 50);
});

test("a reworded copy of an open todo is not added twice", async () => {
  await reset();
  const a = await bus.addTodo({ ...base, title: "Call Ali back about the superintendent role", entity: "novara" });
  const b = await bus.addTodo({ ...base, title: "call Ali back about the superintendent role.", entity: "novara" });
  assert.equal(a.id, b.id);
  assert.equal((await bus.getOpenTodos()).length, 1);
});

test("same title in a different business is kept separately", async () => {
  await reset();
  await bus.addTodo({ ...base, title: "Send invoice", entity: "novara" });
  await bus.addTodo({ ...base, title: "Send invoice", entity: "homerepair" });
  assert.equal((await bus.getOpenTodos()).length, 2);
});

test("re-reading an email doesn't bring back a todo already checked off", async () => {
  await reset();
  const t = await bus.addTodo({ ...base, title: "Pay supplier", entity: "novara", sourceMsgId: "<m1@x>" });
  await bus.updateTodo(t.id, { done: true });
  await bus.addTodo({ ...base, title: "Pay supplier", entity: "novara", sourceMsgId: "<m1@x>" });
  assert.equal((await bus.getOpenTodos()).length, 0);
  assert.ok(await bus.hasTodosFromMessage("<m1@x>"));
  assert.equal(await bus.hasTodosFromMessage("<other@x>"), false);
});

test("a new email can still create a todo that matches an old finished one", async () => {
  await reset();
  const t = await bus.addTodo({ ...base, title: "Pay supplier", entity: "novara", sourceMsgId: "<m1@x>" });
  await bus.updateTodo(t.id, { done: true });
  await bus.addTodo({ ...base, title: "Pay supplier", entity: "novara", sourceMsgId: "<m2@x>" });
  assert.equal((await bus.getOpenTodos()).length, 1);
});

test("a corrupt todos.json is never overwritten", async () => {
  await reset();
  await fs.mkdir(BUS, { recursive: true });
  await fs.writeFile(path.join(BUS, "todos.json"), '[{"id":"1","title":"half writ');
  await assert.rejects(bus.addTodo({ ...base, title: "New", entity: "novara" }));
  assert.equal(await fs.readFile(path.join(BUS, "todos.json"), "utf-8"), '[{"id":"1","title":"half writ');
  assert.deepEqual(await bus.getOpenTodos(), []); // read-only views degrade to empty
});

test("a corrupt processed ledger starts fresh instead of stopping email intake", async () => {
  await reset();
  await fs.mkdir(BUS, { recursive: true });
  await fs.writeFile(path.join(BUS, "processed-messages.json"), "[\"<a@x>\",");
  assert.equal(await bus.isProcessed("<a@x>"), false);
  await bus.markProcessed("<b@x>");
  assert.deepEqual(await readFile<string[]>("processed-messages.json"), ["<b@x>"]);
});

test("dashboard edits only change allowed fields", async () => {
  await reset();
  const t = await bus.addTodo({ ...base, title: "Order lumber", entity: "novara" });
  const u = await bus.updateTodo(t.id, { done: true, id: "hijack", entity: "personal", priority: "urgent" });
  assert.ok(u);
  assert.equal(u!.id, t.id);
  assert.equal(u!.entity, "novara");
  assert.equal(u!.priority, "medium");
  assert.equal(u!.done, true);
  assert.ok(u!.doneAt);
  assert.equal(await bus.updateTodo("missing", { done: true }), null);
});

test("writes leave no temp files behind", async () => {
  await reset();
  await Promise.all(Array.from({ length: 10 }, (_, i) => bus.addTodo({ ...base, title: `T${i}`, entity: "x" })));
  const files = await fs.readdir(BUS);
  assert.deepEqual(files.filter(f => f.endsWith(".tmp")), []);
});
