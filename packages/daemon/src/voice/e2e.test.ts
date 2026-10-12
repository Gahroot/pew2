/** Task dispatch through the real Daemon and the local echo ACP agent: no key, no network. */
import { expect, test } from "bun:test";
import { Daemon } from "../index.js";
import { scratch } from "./scratch.js";

test("a task runs on the echo agent and ends completed, with events in order", async () => {
  const env = { ...process.env, PEW2_HOME: scratch("pew2-voice-home-") };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  await daemon.refreshProviders();
  const voice = await daemon.voice();
  const events: string[] = [];
  voice.store.subscribe((e) => events.push(e.kind));
  const task = voice.orchestrator.enqueue({
    projectId: "p",
    projectName: "proj",
    cwd: scratch("pew2-voice-proj-"),
    providerId: "echo",
    title: "say hello",
    prompt: "hello world",
  });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && voice.store.getTask(task.taskId)?.state === "running") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = voice.store.getTask(task.taskId);
  daemon.closeAll();
  expect(done?.state).toBe("completed");
  expect(done?.sessionId).toBeTruthy();
  expect(events.slice(0, 2)).toEqual(["task.queued", "task.started"]);
  expect(events.at(-1)).toBe("task.completed");
  const ids = voice.store.eventsSince(0).map((e) => e.eventId);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
}, 60_000);
