// scripts/make-riverside-fixtures.mjs — (re)generate the bundled sample Riverside
// episode used by the link-import setup path: three real synced speaker WebM
// tracks (animated speaker cards — moving highlight, name tag, running timecode —
// recorded with the same in-browser canvas/MediaRecorder technique every rendered
// check in this repo uses), embedded as self-contained data:video/webm URLs in
// app/riverside-sample.js. Embedding as data: URLs means importing the sample
// performs NO file or network reads at all — it works identically over http(s),
// file:// with local-file access, and plain file:// (where Chromium CORS-blocks
// local fetches), with a clean console. Committed so the sample's provenance is
// reproducible: `node scripts/make-riverside-fixtures.mjs` rewrites
// app/riverside-sample.js from scratch. Requires Chrome (CHROME_BIN).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "app", "riverside-sample.js");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to regenerate the sample.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
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

// Three synced ~4s speaker tracks. Each frame is an animated "speaker card":
// a dominant per-speaker color (red Host / blue Guest 1 / green Guest 2 — the
// rendered checks sample these regions), a sweeping highlight band, the speaker
// name, and a running timecode — so any single screenshot clearly reads as a
// playing video rather than a static color block. Distinct sine tones give the
// exported mix real, distinguishable audio.
const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function makeTrack(label, base, accent, freq) {
    const W = 320, H = 180;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq;
    const gain = ac.createGain(); gain.gain.value = 0.4;
    const dest = ac.createMediaStreamDestination();
    osc.connect(gain); gain.connect(dest); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType, videoBitsPerSecond: 320000, audioBitsPerSecond: 32000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    const frames = 48; // ~4s at the 12fps capture rate driven below
    for (let i = 0; i < frames; i++) {
      // Dominant color field (what the preview's region samples key on).
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, W, H);
      // Sweeping highlight band — continuous, obvious motion.
      const bandX = ((i / frames) * (W + 120)) - 60;
      const grad = ctx.createLinearGradient(bandX - 40, 0, bandX + 40, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.28)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // Bobbing accent dot — a second, out-of-phase motion cue.
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(W - 34, 90 + Math.sin(i / 3) * 26, 9, 0, Math.PI * 2);
      ctx.fill();
      // Speaker name tag.
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(10, H - 40, 118, 26);
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 15px sans-serif";
      ctx.fillText(label, 18, H - 22);
      // Running timecode — proves frames advance in any screenshot pair.
      const tenths = Math.floor(i * (10 / 12));
      ctx.font = "600 12px monospace";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText("REC 0:0" + Math.floor(tenths / 10) + "." + (tenths % 10), 12, 22);
      await sleep(83);
    }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: "video/webm" });
    const buf = await blob.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return {
    host: await makeTrack("HOST", "#c81e1e", "#ffd166", 300),
    guest1: await makeTrack("GUEST 1", "#1d6fd1", "#ffd166", 440),
    guest2: await makeTrack("GUEST 2", "#159a4b", "#ffd166", 560),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-fixtures-"));
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank",
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 90000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    const tracks = result.result.value;
    for (const [bucket, b64] of Object.entries(tracks)) {
      if (!b64 || b64.length < 8192) throw new Error(`${bucket} track came out implausibly small (${(b64 || "").length} base64 chars)`);
    }

    const js = `// app/riverside-sample.js — the bundled sample Riverside episode that the
// repo's DECLARED import link resolves to. Three real synced VP8/opus WebM
// speaker tracks (animated speaker cards with motion, name tags, running
// timecode, and distinct audio tones), embedded as self-contained
// data:video/webm URLs so importing the sample performs NO file or network
// reads — it works identically over http(s), file:// with local-file access,
// and plain file:// (where Chromium CORS-blocks local fetches), with a clean
// console. GENERATED FILE — do not edit by hand; regenerate with:
//   node scripts/make-riverside-fixtures.mjs
// Loaded only as data — nothing here auto-imports; the tracks are used solely
// when a creator imports a link that references this episode id.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  PDC.riversideSamples = {
    "pdc-sample-episode": {
      episode: "Sample Riverside episode",
      tracks: {
        host: "data:video/webm;base64,${tracks.host}",
        guest1: "data:video/webm;base64,${tracks.guest1}",
        guest2: "data:video/webm;base64,${tracks.guest2}",
      },
    },
  };
})();
`;
    fs.writeFileSync(outFile, js);
    const size = fs.statSync(outFile).size;
    console.log(`make-riverside-fixtures: wrote app/riverside-sample.js (${size} bytes; host/guest1/guest2 data: tracks embedded)`);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await sleep(300);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

main().catch((e) => { console.error(`make-riverside-fixtures: ${e.message}`); process.exit(1); });
