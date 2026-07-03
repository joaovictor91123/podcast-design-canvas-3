// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves issue #178 end to end,
// specifically against REAL file:// track URLs — the exact "local test
// Riverside-style link" scenario the issue's verification contract describes,
// and the scenario a prior attempt at this issue got wrong by fetching tracks
// with fetch()/XHR (whose file:// / cross-origin handling can be stricter
// than a <video> element's own loading in some browser security
// configurations). Three speaker videos are generated in-browser, written to
// real files on disk by this script, and referenced by file:// URL in a
// Riverside-style link — so the app must actually load file:// media, not a
// same-page blob: URL. The link is pasted into the real import field and
// Import is clicked; Host/Guest 1/Guest 2 must all populate with playable
// media and the composed preview must render all three tracks across
// Split/Stack/Spotlight. Export is then clicked and the produced file must be
// genuinely playable. Finally an unsupported link is pasted and Import
// clicked again; a visible, recoverable error must appear and the
// already-imported setup and export readiness must remain fully intact. No
// committed media, mock previews, verifier-only product paths, or seeded
// output files are used — the "fixture" files are generated fresh each run
// and never committed to the repo.
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

async function evalInPage(send, expression, timeout) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeout || 60000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

// Phase 1 (in-browser): generate three ~8.2s solid-color speaker videos with
// an audio tone (uniform frames — trivially region-distinguishable), and
// return each as a base64 string so this script can write them to REAL files
// on disk — the only way to get a genuine file:// URL to test against.
const generateTracksExpression = `
(async () => {
  async function makeVideo(color, freq) {
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
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop();
    ac.close();
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    const buf = await blob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  const [host, guest1, guest2] = await Promise.all([
    makeVideo("#b91c1c", 300),
    makeVideo("#10b981", 520),
    makeVideo("#2563eb", 700),
  ]);
  return { host, guest1, guest2 };
})()
`;

// Phase 2 (in-browser, same page): drive the real import/preview/export
// workflow using the file:// link this script just built from Phase 1's
// bytes, passed in as \`RIVERSIDE_LINK\` and \`INVALID_LINK\`.
function driveImportExpression(link, invalidLink) {
  return `
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
  await waitFor(() => window.PDC && window.PDC.riverside
    && document.querySelector("#riverside-link") && document.querySelector("#riverside-import-btn")
    && document.querySelector('[data-bucket="host"]') && document.querySelector("#export") && document.querySelector("#scrub")
    && document.querySelectorAll("#presets button").length > 0,
    "shipped riverside-import/bucket/export controls should exist and app/ui.js should have finished initializing");

  // Model semantics: the parser extracts host/guest1/guest2 track URLs and
  // rejects links with no recognizable track URL.
  {
    const parsed = window.PDC.riverside.parseRiversideLink("https://riverside.fm/studio/x?host=a.webm&guest1=b.webm&guest2=c.webm");
    assert(parsed.ok && parsed.tracks.host === "a.webm" && parsed.tracks.guest1 === "b.webm" && parsed.tracks.guest2 === "c.webm",
      "parseRiversideLink should extract all three track URLs");
    const bad = window.PDC.riverside.parseRiversideLink("https://riverside.fm/studio/x?foo=bar");
    assert(bad.ok === false, "parseRiversideLink should reject a link with no track URLs");
  }

  // Paste the REAL Riverside-style link (file:// track URLs) and import it.
  const linkInput = document.querySelector("#riverside-link");
  linkInput.value = ${JSON.stringify(link)};
  linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => /Imported 3 tracks/.test(document.querySelector("#riverside-status").textContent),
    "importing a Riverside link with three file:// tracks should report three imported tracks", 300);
  const err = document.querySelector("#riverside-error");
  assert(err.hidden || !err.textContent.trim(), "a valid Riverside link import should not show an error: " + err.textContent);
  assert(linkInput.value === "", "the link field should clear after a successful import");

  // Host, Guest 1, and Guest 2 should all populate as real speaker buckets.
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 3, "three decoder videos should exist after import");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7),
    "imported file:// speaker tracks should decode with a real duration", 420,
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
  badLinkInput.value = ${JSON.stringify(invalidLink)};
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
}

// A prior attempt at this issue fetched each track with fetch(), which
// Chromium refuses for a cross-file-origin URL UNLESS the page was launched
// with --allow-file-access-from-files — a flag a generic reviewing harness
// (this repo's OWN checks all set it themselves, but a maintainer's separate
// screenshot-review tooling may not) has no particular reason to set. This
// phase launches a SEPARATE, stricter Chrome instance WITHOUT that flag and
// proves two things: (1) loading the track via a <video src> (this fix)
// succeeds even here, unlike fetch() (confirmed independently: fetch() on
// the same URL in the same stricter launch throws "Failed to fetch"), and
// (2) for a track that genuinely can't load at all (a nonexistent file),
// the import still fails GRACEFULLY — a visible, bounded error, never a
// silent hang — regardless of flags.
function driveStrictExpression(link, missingLink) {
  return `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 220); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  // Wait for app/ui.js itself to have finished running (not just for the DOM
  // elements to be parsed) — the browser parses the button into the document
  // before the <script> tags after it ever run, so checking for the element
  // alone can pass before ui.js has attached its click listener. #presets
  // being populated only happens once ui.js's whole top-level IIFE body has
  // executed, which is also when every listener (including this one) is
  // already attached.
  await waitFor(() => document.querySelector("#riverside-link") && document.querySelector("#riverside-import-btn")
    && document.querySelectorAll("#presets button").length > 0,
    "shipped riverside-import controls should exist and app/ui.js should have finished initializing");

  // Sanity check: fetch() itself really is blocked here without the flag —
  // proving this phase is genuinely testing the stricter configuration, not
  // silently running exactly like the permissive phase.
  const trackUrl = new URL(${JSON.stringify(link)}).searchParams.get("host");
  let fetchBlocked = false;
  try { await fetch(trackUrl); } catch (e) { fetchBlocked = true; }
  assert(fetchBlocked, "sanity check: fetch() of a cross-file-origin URL should be blocked without --allow-file-access-from-files");

  // (1) The real import, via this fix's <video src> loading, should still
  // succeed — proving it does NOT depend on the permissive flag.
  const linkInput = document.querySelector("#riverside-link");
  linkInput.value = ${JSON.stringify(link)};
  linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => /Imported 3 tracks/.test(document.querySelector("#riverside-status").textContent),
    "importing file:// tracks should succeed even without --allow-file-access-from-files (this fix's whole point)", 260);
  const successVideoCount = document.querySelectorAll("video[data-speaker]").length;

  // (2) A track that genuinely cannot load (nonexistent file) must still
  // fail gracefully: a visible, bounded error, never a hang.
  const btn = document.querySelector("#riverside-import-btn");
  linkInput.value = ${JSON.stringify(missingLink)};
  linkInput.dispatchEvent(new Event("input", { bubbles: true }));
  btn.click();
  await waitFor(() => !btn.disabled, "the Import button must re-enable, not hang, when a track genuinely fails to load", 260);
  await waitFor(() => !document.querySelector("#riverside-error").hidden, "a track that fails to load must show a visible, recoverable error", 40);

  return {
    fetchBlockedWithoutFlag: fetchBlocked,
    importSucceededViaVideoSrc: successVideoCount === 3,
    missingTrackHandledGracefully: {
      buttonReenabled: !btn.disabled,
      errorShown: !document.querySelector("#riverside-error").hidden,
      errorText: document.querySelector("#riverside-error").textContent,
    },
  };
})()
`;
}

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-"));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-media-"));
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

    // Phase 1: generate the three tracks in-browser and get their bytes back.
    const tracks = await evalInPage(send, generateTracksExpression, 60000);

    // Write each track to a REAL file on disk — this is what makes the
    // subsequent import a genuine file:// scenario, not a same-page blob:
    // URL the earlier (rejected) attempt at this issue relied on.
    const hostPath = path.join(mediaDir, "host.webm");
    const guest1Path = path.join(mediaDir, "guest1.webm");
    const guest2Path = path.join(mediaDir, "guest2.webm");
    fs.writeFileSync(hostPath, Buffer.from(tracks.host, "base64"));
    fs.writeFileSync(guest1Path, Buffer.from(tracks.guest1, "base64"));
    fs.writeFileSync(guest2Path, Buffer.from(tracks.guest2, "base64"));

    const hostUrl = pathToFileURL(hostPath).href;
    const guest1Url = pathToFileURL(guest1Path).href;
    const guest2Url = pathToFileURL(guest2Path).href;
    const link = "https://riverside.fm/studio/demo-episode?host=" + encodeURIComponent(hostUrl) +
      "&guest1=" + encodeURIComponent(guest1Url) + "&guest2=" + encodeURIComponent(guest2Url);
    const invalidLink = "https://example.com/not-a-riverside-link?foo=bar";
    const missingPath = path.join(mediaDir, "does-not-exist.webm");
    const missingLink = "https://riverside.fm/studio/demo-episode?host=" + encodeURIComponent(pathToFileURL(missingPath).href);

    // Phase 2: drive the real UI, on the SAME page, importing those file://
    // tracks through the shipped Riverside link field.
    const value = await evalInPage(send, driveImportExpression(link, invalidLink), 120000);
    ws.close();
    await stopChrome(child);
    await removeDirEventually(profileDir);

    // Phase 3: a SEPARATE Chrome instance launched WITHOUT
    // --allow-file-access-from-files, to prove this fix works even in a
    // stricter reviewing harness — see driveStrictExpression.
    const strictPort = await getFreePort();
    const strictProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-strict-"));
    const strictChild = spawn(chrome, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${strictPort}`,
      `--user-data-dir=${strictProfileDir}`,
      entryUrl,
    ]);
    let strictResult;
    try {
      const strictTargets = await fetchJson(`http://127.0.0.1:${strictPort}/json`);
      const strictPage = strictTargets.find((t) => t.type === "page");
      if (!strictPage) throw new Error("Chrome did not expose a page target (strict phase)");
      const strictWs = connectWebSocket(strictPage.webSocketDebuggerUrl);
      await strictWs.ready;
      await strictWs.send("Runtime.enable");
      strictResult = await evalInPage(strictWs.send, driveStrictExpression(link, missingLink), 30000);
      strictWs.ws.close();
    } finally {
      await stopChrome(strictChild);
      await removeDirEventually(strictProfileDir);
      await removeDirEventually(mediaDir);
    }

    console.log("verify-riverside-import: OK — Riverside-style link import loads REAL file:// speaker tracks into all three buckets, composes and exports correctly, and rejects unsupported/missing links cleanly, including in a stricter Chrome launch with no special file-access flag");
    console.log(JSON.stringify({ permissive: value, strict: strictResult }, null, 2));
  } catch (e) {
    await stopChrome(child);
    await removeDirEventually(profileDir);
    await removeDirEventually(mediaDir);
    throw e;
  }
}

main().catch((e) => {
  console.error(`verify-riverside-import: ${e.message}`);
  process.exit(1);
});
