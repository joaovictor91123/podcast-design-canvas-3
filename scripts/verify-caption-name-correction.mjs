// scripts/verify-caption-name-correction.mjs
// Drives the shipped app in headless Chrome and proves issue #172 end to end:
// upload two generated speaker WebM videos, enter distinct social links for
// Host and Guest 1 whose handles imply real names, then import a transcript
// whose caption text contains close misspellings of those names. The
// imported caption MOMENTS must store the CORRECTED names (proved by reading
// the real moments list DOM, not guessed), the misspelled forms must never
// appear, the corrected captions must survive a preset switch, and — because
// caption moments render/export through the exact same path as every other
// timed moment — the caption band must still render only inside its cue
// windows in the live preview and be burned into the exported video, which
// must remain playable with real speaker pixels. No committed media, mock
// previews, verifier-only product paths, or seeded output files are used.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run caption-name-correction verification.");
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

  const uploadTo = (input, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const typeInto = (input, v) => {
    input.value = v;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // Caption band region: centered lower banner (bottom edge ~0.9h). "Present"
  // = mostly dark backing + some light text; "absent" = plain bright video.
  const CAP_REGION = { x0: 41, y0: 82, x1: 59, y1: 88 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const capShown = () => stage().dataset.caption === "1";
  const capAbsent = () => stage().dataset.caption === "0";

  await waitFor(() => window.PDC && window.PDC.captions
    && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector('[data-link-bucket="host"]')
    && document.querySelector("#caption-text") && document.querySelector("#caption-load")
    && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped upload/social-link/caption/export controls should exist");

  // Model semantics: correctNames fixes a close misspelling of a known name
  // and leaves an exact match / unrelated words untouched.
  {
    assert(window.PDC.captions.correctNames("Hi Marcuss!", ["Marcus"]) === "Hi Marcus!", "correctNames should fix a close misspelling");
    assert(window.PDC.captions.correctNames("Hi Marcus!", ["Marcus"]) === "Hi Marcus!", "correctNames should leave an exact match untouched");
    assert(window.PDC.captions.correctNames("cat sat on mat", ["Marcus"]) === "cat sat on mat", "correctNames should not touch unrelated short words");
  }

  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded speakers should decode with a real duration covering both caption cues", 420,
  );

  // Enter distinct social links whose handles imply real names — this is the
  // "social context" the corrected captions must be derived from.
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/Marcus");
  await sleep(150);
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/Sarah");
  await sleep(150);
  await waitFor(() => /Marcus/.test((document.querySelector('[data-derived="host"]') || {}).textContent || ""),
    "Host's derived name should show Marcus once the social link is entered");
  await waitFor(() => /Sarah/.test((document.querySelector('[data-derived="guest1"]') || {}).textContent || ""),
    "Guest 1's derived name should show Sarah once the social link is entered");

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  // Import a transcript whose caption text misspells both names.
  const transcript = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:03.000",
    "Welcome back, Marcuss!",
    "",
    "00:00:04.000 --> 00:00:07.000",
    "Great to have you, Sara.",
    "",
  ].join("\\n");
  typeInto(document.querySelector("#caption-text"), transcript);
  document.querySelector("#caption-load").click();
  await waitFor(() => /2 caption moment/.test(document.querySelector("#caption-status").textContent),
    "caption import should report two imported caption moments");
  await waitFor(() => document.querySelectorAll("#moment-list li").length === 2, "both imported captions should appear in the moments list");

  const listText = document.querySelector("#moment-list").textContent;
  assert(/\\bMarcus\\b/.test(listText), "the moment list should show the corrected name Marcus: " + listText);
  assert(!/\\bMarcuss\\b/.test(listText), "the moment list must not show the misspelled Marcuss: " + listText);
  assert(/\\bSarah\\b/.test(listText), "the moment list should show the corrected name Sarah: " + listText);
  assert(!/\\bSara\\b/.test(listText), "the moment list must not show the misspelled Sara: " + listText);
  const err = document.querySelector("#caption-error");
  assert(err.hidden || !err.textContent.trim(), "a valid import should not show a caption error");

  // PLAYBACK: restart and confirm the first corrected caption appears
  // naturally during playback, then pause — the remaining exact-time checks
  // use the scrub control (as scripts/verify-captions.mjs and
  // scripts/verify-title-callout-moments.mjs already do) rather than a long
  // free-running playback window, since this correction feature's job is the
  // TEXT, not re-proving the timing engine's own free-running playback path.
  function pausePreview() {
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
  }
  document.querySelector("#restart").click();
  await waitFor(() => capShown(), "the first corrected caption should appear during playback around 0-3s", 120);
  pausePreview();

  // SCRUB: sample exact times through the real scrub control.
  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar should span the episode", 120);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
  }
  await scrubTo(1.5);
  await waitFor(() => capShown(), "scrubbed to 1.5s: the first corrected caption should show");
  await scrubTo(3.5);
  await waitFor(() => capAbsent(), "scrubbed to 3.5s (the gap): no caption should show");
  await scrubTo(5.5);
  await waitFor(() => capShown(), "scrubbed to 5.5s: the second corrected caption should show");

  // PRESET SWITCHES: the corrected captions must remain visible and correct
  // across Stack and Spotlight, per the verification contract.
  const presetStats = {};
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    const stillListText = document.querySelector("#moment-list").textContent;
    assert(/\\bMarcus\\b/.test(stillListText) && /\\bSarah\\b/.test(stillListText),
      presetId + ": corrected caption names should remain in the moments list");
    assert(!/\\bMarcuss\\b/.test(stillListText) && !/\\bSara\\b/.test(stillListText),
      presetId + ": misspelled names must not reappear");
    pausePreview();
    await scrubTo(1.5);
    await waitFor(() => capShown(), presetId + ": the corrected caption should render over the recomposed layout");
    presetStats[presetId] = regionStats(stage(), CAP_REGION);
  }

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: click the real Export action and read the product's own download.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 760,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  assert(/split/i.test(resultText), "export result should reflect the selected Split preset: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true;
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 220);
  }
  assert(v.duration >= 6.2, "export should cover both caption cues, duration=" + v.duration);

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth;
  probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 350);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return { t, caption: regionStats(probe, CAP_REGION), frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }) };
  }
  const exportedFirst = await seekAndSample(1.5);
  const exportedGap = await seekAndSample(3.5);
  const exportedSecond = await seekAndSample(5.5);
  assert(exportedFirst.frame.bright > 0.2, "exported frame at 1.5s should show real speaker pixels (nonblank)");
  assert(exportedFirst.caption.dark > 0.35, "the first corrected caption should be burned into the exported frame at 1.5s: " + JSON.stringify(exportedFirst.caption));
  assert(exportedGap.frame.bright > 0.2, "exported frame at 3.5s should show real speaker pixels (nonblank)");
  assert(exportedGap.caption.dark < 0.15, "no caption should be burned in during the 3.5s gap: " + JSON.stringify(exportedGap.caption));
  assert(exportedSecond.frame.bright > 0.2, "exported frame at 5.5s should show real speaker pixels (nonblank)");
  assert(exportedSecond.caption.dark > 0.35, "the second corrected caption should be burned into the exported frame at 5.5s: " + JSON.stringify(exportedSecond.caption));

  return {
    momentsListed: document.querySelectorAll("#moment-list li").length,
    derivedNames: {
      host: (document.querySelector('[data-derived="host"]') || {}).textContent,
      guest1: (document.querySelector('[data-derived="guest1"]') || {}).textContent,
    },
    correctedListText: listText,
    preview: { stack: presetStats.stack, spotlight: presetStats.spotlight },
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
    exportSamples: { first: exportedFirst, gap: exportedGap, second: exportedSecond },
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-caption-names-"));
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
    console.log("verify-caption-name-correction: OK — imported captions use social-link-derived names, corrected misspellings, and burn in correctly across presets and export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => {
  console.error(`verify-caption-name-correction: ${e.message}`);
  process.exit(1);
});
