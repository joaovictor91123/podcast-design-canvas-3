// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves issue #178 end to end:
// generate three local WebM speaker tracks, build a Riverside-style episode
// link that references them (a maintainer-owned local test link — no real
// network fetch, no third-party account), paste it into the real import
// field and click Import, and confirm Host/Guest 1/Guest 2 all populate with
// playable media and the composed preview renders all three tracks. Switch
// Split/Stack/Spotlight and confirm the imported tracks stay attached, click
// the real Export action and confirm the produced file is a genuinely
// playable video. Then paste an unsupported link and confirm a visible,
// recoverable error appears while the already-imported setup and export
// readiness remain fully intact. No committed media, mock previews,
// verifier-only product paths, or seeded output files are used.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run riverside-import verification.");
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      child.off("exit", onExit);
      resolve(ok);
    };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}

async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 7) return;
      await sleep(100 * (i + 1));
    }
  }
}

async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error("HTTP " + r.status);
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw last;
}

function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 220); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  // ~8.2s solid-color speaker video (uniform frames — trivially region-
  // distinguishable) with an audio tone, matching every other check's media.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = freq || 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 82; i++) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 320, 180);
      await sleep(100);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop();
    ac.close();
    stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }

  const stage = () => document.querySelector("#stage-canvas");

  await waitFor(() => window.PDC && window.PDC.riverside
    && document.querySelector("#riverside-link") && document.querySelector("#riverside-import-btn")
    && document.querySelector('[data-bucket="host"]') && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped riverside-import/bucket/export controls should exist");

  // Model semantics: the parser extracts host/guest1/guest2 track URLs and
  // rejects links with no recognizable track URL.
  {
    const parsed = window.PDC.riverside.parseRiversideLink("https://riverside.fm/studio/x?host=a.webm&guest1=b.webm&guest2=c.webm");
    assert(parsed.ok && parsed.tracks.host === "a.webm" && parsed.tracks.guest1 === "b.webm" && parsed.tracks.guest2 === "c.webm",
      "parseRiversideLink should extract all three track URLs");
    const bad = window.PDC.riverside.parseRiversideLink("https://riverside.fm/studio/x?foo=bar");
    assert(bad.ok === false, "parseRiversideLink should reject a link with no track URLs");
  }

  // Generate three local speaker tracks and a Riverside-style link that
  // references them by blob URL — a maintainer-owned LOCAL test link, exactly
  // as the verification contract describes (no real network fetch).
  const [hostFile, guest1File, guest2File] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest1.webm", "#10b981", 520),
    makeVideo("guest2.webm", "#2563eb", 700),
  ]);
  const hostUrl = URL.createObjectURL(hostFile);
  const guest1Url = URL.createObjectURL(guest1File);
  const guest2Url = URL.createObjectURL(guest2File);
  const link = "https://riverside.fm/studio/demo-episode?host=" + encodeURIComponent(hostUrl) +
    "&guest1=" + encodeURIComponent(guest1Url) + "&guest2=" + encodeURIComponent(guest2Url);

  const linkInput = document.querySelector("#riverside-link");
  linkInput.value = link;
  linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => /Imported 3 tracks/.test(document.querySelector("#riverside-status").textContent),
    "importing a Riverside link with three tracks should report three imported tracks", 300);
  const err = document.querySelector("#riverside-error");
  assert(err.hidden || !err.textContent.trim(), "a valid Riverside link import should not show an error");
  assert(linkInput.value === "", "the link field should clear after a successful import");

  // Host, Guest 1, and Guest 2 should all populate as real speaker buckets.
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 3, "three decoder videos should exist after import");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7),
    "imported speaker tracks should decode with a real duration", 420,
  );
  ["host", "guest1", "guest2"].forEach(function (bucket) {
    const row = document.querySelector('.bucket[data-bucket="' + bucket + '"]');
    assert(row.classList.contains("filled"), bucket + " bucket should show as filled after link import");
  });

  // The composed preview should render all three imported tracks.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split" && stage().dataset.speakers === "3", "Split preview should compose all three imported tracks");

  // PRESET SWITCHES: the imported tracks must stay attached across layouts.
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId && stage().dataset.speakers === "3", presetId + " should keep all three imported tracks composed");
  }
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and confirm a genuinely playable file.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled with all three imported tracks");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 760,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);
  const exportedVideo = document.createElement("video");
  exportedVideo.muted = true;
  exportedVideo.src = URL.createObjectURL(blob);
  await new Promise((r) => { exportedVideo.onloadedmetadata = r; exportedVideo.onerror = r; setTimeout(r, 5000); });
  assert(exportedVideo.videoWidth > 0 && exportedVideo.videoHeight > 0, "exported file should be a playable video with real dimensions");

  // INVALID LINK: an unsupported link must show a visible, recoverable error
  // while the already-imported setup and export readiness remain intact.
  const beforeInvalid = {
    videoCount: document.querySelectorAll("video[data-speaker]").length,
    preset: stage().dataset.preset,
    exportDisabled: document.querySelector("#export").disabled,
  };
  const badLinkInput = document.querySelector("#riverside-link");
  badLinkInput.value = "https://example.com/not-a-riverside-link?foo=bar";
  badLinkInput.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => !document.querySelector("#riverside-error").hidden, "an unsupported link should show a visible error", 100);
  assert(/track/i.test(document.querySelector("#riverside-error").textContent), "the error should explain the link has no track URLs");
  assert(document.querySelectorAll("video[data-speaker]").length === beforeInvalid.videoCount, "an unsupported link must not drop the already-imported speaker tracks");
  assert(stage().dataset.preset === beforeInvalid.preset, "an unsupported link must not change the selected preset");
  assert(document.querySelector("#export").disabled === beforeInvalid.exportDisabled, "an unsupported link must not change export readiness");

  return {
    bucketsFilled: ["host", "guest1", "guest2"].map(function (b) {
      return document.querySelector('.bucket[data-bucket="' + b + '"]').classList.contains("filled");
    }),
    exportBytes: blob.size,
    exportDimensions: exportedVideo.videoWidth + "x" + exportedVideo.videoHeight,
    invalidLinkHandledCleanly: true,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", {
      expression: browserExpression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-riverside-import: OK — Riverside-style link import populates all three speaker buckets, composes and exports correctly, and rejects unsupported links cleanly");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => {
  console.error(`verify-riverside-import: ${e.message}`);
  process.exit(1);
});
