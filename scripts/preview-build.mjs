// scripts/preview-build.mjs — assembles the shippable static preview into dist/
// and smoke-checks it. Dependency-free. This proves the app is structurally
// complete and the compose-readiness invariant holds; it does NOT claim to prove
// the visual preview (that is verified by running the app).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "../tests/_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. Required source files must exist.
const required = [
  "index.html",
  "app/presets.js",
  "app/episode.js",
  "app/riverside.js",
  "app/riverside-sample.js",
  "app/moments.js",
  "app/moment-images.js",
  "app/captions.js",
  "app/preview.js",
  "app/ui.js",
  "app/styles.css",
];
const missing = required.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error("preview-build: missing required files:\n  " + missing.join("\n  "));
  process.exit(1);
}

// 2. index.html must load the classic scripts in dependency order (not ES
//    modules — they break over file://) and reference the stylesheet.
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const mustReference = ["app/presets.js", "app/episode.js", "app/riverside.js", "app/riverside-sample.js", "app/moments.js", "app/moment-images.js", "app/captions.js", "app/preview.js", "app/ui.js", "app/styles.css"];
const notReferenced = mustReference.filter((r) => !html.includes(r));
if (notReferenced.length) {
  console.error("preview-build: index.html does not reference:\n  " + notReferenced.join("\n  "));
  process.exit(1);
}
if (!html.includes("stage-canvas")) {
  console.error("preview-build: index.html must include the composed preview canvas");
  process.exit(1);
}
if (!html.includes('data-file-bucket="host"')) {
  console.error("preview-build: index.html must declare static speaker upload inputs");
  process.exit(1);
}
if (!html.includes('id="moment-duration"')) {
  console.error("preview-build: index.html must declare the moment duration input");
  process.exit(1);
}
if (!html.includes('id="moment-image"')) {
  console.error("preview-build: index.html must declare the b-roll PNG upload input");
  process.exit(1);
}
if (!html.includes('id="caption-file"') || !html.includes('id="caption-text"')) {
  console.error("preview-build: index.html must declare the caption file input and paste box");
  process.exit(1);
}
if (!html.includes('id="riverside-link"') || !html.includes('id="riverside-import-btn"')) {
  console.error("preview-build: index.html must declare the Riverside link import input and button");
  process.exit(1);
}
// The declared sample link must be visible in the app and documented in the
// README, and the bundled sample episode it resolves to must be real: three
// embedded self-contained data:video/webm tracks of plausible size.
const SAMPLE_LINK = "https://riverside.fm/studio/pdc-sample-episode";
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (!html.includes(SAMPLE_LINK) || !readme.includes(SAMPLE_LINK)) {
  console.error("preview-build: the declared sample Riverside link must appear in index.html and README.md");
  process.exit(1);
}
if (/type=["']module["']/.test(html)) {
  console.error("preview-build: index.html uses ES modules; classic scripts are required for file:// compatibility");
  process.exit(1);
}

// 3. Model invariant: two assigned speakers + a valid preset => ready to compose.
const PDC = loadPDC(root);
const ep = PDC.episode.createEpisode({ title: "smoke" });
PDC.episode.assignMedia(ep, "host", { name: "a.webm", size: 1, type: "video/webm" });
if (PDC.episode.canCompose(ep)) {
  console.error("preview-build: canCompose() true with only one speaker — readiness gate is broken");
  process.exit(1);
}
PDC.episode.assignMedia(ep, "guest1", { name: "b.webm", size: 1, type: "video/webm" });
if (!PDC.episode.canCompose(ep)) {
  console.error("preview-build: canCompose() false with two speakers + default preset — readiness gate is broken");
  process.exit(1);
}

// Model invariant tying the declared link to the bundled sample: the link
// resolves through the samples registry into three ordered speaker tracks, each
// a self-contained data:video/webm URL of plausible size (a real, decodable
// track — not a stub). No file or network read is involved in resolving it.
// (Broader parser behavior is covered by tests/riverside.test.mjs.)
const rvSample = PDC.riverside.parseEpisodeLink(SAMPLE_LINK);
if (!rvSample.ok || rvSample.tracks.length !== 3 || rvSample.tracks.map((t) => t.bucket).join(",") !== "host,guest1,guest2") {
  console.error("preview-build: the declared sample link must resolve to the three bundled speaker tracks");
  process.exit(1);
}
for (const t of rvSample.tracks) {
  if (!/^data:video\/webm;base64,/.test(t.url) || t.url.length < 8192) {
    console.error(`preview-build: bundled sample ${t.bucket} track must be a real embedded data:video/webm URL`);
    process.exit(1);
  }
}

// 4. Copy the static app into dist/ (app/ includes the bundled sample episode
//    module the declared import link resolves to).
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "app"), { recursive: true });
fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "index.html"));
for (const f of fs.readdirSync(path.join(root, "app"))) {
  fs.copyFileSync(path.join(root, "app", f), path.join(dist, "app", f));
}

console.log(`preview-build: OK — assembled dist/ (${required.length} core files), model invariant holds`);
