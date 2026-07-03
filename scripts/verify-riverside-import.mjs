// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves issue #195 end to end,
// using EXACTLY the verification contract's own scenario: open the product,
// use the Riverside/import-link control, paste the repo's declared sample
// Riverside-style manifest link (app/riverside-sample.js — a maintainer-
// provided local fixture: a self-contained "data:application/json;base64,..."
// manifest whose three tracks are themselves small "data:video/webm;base64,.."
// clips, so resolving it needs no network access and no browser file-access
// permissions at all), click Import, and observe Host/Guest 1/Guest 2 all
// populate with real, distinctly-colored video tracks rendering in the
// composed preview. Switch Split/Stack/Spotlight and confirm the imported
// videos rerender (by color) in each distinct layout, then click Export and
// load the produced file back into a video element: it must have real
// dimensions, non-trivial bytes, and visibly nonblank decoded frames. A
// second check confirms an unsupported link still fails with a visible,
// recoverable error and leaves the already-imported setup untouched. No
// network access, seeded external media, or verifier-only product paths are
// used — the fixture is a committed, self-contained data: URI manifest, which
// is this issue's own explicitly-requested scope (a local fixture/manifest,
// not live Riverside network integration).
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
  const stage = () => document.querySelector("#stage-canvas");

  // #presets being populated only happens once app/ui.js's whole top-level
  // IIFE body has executed — which is also when every click listener
  // (including the Riverside import button's) is already attached. Checking
  // only for DOM elements isn't enough: the browser parses them into the
  // document before the <script> tags after them ever run.
  await waitFor(() => window.PDC && window.PDC.riverside && window.PDC.riversideSample
    && document.querySelector("#riverside-link") && document.querySelector("#riverside-sample-btn")
    && document.querySelector("#riverside-import-btn") && document.querySelector('[data-bucket="host"]')
    && document.querySelector("#export") && document.querySelector("#scrub")
    && document.querySelectorAll("#presets button").length > 0,
    "shipped riverside-import/bucket/export controls should exist and app/ui.js should have finished initializing");

  // Model semantics: the repo's declared sample manifest link decodes to
  // three real speaker tracks, and a trackless link is rejected.
  {
    const parsed = window.PDC.riverside.parseRiversideLink(window.PDC.riversideSample.LINK);
    assert(parsed.ok && parsed.tracks.host && parsed.tracks.guest1 && parsed.tracks.guest2,
      "the declared sample manifest link should parse to three speaker tracks");
    const bad = window.PDC.riverside.parseRiversideLink("https://riverside.fm/studio/x?foo=bar");
    assert(bad.ok === false, "parseRiversideLink should reject a link with no track URLs");
  }

  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor((region ? region.x0 : 0) / 100 * w), x1 = Math.floor((region ? region.x1 : 100) / 100 * w);
    const y0 = Math.floor((region ? region.y0 : 0) / 100 * h), y1 = Math.floor((region ? region.y1 : 100) / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let red = 0, green = 0, blue = 0, bright = 0;
    const n = data.length / 4;
    // Classify by DOMINANT channel (margin tolerant of encoder loss) rather
    // than absolute per-channel thresholds — the fixture's guest2 blue
    // (#2563eb = 37,99,235) has a moderate green component that an absolute
    // "g < 90" cutoff would wrongly reject even though blue clearly dominates.
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > g + 20 && r > b + 20 && r > 100) red++;
      if (g > r + 20 && g > b + 20 && g > 100) green++;
      if (b > r + 20 && b > g + 20 && b > 100) blue++;
      if (r > 40 || g > 40 || b > 40) bright++;
    }
    return { red: red / n, green: green / n, blue: blue / n, bright: bright / n };
  }
  // The fixture's three tracks are solid red/green/blue — after import, all
  // three colors must be visible somewhere in the composed canvas, proving
  // three DISTINCT real videos are rendering (not one track repeated, and
  // not a blank/placeholder frame).
  function allThreeColorsPresent() {
    const s = regionStats(stage());
    return s.red > 0.02 && s.green > 0.02 && s.blue > 0.02;
  }

  // USE THE RIVERSIDE/IMPORT-LINK CONTROL: click "Use sample link" to fill
  // the field with the repo's declared sample manifest link (a creator could
  // equally paste it directly — this exercises the same real input/listener
  // path), then click Import.
  document.querySelector("#riverside-sample-btn").click();
  assert(document.querySelector("#riverside-link").value === window.PDC.riversideSample.LINK,
    "the sample button should fill the import field with the declared sample link");
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => /Imported 3 tracks/.test(document.querySelector("#riverside-status").textContent),
    "importing the sample manifest link should report three imported tracks", 300);
  const err = document.querySelector("#riverside-error");
  assert(err.hidden || !err.textContent.trim(), "a valid Riverside link import should not show an error: " + err.textContent);
  assert(document.querySelector("#riverside-link").value === "", "the link field should clear after a successful import");

  // Host, Guest 1, and Guest 2 should all populate as real speaker buckets.
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 3, "three decoder videos should exist after import");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.videoWidth > 0),
    "imported fixture tracks should decode with real dimensions and duration", 300,
  );
  ["host", "guest1", "guest2"].forEach(function (bucket) {
    const row = document.querySelector('.bucket[data-bucket="' + bucket + '"]');
    assert(row.classList.contains("filled"), bucket + " bucket should show as filled after link import");
  });

  // The composed preview should render all three imported (distinctly
  // colored) tracks.
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split" && stage().dataset.speakers === "3", "Split preview should compose all three imported tracks");
  await waitFor(() => allThreeColorsPresent(), "Split preview should visibly render all three distinct speaker colors", 120);
  const splitColors = regionStats(stage());

  // PRESET SWITCHES: the imported tracks must rerender in each distinct layout.
  const presetColors = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId && stage().dataset.speakers === "3", presetId + " should keep all three imported tracks composed");
    await waitFor(() => allThreeColorsPresent(), presetId + " should visibly render all three distinct speaker colors", 120);
    presetColors[presetId] = regionStats(stage());
  }
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and confirm a genuinely playable
  // file with visible decoded frames.
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
  assert(blob.size > 1024, "exported file should carry real (non-trivial) bytes, got " + blob.size);
  const exportedVideo = document.createElement("video");
  exportedVideo.muted = true;
  exportedVideo.src = URL.createObjectURL(blob);
  await new Promise((r) => { exportedVideo.onloadedmetadata = r; exportedVideo.onerror = r; setTimeout(r, 5000); });
  assert(exportedVideo.videoWidth > 0 && exportedVideo.videoHeight > 0, "exported file should be a playable video with real dimensions");
  // "visible decoded frames": seek into the export and confirm the decoded
  // frame is genuinely nonblank (not a black/placeholder frame).
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; exportedVideo.removeEventListener("seeked", fin); resolve(); };
    exportedVideo.addEventListener("seeked", fin);
    setTimeout(fin, 4000);
    try { exportedVideo.currentTime = Math.min(1, exportedVideo.duration / 2 || 0.5); } catch (e) { fin(); }
  });
  const probe = document.createElement("canvas");
  probe.width = exportedVideo.videoWidth;
  probe.height = exportedVideo.videoHeight;
  probe.getContext("2d").drawImage(exportedVideo, 0, 0, probe.width, probe.height);
  const exportedFrame = regionStats(probe);
  assert(exportedFrame.bright > 0.2, "exported decoded frame should be visibly nonblank: " + JSON.stringify(exportedFrame));

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
    preview: { split: splitColors, stack: presetColors.stack, spotlight: presetColors.spotlight },
    exportBytes: blob.size,
    exportDimensions: exportedVideo.videoWidth + "x" + exportedVideo.videoHeight,
    exportedFrame: exportedFrame,
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
    console.log("verify-riverside-import: OK — the repo's declared sample Riverside manifest link imports three real speaker tracks, composes and exports correctly, and rejects unsupported links cleanly");
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
