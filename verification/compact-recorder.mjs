#!/usr/bin/env node
// Own Electron profile + real native writers, generated inputs only. No cloud or clipboard.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  chmod,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "../viewer/node_modules/playwright/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = resolve(
  process.env.RUSHES_COMPACT_EVIDENCE ??
    join(tmpdir(), `rushes-compact-evidence-${Date.now()}`),
);
await mkdir(dirname(evidence), { recursive: true });
await mkdir(evidence, { mode: 0o700 });
const profile = await mkdtemp(join(tmpdir(), "rushes-compact-"));
const recordings = join(profile, "recordings");
const exports = join(profile, "exports");
await Promise.all([mkdir(recordings), mkdir(exports)]);
const report = {
  status: "running",
  generatedOnly: true,
  physicalCoverage: false,
  profile,
  evidence,
  checks: [],
  errors: [],
  commands: [],
};
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const command = (file, args) => {
  const output = execFileSync(file, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  report.commands.push({ file, args, exit: 0, output });
  return output;
};
async function until(test, label, timeout = 15_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    try {
      if (await test()) return;
    } catch (error) {
      // A state transition invalidates only this read. The original polling
      // deadline still applies, and a fresh matching state is still required.
      if (error?.code !== 'status-superseded') throw error;
      report.supersededStatusReads = (report.supersededStatusReads ?? 0) + 1;
    }
    await delay(75);
  }
  throw new Error(`Timed out: ${label}`);
}
const enginePath = join(root, ".build/debug/rushcore-engine");
const mainPath = join(root, "shell/dist/main/index.cjs");
const electronPath = createRequire(import.meta.url)(
  "../shell/node_modules/electron",
);
report.identity = {
  commit: command("git", ["rev-parse", "HEAD"]).trim(),
  diffSha256: createHash("sha256")
    .update(command("git", ["diff", "--binary"]))
    .digest("hex"),
  engineSha256: await sha(enginePath),
  mainSha256: await sha(mainPath),
  runnerSha256: await sha(fileURLToPath(import.meta.url)),
  node: process.version,
  shell: JSON.parse(await readFile(join(root, "shell/package.json"), "utf8"))
    .devDependencies.electron,
};
const settings = {
  mode: "display",
  source: "display-diagnostic",
  camera: "none",
  mic: "mic-diagnostic",
  systemAudio: true,
  autoShare: false,
  countdownSeconds: 3,
  bubbleSize: 200,
  editorCommandTemplate: "",
};
await writeFile(join(profile, "settings.json"), JSON.stringify(settings));
const bootstrap = join(profile, "bootstrap.cjs");
await writeFile(
  bootstrap,
  `const {app,dialog,shell}=require('electron');
const fs=require('node:fs'); const path=require('node:path');
app.setPath('userData',${JSON.stringify(join(profile, "electron"))});
app.on('web-contents-created',(_,contents)=>contents.setAudioMuted(true));
const log=(value)=>fs.appendFileSync(${JSON.stringify(join(evidence, "dialogs.jsonl"))},JSON.stringify(value)+'\\n');
app.on('browser-window-created',(_,window)=>{const windowId=window.id;for(const event of ['show','hide','minimize','restore','focus','blur','closed'])window.on(event,()=>log({kind:'window',event,id:windowId,at:Date.now(),visible:window.isDestroyed()?false:window.isVisible(),minimized:window.isDestroyed()?false:window.isMinimized()}));});
const {ipcMain}=require('electron');const register=ipcMain.handle.bind(ipcMain);let commandId=0;ipcMain.handle=(channel,listener)=>register(channel,async(event,value)=>{const id=++commandId;const watched=['rushes:save-options','rushes:window'].includes(channel);if(watched)log({kind:'ipc-entry',id,channel,at:Date.now(),value:channel==='rushes:save-options'?{mode:value.mode,source:value.source,camera:value.camera,mic:value.mic}:value});try{const result=await listener(event,value);if(watched)log({kind:'ipc-return',id,channel,at:Date.now()});return result;}catch(error){if(watched)log({kind:'ipc-error',id,channel,at:Date.now(),code:error.code});throw error;}});
dialog.showSaveDialog=async(options)=>{const filePath=path.join(${JSON.stringify(exports)},path.basename(options.defaultPath));log({kind:'save',filePath});return {canceled:false,filePath};};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(exports)}]});
dialog.showMessageBox=async(...args)=>{log({kind:'message',args});return {response:0,checkboxChecked:false};};
shell.showItemInFolder=(filePath)=>log({kind:'reveal',filePath});
require(${JSON.stringify(mainPath)});`,
);
const adapter = join(profile, "engine-stub");
await writeFile(
  adapter,
  `#!/bin/sh\nexec '${enginePath.replaceAll("'", "'\\''")}' --capture-stub "$@"\n`,
  { mode: 0o700 },
);
const engineLog = createWriteStream(join(evidence, "engine.log"));
const engine = spawn(
  enginePath,
  [
    "--capture-stub",
    "--socket-path",
    join(profile, "control.sock"),
    "--recordings-root",
    recordings,
    "--index-path",
    join(profile, "index.sqlite"),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let engineText = "";
engine.on("exit", (code, signal) => {
  report.engineTermination = { code, signal, at: new Date().toISOString() };
});
engine.stdout.on("data", (data) => {
  engineText += data;
  engineLog.write(data);
});
engine.stderr.pipe(engineLog, { end: false });
let app, page, appProcess;
const events = [];
const check = (name, detail = {}) => {
  report.checks.push({ name, ...detail });
  console.log(`PASS ${name}`);
};
async function call(name, ...args) {
  let timer;
  try {
    const result = await Promise.race([
      page.evaluate(({ name, args }) => window.rushes[name](...args), {
        name,
        args,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`IPC ${name} exceeded verifier deadline`)),
          45_000,
        );
      }),
    ]);
    const error = result?.__rushesError;
    if (typeof error?.code === "string" && typeof error?.message === "string")
      throw Object.assign(new Error(error.message), { code: error.code });
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function primaryBounds() {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter(
        (w) =>
          w.webContents.getURL().includes("#recorder") ||
          w.webContents.getURL().includes("#review") ||
          w.webContents.getURL().includes("#editor") ||
          w.webContents.getURL().includes("#library") ||
          w.webContents.getURL().includes("#settings"),
      )
      .map((w) => ({
        id: w.id,
        bounds: w.getBounds(),
        minimized: w.isMinimized(),
      })),
  );
}
async function resize(width, height) {
  await (
    await app.browserWindow(page)
  ).evaluate((w, size) => w.setBounds(size), { width, height });
  await until(
    async () => (await page.evaluate(() => innerWidth)) === width,
    "window resize",
  );
}
async function layout(label) {
  await page.waitForFunction(() => {
    const images = [document.querySelector('.screen-snapshot'), document.querySelector('img[alt="Live camera preview"]')];
    return images.every(image => image?.complete && image.naturalWidth > 0)
      && !document.querySelector('[aria-label="Microphone signal"]').getAttribute('aria-valuetext').includes('Waiting');
  });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const result = await page.evaluate(() => {
    const selectors = [
      ".compact-intents",
      ".compact-source-row",
      ".capture-stage",
      '[aria-label="Camera device"]',
      '[aria-label="Microphone device"]',
      '[data-tour="start"]',
    ];
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      items: selectors.map((selector) => {
        const el = document.querySelector(selector);
        if (!el) return { selector, missing: true };
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          ...r.toJSON(),
          selector,
          hit: !!hit && (el.contains(hit) || hit.contains(el)),
        };
      }),
      circles: [...document.querySelectorAll(".window-control")].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          radius: getComputedStyle(el).borderRadius,
          region: getComputedStyle(el).webkitAppRegion,
        };
      }),
      dragRegion: getComputedStyle(document.querySelector(".window-chrome"))
        .webkitAppRegion,
    };
  });
  assert(result.scrollWidth <= result.width, JSON.stringify(result));
  for (const item of result.items)
    assert(
      !item.missing &&
        item.width > 0 &&
        item.height > 0 &&
        item.x >= 0 &&
        item.y >= 0 &&
        item.x + item.width <= result.width + 1 &&
        item.y + item.height <= result.height + 1 &&
        item.hit,
      JSON.stringify(item),
    );
  assert.equal(result.circles.length, 3);
  for (const circle of result.circles) {
    assert.equal(circle.width, 14);
    assert.equal(circle.height, 14);
    assert.equal(circle.radius, "50%");
    assert.equal(circle.region, "no-drag");
  }
  assert.equal(result.dragRegion, "drag");
  await page.screenshot({ path: join(evidence, `${label}.png`) });
  check(label, result);
}
try {
  await until(
    () => engineText.includes('"capture":"stub"'),
    "explicit generated capture readiness",
  );
  // This launch can activate an owned app. Never synthesize OS keyboard/mouse input.
  const idle = Number(
    command("/bin/sh", [
      "-c",
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'",
    ]).trim(),
  );
  const inputOverride = process.env.RUSHES_COMPACT_INPUT_OVERRIDE === "1";
  report.inputGate = { idleSeconds: idle, explicitOverride: inputOverride };
  assert(
    idle >= 3 || inputOverride,
    "Input active; leave this generated verifier pending until idle.",
  );
  const env = {
    ...process.env,
    RUSHES_DATA_DIR: profile,
    RUSHES_RECORDINGS_ROOT: recordings,
    RUSHES_ENGINE_PATH: adapter,
    RUSHES_TEST_ENGINE_STUB: "1",
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("RUSHES_SMOKE") ||
      key === "ELECTRON_RUN_AS_NODE" ||
      key === "RUSHES_DEV_URL"
    )
      delete env[key];
  app = await _electron.launch({
    executablePath: electronPath,
    args: [bootstrap],
    env,
    timeout: 20_000,
  });
  appProcess = app.process();
  report.identity.runtime = await app.evaluate(() => process.versions);
  const stdout = createWriteStream(join(evidence, "electron.stdout"));
  const stderr = createWriteStream(join(evidence, "electron.stderr"));
  appProcess.stdout?.pipe(stdout);
  appProcess.stderr?.pipe(stderr);
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.waitForFunction(() => !!window.rushes);
  await page.evaluate(() => (window.__compactEvents = []));
  await page.evaluate(() =>
    window.rushes.onEvent((e) => {
      if (
        !["camera-preview", "microphone-level", "screen-preview"].includes(
          e.event,
        )
      )
        window.__compactEvents.push(e);
    }),
  );
  await page.getByRole("button", { name: "Skip guide", exact: true }).click();
  assert.equal((await call("onboarding", "get")).status, "dismissed");
  await page
    .getByRole("button", { name: "Screen + camera", exact: true })
    .click();
  await page.locator('img[alt="Live camera preview"]').waitFor();
  await page.locator(".screen-snapshot").waitFor();
  await until(
    async () =>
      Number(
        await page
          .getByRole("meter", { name: "Microphone signal" })
          .getAttribute("aria-valuenow"),
      ) > 0,
    "live native mic meter",
  );
  await until(
    async () =>
      (
        await page
          .getByRole("meter", { name: "Microphone signal" })
          .getAttribute("aria-valuetext")
      ).includes("Too loud"),
    "native clipping feedback",
  );
  check("automatic-native-feedback");
  assert.equal((await primaryBounds()).length, 1);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
    "no idle overlay window",
  );
  assert.equal((await primaryBounds())[0].bounds.width, 420);
  await layout("recorder-default");
  const primaryId = (await primaryBounds())[0].id;
  await page.getByRole("button", { name: "Full view", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.view === "library");
  assert.equal((await primaryBounds())[0].id, primaryId);
  assert.equal((await primaryBounds())[0].bounds.width, 1120);
  assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length), 1);
  await page.screenshot({ path: join(evidence, "full-view.png") });
  await page.getByRole("button", { name: "Simple view", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.view === "recorder");
  assert.equal((await primaryBounds())[0].id, primaryId);
  assert.equal((await primaryBounds())[0].bounds.width, 420);
  await page.getByRole("button", { name: "Full view", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.view === "library");
  await app.evaluate(({BrowserWindow, app}) => {
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("#library")).hide();
    app.emit("activate");
  });
  await page.waitForFunction(() => document.documentElement.dataset.view === "recorder");
  assert.equal((await primaryBounds())[0].id, primaryId);
  assert.equal((await primaryBounds())[0].bounds.width, 420);
  check("simple-full-toggle-and-reopen");
  await resize(400, 600);
  await layout("recorder-small");
  await call("onboarding", "reset");
  for (let i = 0; i < 6; i++) {
    const card = page.locator(".tour-card");
    await card.waitFor();
    const rect = await card.boundingBox();
    assert(
      rect &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= 400 &&
        rect.y + rect.height <= 600,
    );
    await page.screenshot({ path: join(evidence, `tour-${i}.png`) });
    const guideContent = await card.evaluate(element => {
      const cardBounds = element.getBoundingClientRect();
      return ['#tour-title', '#tour-description', '.tour-actions', '.tour-keyboard'].map(selector => {
        const bounds = element.querySelector(selector).getBoundingClientRect();
        return {selector, visible: bounds.top >= cardBounds.top && bounds.bottom <= cardBounds.bottom};
      });
    });
    assert(guideContent.every(part => part.visible), `Guide step ${i + 1} clips content: ${JSON.stringify(guideContent)}`);
    await page
      .getByRole("button", {
        name: i === 0 ? "Show me around" : i === 5 ? "Finish guide" : "Next",
        exact: true,
      })
      .click();
  }
  assert.equal((await call("onboarding", "get")).status, "completed");
  check("onboarding-small-skip-complete");
  await page.getByLabel("Screen capture area").selectOption("window");
  await page.locator(".screen-snapshot").waitFor();
  assert.equal((await call("bootstrap")).options.source, "window-diagnostic");
  check("window-source-feedback");
  await page.getByLabel("Screen capture area").selectOption("area");
  await until(
    async () => (await call("bootstrap")).options.mode === "area",
    "generated area mode",
  );
  await call("saveOptions", {
    ...(await call("bootstrap")).options,
    mode: "area",
    source: "display-diagnostic",
    area: { x: 10, y: 10, width: 320, height: 240 },
  });
  await page.locator(".screen-snapshot").waitFor();
  check("generated-area-feedback", { actualDesktopPicker: false });
  await page.getByRole("button", { name: "Camera only", exact: true }).click();
  await until(
    async () => (await page.locator(".screen-snapshot").count()) === 0,
    "screen removed for camera only",
  );
  await page.locator('img[alt="Live camera preview"]').waitFor();
  check("camera-only-screen-off");
  await page.getByRole("button", { name: "Screen only", exact: true }).click();
  await until(
    async () =>
      (await page.locator('[aria-label="Camera preview"]').count()) === 0,
    "camera removed for screen only",
  );
  await page
    .getByRole("button", { name: "Screen + camera", exact: true })
    .click();
  await page.getByLabel("Screen capture area").selectOption("display");
  await page.locator('img[alt="Live camera preview"]').waitFor();
  await page.locator(".compact-more > summary").click();
  await page.getByLabel("Countdown", { exact: true }).selectOption("5");
  await until(
    async () => (await call("bootstrap")).options.countdownSeconds === 5,
    "five-second cancellation probe",
  );
  await page.getByLabel("System audio", { exact: true }).click();
  await until(
    () => page.getByLabel("System audio", { exact: true }).isChecked(),
    "system audio selection",
  );
  await page.locator(".compact-more > summary").click();
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Cancel countdown", exact: true })
    .waitFor();
  await until(
    async () =>
      /^[1-5]$/.test(
        await page.locator(".capture-countdown strong").innerText(),
      ),
    "visible native countdown",
  );
  await page
    .getByRole("button", { name: "Cancel countdown", exact: true })
    .click();
  await until(
    async () => (await call("request", "status")).state === "idle",
    "cancel countdown",
  );
  await until(
    () =>
      page
        .getByRole("button", { name: "Start recording", exact: true })
        .isEnabled(),
    "recorder restored after cancel",
  );
  check("visible-native-countdown-cancel-and-return");
  assert.equal(
    await page.getByRole("alert", { name: "Action error" }).count(),
    0,
    "expected cancellation is not a recording error",
  );
  await page
    .getByRole("button", { name: "Start recording", exact: true })
    .click();
  await until(
    async () => (await call("request", "status")).state === "recording",
    "start/countdown",
  );
  await until(
    async () => (await primaryBounds())[0].minimized,
    "automatic minimize",
  );
  await delay(2200);
  await call("request", "record.pause");
  assert.equal((await call("request", "status")).state, "paused");
  await delay(250);
  await call("request", "record.resume");
  await delay(1800);
  const live = await call("request", "status");
  const id = live.recording.recordingID;
  await call("request", "record.stop");
  await page.locator(".quick-review").waitFor({ timeout: 20_000 });
  await until(
    async () => (await call("request", "status")).state === "idle",
    "native cleanup",
  );
  check("generated-take-countdown-pause-stop", { id });
  const show = await call("request", "show", { id });
  report.recording = show;
  assert.equal(
    show.tracks.filter((t) => t.present).length,
    4,
    "all generated tracks enabled",
  );
  const originals = {};
  for (const track of show.tracks.filter((t) => t.present))
    originals[track.file] = await sha(track.path);
  await page
    .getByRole("button", { name: "Play or pause", exact: true })
    .click();
  await until(
    async () =>
      await page.evaluate(() =>
        [...document.querySelectorAll("video")].some(
          (v) => v.currentTime > 0.5,
        ),
      ),
    "actual original playback",
  );
  await page
    .getByRole("button", { name: "Play or pause", exact: true })
    .click();
  await page.getByLabel("Playhead", { exact: true }).focus();
  await page.getByLabel("Playhead", { exact: true }).press("Home");
  await page.getByLabel("Playhead", { exact: true }).press("ArrowRight");
  await until(
    async () =>
      Number(await page.getByLabel("Playhead", { exact: true }).inputValue()) >
      0,
    "seek control",
  );
  check("original-playback-seek");
  const warningText = show.manifest.warnings.find(warning => warning.message?.includes('digital silence'))?.message;
  assert(warningText, 'Generated silent microphone must exercise warning presentation');
  const notices = await page.locator('.alert').evaluateAll(elements => elements.map(element => ({
    text: [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
    warning: element.classList.contains('warning'),
  })));
  const savedWarnings = notices.filter(notice => notice.text === warningText);
  assert.equal(savedWarnings.length, 1, 'Saved warning must appear once');
  assert(savedWarnings[0].warning, 'A saved warning must use warning styling');
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  report.reviewGeometry = await page.evaluate(() => ({scrollY, appScroll:document.querySelector('.app').scrollTop, pageScroll:document.querySelector('.page').scrollTop, items:['.window-chrome','.compact-header','.main','.page','.quick-review'].map(selector => {const element=document.querySelector(selector);return {selector,rect:element.getBoundingClientRect().toJSON(),display:getComputedStyle(element).display};})}));
  await page.screenshot({ path: join(evidence, "quick-review.png") });
  const reviewWindow = await app.browserWindow(page);
  const nativeReview = await reviewWindow.evaluate(async window => ({
    image: (await window.webContents.capturePage(undefined, {stayHidden:true})).toDataURL(),
    mediaSourceId: window.getMediaSourceId(),
  }));
  await writeFile(join(evidence, 'quick-review-native.png'), Buffer.from(nativeReview.image.split(',')[1], 'base64'));
  report.reviewMediaSourceId = nativeReview.mediaSourceId;
  const nativeWindowId = /^window:(\d+):/.exec(nativeReview.mediaSourceId)?.[1];
  if (nativeWindowId && process.platform === 'darwin') {
    try { command('/usr/sbin/screencapture', ['-x', '-l', nativeWindowId, join(evidence, 'quick-review-window.png')]); }
    catch (error) { report.windowScreenshotError = String(error); }
  }
  const title = `Compact ${randomUUID()}`;
  const titleInput = page.getByLabel("Recording title", { exact: true });
  await titleInput.fill(title);
  await page.getByRole("button", { name: "Edit video", exact: true }).click();
  await page.locator(".review-content:not(.quick-review)").waitFor();
  assert.equal(await titleInput.inputValue(), title);
  assert((await primaryBounds())[0].bounds.width >= 800);
  assert.equal((await call("request", "show", { id })).manifest.title, title);
  await page.getByText("Layout & appearance", { exact: true }).click();
  await page.getByLabel("Video layout").selectOption("camera-only");
  await page.getByRole("button", { name: /Compact review/ }).click();
  await page.locator(".quick-review").waitFor();
  assert.equal((await primaryBounds())[0].bounds.width, 400);
  check("edit-expansion-preserves-draft");
  // A refused save must keep the review and restore bounds without another navigation/save loop.
  await chmod(show.packagePath, 0o500);
  try {
    await titleInput.fill(title + " write denied");
    await call("window", "library");
    await page.getByText(/Save the current draft before leaving:/).waitFor();
    await until(
      async () => (await primaryBounds())[0].bounds.width === 400,
      "failed-save geometry restoration",
    );
    const before = await page.evaluate(
      () => window.__compactEvents.filter((e) => e.event === "navigate").length,
    );
    await delay(1200);
    assert.equal(
      await page.evaluate(
        () =>
          window.__compactEvents.filter((e) => e.event === "navigate").length,
      ),
      before,
      "failed save navigation loop",
    );
    assert.equal(await page.locator(".quick-review").count(), 1);
    check("save-failure-refuses-navigation-without-loop");
  } finally {
    await chmod(show.packagePath, 0o700);
  }
  await titleInput.fill(title);
  await page
    .getByRole("button", { name: "Save video", exact: true })
    .filter({ visible: true })
    .click();
  const mp4 = join(exports, `Rushes-${id}.mp4`);
  await until(
    async () => {
      try {
        return (await readFile(mp4)).length > 100;
      } catch {
        return false;
      }
    },
    "MP4 saved",
    45_000,
  );
  await until(
    async () =>
      await page
        .getByRole("button", { name: "Save video", exact: true })
        .filter({ visible: true })
        .isEnabled(),
    "export completion",
    45_000,
  );
  await page
    .getByRole("button", { name: "Save separate tracks", exact: true })
    .filter({ visible: true })
    .click();
  await until(
    async () => {
      try {
        return (await readdir(join(exports, `Rushes-${id}`))).length > 0;
      } catch {
        return false;
      }
    },
    "original exports",
    30_000,
  );
  await until(
    async () =>
      await page
        .getByRole("button", { name: "Save separate tracks", exact: true })
        .filter({ visible: true })
        .isEnabled(),
    "separate export completion",
    30_000,
  );
  const exported = [];
  for (const [name, hash] of Object.entries(originals)) {
    assert.equal(await sha(join(show.packagePath, name)), hash);
    const path = join(exports, `Rushes-${id}`, name);
    assert.equal(await sha(path), hash, "exported original bytes");
    exported.push(path);
  }
  const decode = [];
  for (const path of [
    mp4,
    ...Object.keys(originals).map((name) => join(show.packagePath, name)),
    ...exported,
  ]) {
    const text = command("/usr/bin/which", ["ffmpeg"]).trim();
    command(text, ["-v", "error", "-i", path, "-f", "null", "-"]);
    decode.push({ path, sha256: await sha(path), exit: 0 });
  }
  check("composite-and-separate-exports-decode", {
    decode,
    originalsUnchanged: true,
  });
  events.push(...(await page.evaluate(() => window.__compactEvents ?? [])));
  await page.reload();
  await page.evaluate(() => {
    window.__compactEvents = [];
    window.rushes.onEvent((e) => {
      if (
        !["camera-preview", "microphone-level", "screen-preview"].includes(
          e.event,
        )
      )
        window.__compactEvents.push(e);
    });
  });
  await page.locator(".quick-review").waitFor();
  await until(
    async () =>
      (await page
        .getByLabel("Recording title", { exact: true })
        .inputValue()) === title,
    "review identity after renderer reload",
  );
  assert.equal(
    (await call("request", "edit.get", { id })).layout.preset,
    "camera-only",
  );
  assert.equal((await call("onboarding", "get")).status, "completed");
  check("renderer-reload-restores-recording-draft-guide-choice");
  await call("window", "recorder");
  await page.locator(".screen-snapshot").waitFor();
  await call("window", "close");
  await until(
    async () => (await call("request", "status")).preflightQuiescent === true,
    "hidden input cleanup",
  );
  check("hidden-recorder-releases-input-feedback");
  await call("openRecording", id);
  await page.locator(".quick-review").waitFor();
  const finalTitle = title + " saved on Quit";
  await titleInput.fill(finalTitle);
  events.push(...(await page.evaluate(() => window.__compactEvents ?? [])));
  await call("window", "quit");
  await until(() => appProcess.exitCode !== null, "clean Quit", 15_000);
  assert.equal(
    JSON.parse(await readFile(join(show.packagePath, "manifest.json"), "utf8"))
      .title,
    finalTitle,
  );
  check("quit-flushed-title", { title: finalTitle });
  assert.deepEqual(report.errors, [], "renderer errors");
  report.status = "verified";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack ?? error);
  console.error(report.failure);
  process.exitCode = 1;
  if (page) {
    try {
      events.push(...(await page.evaluate(() => window.__compactEvents)));
      await page.screenshot({ path: join(evidence, "failure.png") });
      report.visibleText = await page.locator("body").innerText();
      report.failureWindows = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(window => ({id:window.id, visible:window.isVisible(), minimized:window.isMinimized(), focused:window.isFocused()})));
      const bootstrap = await call('bootstrap');
      report.failureInputs = {options:bootstrap.options, inputPreflight:bootstrap.inputPreflight};
      report.failureNativeStatus = await call('request', 'status');
    } catch (diagnosticError) { report.failureDiagnosticError = String(diagnosticError); }
  }
} finally {
  if (appProcess && appProcess.exitCode === null) {
    try {
      await Promise.race([
        app.close(),
        delay(5000).then(() => {
          throw new Error("close timeout");
        }),
      ]);
    } catch {
      appProcess.kill("SIGKILL");
    }
  }
  engine.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => engine.once("exit", done)),
    delay(3000),
  ]);
  if (engine.exitCode === null) engine.kill("SIGKILL");
  engineLog.end();
  report.engineExit = engine.exitCode;
  await cp(recordings, join(evidence, "recordings"), { recursive: true });
  await cp(exports, join(evidence, "exports"), { recursive: true });
  report.retainedMedia = {
    recordings: join(evidence, "recordings"),
    exports: join(evidence, "exports"),
  };
  await writeFile(
    join(evidence, "events.json"),
    JSON.stringify(events, null, 2),
  );
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      status: report.status,
      evidence,
      checks: report.checks.length,
    }),
  );
}
