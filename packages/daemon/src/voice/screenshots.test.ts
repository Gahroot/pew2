import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { wire } from "@pew2/protocol";
import { Orchestrator, type PromptImage, type VoiceHost } from "./dispatcher.js";
import { buildRegistry } from "./registry.js";
import { scratch } from "./scratch.js";
import { checkScreenshot, normaliseImageType, readScreenshot, screenshotDir, writeScreenshot } from "./screenshots.js";
import { VoiceStore } from "./store.js";
import { ToolExecutor } from "./tools.js";

/** The first bytes of each format, padded: enough to pass the signature check. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 2)]);
const b64 = (bytes: Buffer) => bytes.toString("base64");

describe("checkScreenshot", () => {
  test("a real PNG or JPEG is accepted, and image/jpg is read as JPEG", () => {
    expect(checkScreenshot("image/png", b64(PNG))).toMatchObject({ ok: true, mimeType: "image/png" });
    expect(checkScreenshot("image/jpg", b64(JPEG))).toMatchObject({ ok: true, mimeType: "image/jpeg" });
    expect(normaliseImageType("Image/PNG; charset=binary")).toBe("image/png");
  });

  test("anything that is not a raster picture is refused in words", () => {
    // SVG is a document that can carry script, whatever it is labelled.
    expect(checkScreenshot("image/svg+xml", b64(Buffer.from("<svg/>")))).toMatchObject({ ok: false });
    expect(checkScreenshot("text/html", b64(Buffer.from("<html>")))).toMatchObject({ ok: false });
    // The label says PNG; the bytes say otherwise.
    const lying = checkScreenshot("image/png", b64(Buffer.from("<script>alert(1)</script>")));
    expect(lying).toEqual({ ok: false, error: "That file says it is a picture but isn't one pew2 can read." });
  });

  test("damaged, empty and oversized uploads are refused before they are decoded", () => {
    expect(checkScreenshot("image/png", "not base64!")).toMatchObject({ ok: false });
    expect(checkScreenshot("image/png", "")).toMatchObject({ ok: false });
    const huge = "A".repeat(Math.ceil(((wire.MAX_ATTACHMENT_BYTES + 1) * 4) / 3 / 4) * 4);
    const result = checkScreenshot("image/png", huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("over the");
  });
});

test("a screenshot is written owner-only, under its id, and its phone name cannot escape", async () => {
  const dataDir = scratch();
  const path = await writeScreenshot(dataDir, "a_1", "../../etc/passwd", PNG);
  expect(path.startsWith(`${screenshotDir(dataDir)}/`)).toBe(true);
  // Separators are gone and the dots collapsed, so it stays one file in the directory.
  expect(readdirSync(screenshotDir(dataDir))).toEqual(["a_1-_._etc_passwd"]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(screenshotDir(dataDir)).mode & 0o777).toBe(0o700);
  expect(await readScreenshot(path, "x")).toBe(b64(PNG));
  await expect(readScreenshot(`${path}.gone`, "fix.png")).rejects.toThrow('The screenshot "fix.png" is no longer on the computer. Attach it again.');
});

describe("the store", () => {
  test("ids are the store's, persisted, and survive a reopen", async () => {
    const file = `${scratch()}/voice-state.json`;
    const store = await VoiceStore.open(file);
    expect(store.peekScreenshotId()).toBe("a_1");
    const shot = store.addScreenshot({ name: "fix.png", mimeType: "image/png", size: 10, path: "/x/a_1-fix.png" });
    expect(shot.attachmentId).toBe("a_1");
    store.markScreenshotSent("a_1", "t_1");
    store.markScreenshotSent("a_1", "t_1");
    await store.flush();
    const reopened = await VoiceStore.open(file);
    expect(reopened.screenshot("a_1")?.sentTo).toEqual(["t_1"]);
    expect(reopened.peekScreenshotId()).toBe("a_2");
  });

  test("pruning drops the oldest and the stale, but never one a queued task still has to send", () => {
    let now = 0;
    const store = VoiceStore.memory(() => now);
    for (let i = 0; i < 4; i++) {
      now = i * 1000;
      store.addScreenshot({ name: `s${i}.png`, mimeType: "image/png", size: 1, path: `/x/${i}` });
    }
    store.createTask({ projectId: "p", projectName: "p", cwd: "/p", providerId: "echo", title: "t", prompt: "x", attachmentIds: ["a_1"] });
    const removed = store.pruneScreenshots(2, 1_000_000);
    // Two over the cap: the oldest are a_1 and a_2, but a_1 is waiting to go out.
    expect(removed.map((s) => s.attachmentId)).toEqual(["a_2"]);
    now = 10_000_000;
    expect(store.pruneScreenshots(10, 1000).map((s) => s.attachmentId)).toEqual(["a_3", "a_4"]);
    expect(store.screenshots().map((s) => s.attachmentId)).toEqual(["a_1"]);
  });
});

function harness() {
  const store = VoiceStore.memory();
  const sent: { text: string; images: readonly PromptImage[] }[] = [];
  const host: VoiceHost = {
    async startSession() {
      return "s1";
    },
    prompt: (_id, text, images = []) => {
      sent.push({ text, images });
      return new Promise<void>(() => {});
    },
    async cancel() {},
    answerPermission: () => true,
    hasSession: () => true,
    lastText: () => undefined,
  };
  const files = new Map<string, string>();
  const orchestrator = new Orchestrator(store, host, {
    readAttachments: async (ids) =>
      ids.map((id) => {
        const shot = store.screenshot(id);
        const data = shot && files.get(shot.path);
        if (!shot || !data) throw new Error("The screenshot is no longer on the computer. Attach it again.");
        return { name: shot.name, mimeType: shot.mimeType, data };
      }),
  });
  const projects = buildRegistry(["/code/billing", "/code/pew2"], {});
  const executor = new ToolExecutor({ store, orchestrator, projects: async () => projects, usableProviders: () => ["echo"], rememberAlias: async () => undefined });
  let n = 0;
  const call = (name: string, args: Record<string, unknown> = {}) => executor.handle({ callId: `c${++n}`, name, args });
  const share = (name: string, keepFile = true) => {
    const shot = store.addScreenshot({ name, mimeType: "image/png", size: PNG.byteLength, path: `/shots/${name}` });
    if (keepFile) files.set(shot.path, b64(PNG));
    return shot.attachmentId;
  };
  return { store, sent, call, share };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("tools", () => {
  test("request_screenshot asks the phone to open its picker", async () => {
    const h = harness();
    const result = await h.call("request_screenshot", { reason: "the partner's fix" });
    expect(result).toMatchObject({ ok: true, openPicker: true, output: { pickerOpened: true, reason: "the partner's fix" } });
  });

  test("a new task carries the screenshot to the agent, named in the prompt, and records where it went", async () => {
    const h = harness();
    const id = h.share("partner-fix.png");
    const result = await h.call("start_task", { project: "billing", instruction: "Apply the fix in this screenshot", attachmentIds: [id] });
    expect(result.ok).toBe(true);
    await tick();
    await tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.images).toEqual([{ name: "partner-fix.png", mimeType: "image/png", data: b64(PNG) }]);
    expect(h.sent[0]?.text).toContain("Apply the fix in this screenshot");
    expect(h.sent[0]?.text).toContain("A screenshot is attached (partner-fix.png)");
    const task = h.store.tasks()[0];
    if (!task) throw new Error("no task was created");
    expect(task.attachmentIds).toEqual([id]);
    expect(task.pendingAttachmentIds).toBeUndefined();
    expect(h.store.screenshot(id)?.sentTo).toEqual([task.taskId]);
    // The model can see where it went, by name, never by path.
    const listed = (await h.call("list_screenshots")).output as { screenshots: Record<string, unknown>[] };
    expect(listed.screenshots[0]).toEqual({ attachmentId: id, name: "partner-fix.png", sentTo: [{ taskId: task.taskId, title: expect.any(String), project: "billing" }] });
    expect(JSON.stringify(listed)).not.toContain("/shots/");
  });

  test("attach_screenshot sends the one unsent screenshot to the one running task, after its current turn", async () => {
    const h = harness();
    await h.call("start_task", { project: "billing", instruction: "Fix the totals" });
    await tick();
    const id = h.share("fix.png");
    const result = await h.call("attach_screenshot", { instruction: "Use the partner's version of the function" });
    expect(result).toMatchObject({ ok: true, output: { sent: true, screenshot: "fix.png" } });
    expect(h.sent).toHaveLength(1); // queued behind the running turn, not sent over it
    expect(h.store.screenshot(id)?.sentTo).toEqual([]);
  });

  test("names it has to guess are refused or asked about, never guessed", async () => {
    const h = harness();
    expect((await h.call("start_task", { project: "billing", instruction: "x", attachmentIds: ["a_99"] })).error).toBe("No screenshot a_99. Call list_screenshots.");
    expect(h.store.tasks()).toHaveLength(0);
    expect((await h.call("attach_screenshot", {})).error).toContain("no unsent screenshot");
    h.share("one.png");
    h.share("two.png");
    expect((await h.call("attach_screenshot", {})).error).toContain("Several screenshots are unsent");
    // No task to send to: told to start one rather than having one invented.
    expect((await h.call("attach_screenshot", { attachmentId: "a_1" })).output).toMatchObject({ needsClarification: true });
  });

  test("a screenshot whose file has gone fails the task in words, rather than sending the prompt without it", async () => {
    const h = harness();
    const id = h.share("gone.png", false);
    await h.call("start_task", { project: "billing", instruction: "Apply it", attachmentIds: [id] });
    for (let i = 0; i < 4; i++) await tick();
    expect(h.sent).toHaveLength(0);
    const task = h.store.tasks()[0];
    expect(task?.state).toBe("failed");
    expect(task?.error).toContain("Attach it again");
  });
});
