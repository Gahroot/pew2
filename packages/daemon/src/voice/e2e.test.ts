/** Task dispatch through the real Daemon and the local echo ACP agent: no key, no network. */
import { expect, test } from "bun:test";
import { handleMessage } from "../handler.js";
import { Daemon } from "../index.js";
import { scratch } from "./scratch.js";

test("a task runs on the echo agent and ends completed, with events in order", async () => {
  const env = { ...process.env, PEW2_HOME: scratch("pew2-voice-home-") };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  await daemon.refreshProviders();
  const voice = await daemon.voiceTasks();
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

test("a screenshot attached from the phone reaches the agent with the task, end to end", async () => {
  const env = { ...process.env, PEW2_HOME: scratch("pew2-voice-home-") };
  const daemon = new Daemon({ id: "t", name: "t" }, true, env);
  const broadcast: Array<Record<string, unknown>> = [];
  daemon.attach((m) => broadcast.push(m as Record<string, unknown>));
  await daemon.refreshProviders();
  const voice = await daemon.voiceTasks();
  const replies: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) =>
    handleMessage(JSON.stringify(m), { daemon, reply: (r) => replies.push(r as Record<string, unknown>), broadcast: () => {} });

  // A real 1x1 PNG, as the phone uploads it.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await send({ t: "voice.attach", requestId: "r1", name: "partner fix.png", mimeType: "image/png", data: png });
  const attached = replies.find((r) => r.t === "voice.attached") as { ok: boolean; attachment: { attachmentId: string } };
  expect(attached).toMatchObject({ ok: true, attachment: { name: "partner fix.png", mimeType: "image/png", sentTo: [] } });
  expect(broadcast.some((m) => m.t === "voice.attachments")).toBe(true);

  // What the model would do once the user says where it goes, aimed at the echo agent.
  const task = voice.orchestrator.enqueue({
    projectId: "p",
    projectName: "proj",
    cwd: scratch("pew2-voice-proj-"),
    providerId: "echo",
    title: "apply the fix",
    prompt: "Apply the partner's fix",
    attachmentIds: [attached.attachment.attachmentId],
  });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && voice.store.getTask(task.taskId)?.state !== "completed" && voice.store.getTask(task.taskId)?.state !== "failed") {
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = voice.store.getTask(task.taskId);
  daemon.closeAll();
  expect(done?.state).toBe("completed");

  // The user's turn, as every client sees it, carries the picture.
  const userTurn = broadcast
    .map((m) => (m as { payload?: { kind?: string; text?: string; attachments?: { name: string; uri: string }[] } }).payload)
    .find((e) => e?.kind === "user_message" && e.attachments?.length);
  expect(userTurn?.attachments?.[0]?.name).toBe("partner fix.png");
  expect(userTurn?.text).toContain("A screenshot is attached (partner fix.png)");
  // This agent advertises no image support, so it gets a link and the stored
  // path named in its text, which it echoes back: proof the file reached it.
  const said = broadcast
    .map((m) => (m as { payload?: { kind?: string; update?: { sessionUpdate?: string; content?: { text?: string } } } }).payload)
    .filter((p) => p?.update?.sessionUpdate === "agent_message_chunk")
    .map((p) => p?.update?.content?.text ?? "")
    .join("");
  const storedPath = userTurn?.attachments?.[0]?.uri ?? "missing";
  expect(said).toContain("Attached file (saved to disk)");
  expect(said).toContain(storedPath);
  expect(voice.store.screenshot(attached.attachment.attachmentId)?.sentTo).toEqual([task.taskId]);
}, 60_000);
