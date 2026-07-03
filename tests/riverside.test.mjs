// tests/riverside.test.mjs — DOM-free tests for the Riverside-style episode link
// parser: it must map speaker track URLs (keyed or positional, in a share link or
// a bare list) to Host/Guest 1/Guest 2 buckets, and reject links that reference
// no speaker tracks without throwing.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const R = PDC.riverside;

test("maps three role-keyed track values to Host, Guest 1, Guest 2 in canonical order", () => {
  const res = R.parseEpisodeLink(
    "https://riverside.fm/e/abc?host=media/h.webm&guest1=media/g1.webm&guest2=media/g2.webm",
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => t.bucket), ["host", "guest1", "guest2"]);
  assert.equal(res.tracks[0].url, "media/h.webm");
  assert.equal(res.tracks[2].url, "media/g2.webm");
  assert.equal(res.tracks[0].name, "h.webm");
});

test("remote http(s) media URLs are NOT importable tracks (network loading is deferred)", () => {
  // Keyed remote tracks: rejected outright.
  const keyed = R.parseEpisodeLink("https://riverside.fm/e?host=https://cdn.test/h.webm&guest1=https://cdn.test/g1.webm");
  assert.equal(keyed.ok, false);
  assert.match(keyed.error, /remote media links are not fetched/i);
  // A bare list of remote video URLs: also rejected.
  const bare = R.parseEpisodeLink("https://cdn.test/a.webm\nhttps://cdn.test/b.webm");
  assert.equal(bare.ok, false);
  // A remote manifest URL is not a manifest reference either.
  const manifest = R.parseEpisodeLink("https://riverside.fm/e?manifest=https://cdn.test/episode.json");
  assert.equal(manifest.ok, false);
  // Local values alongside remote ones still import — only the remote is dropped.
  const mixed = R.parseEpisodeLink("https://riverside.fm/e?host=blob:local&guest1=https://cdn.test/g1.webm");
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.tracks.map((t) => [t.bucket, t.url]), [["host", "blob:local"]]);
});

test("track paths are app-relative only: traversal, absolute, and protocol-relative forms are rejected", () => {
  for (const bad of ["../outside/h.webm", "/etc/media/h.webm", "//cdn.test/h.webm", "..\\h.webm"]) {
    const res = R.parseEpisodeLink("https://riverside.fm/e?host=" + bad);
    assert.equal(res.ok, false, "should reject track path: " + bad);
  }
  // Manifest references are equally constrained.
  const badManifest = R.parseEpisodeLink("https://riverside.fm/e?manifest=../secrets.json");
  assert.equal(badManifest.ok, false);
});

test("role keys are tolerant of casing/separators (Guest 1 / guest_2)", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/e?Host=blob:x1&Guest%201=blob:x2&guest_2=blob:x3");
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => [t.bucket, t.url]), [
    ["host", "blob:x1"],
    ["guest1", "blob:x2"],
    ["guest2", "blob:x3"],
  ]);
});

test("percent-encoded blob/https values are decoded", () => {
  const enc = encodeURIComponent("blob:https://app.local/9b1-uuid");
  const res = R.parseEpisodeLink("https://riverside.fm/e?host=" + enc + "&guest1=blob:two");
  assert.equal(res.ok, true);
  assert.equal(res.tracks[0].url, "blob:https://app.local/9b1-uuid");
});

test("a ?tracks= comma list fills buckets positionally", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/share?tracks=blob:a,blob:b,blob:c");
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => [t.bucket, t.url]), [
    ["host", "blob:a"],
    ["guest1", "blob:b"],
    ["guest2", "blob:c"],
  ]);
});

test("a bare newline/space list of local track paths imports positionally", () => {
  const res = R.parseEpisodeLink("media/a.webm\nmedia/b.webm media/c.webm");
  assert.equal(res.ok, true);
  assert.equal(res.tracks.length, 3);
  assert.deepEqual(res.tracks.map((t) => t.bucket), ["host", "guest1", "guest2"]);
});

test("JSON object form maps host/guest1/guest2 keys", () => {
  const res = R.parseEpisodeLink('{"host":"blob:h","guest1":"blob:g1","guest2":"blob:g2"}');
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => t.url), ["blob:h", "blob:g1", "blob:g2"]);
});

test("blob: URLs are always tracks; a two-track link composes", () => {
  const res = R.parseEpisodeLink("blob:one\nblob:two");
  assert.equal(res.ok, true);
  assert.equal(res.tracks.length, 2);
  assert.deepEqual(res.tracks.map((t) => t.bucket), ["host", "guest1"]);
});

test("explicit roles win over positional order, and remaining buckets fill from the pool", () => {
  // guest2 keyed explicitly; host + guest1 filled from the bare list in order.
  const res = R.parseEpisodeLink("https://riverside.fm/e?guest2=blob:third\nblob:first blob:second");
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => [t.bucket, t.url]), [
    ["host", "blob:first"],
    ["guest1", "blob:second"],
    ["guest2", "blob:third"],
  ]);
});

test("a share link with NO track URLs is rejected without throwing", () => {
  for (const bad of [
    "https://riverside.fm/not-an-episode",
    "https://riverside.fm/dashboard/recordings",
    "just some text",
  ]) {
    const res = R.parseEpisodeLink(bad);
    assert.equal(res.ok, false, "should reject: " + bad);
    assert.match(res.error, /no speaker tracks|referenc/i);
  }
});

test("empty / whitespace input returns a friendly error, not a crash", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const res = R.parseEpisodeLink(empty);
    assert.equal(res.ok, false);
    assert.ok(res.error);
  }
});

test("the wrapping riverside.fm link is never mistaken for a track", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/e/xyz?host=blob:h&guest1=blob:g1");
  assert.equal(res.ok, true);
  assert.ok(res.tracks.every((t) => t.url.startsWith("blob:")), "only the blob tracks import");
  assert.equal(res.tracks.length, 2);
});

test("at most three tracks are assigned even when more URLs are present", () => {
  const res = R.parseEpisodeLink("blob:a blob:b blob:c blob:d blob:e");
  assert.equal(res.ok, true);
  assert.equal(res.tracks.length, 3);
});

test("relative video paths are accepted as tracks (keyed and bare)", () => {
  const keyed = R.parseEpisodeLink("https://riverside.fm/e?host=fixtures/riverside/host.webm&guest1=fixtures/riverside/guest1.webm");
  assert.equal(keyed.ok, true);
  assert.deepEqual(keyed.tracks.map((t) => [t.bucket, t.url, t.name]), [
    ["host", "fixtures/riverside/host.webm", "host.webm"],
    ["guest1", "fixtures/riverside/guest1.webm", "guest1.webm"],
  ]);
  const bare = R.parseEpisodeLink("fixtures/riverside/host.webm\nfixtures/riverside/guest1.webm");
  assert.equal(bare.ok, true);
  assert.equal(bare.tracks.length, 2);
});

test("the declared sample link resolves through the bundled samples registry into three real data: tracks", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/studio/pdc-sample-episode");
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => t.bucket), ["host", "guest1", "guest2"]);
  for (const t of res.tracks) {
    assert.match(t.url, /^data:video\/webm;base64,/, t.bucket + " should be a self-contained data: track");
    assert.ok(t.url.length > 8192, t.bucket + " should embed a real video, not a stub");
  }
  // Resolution is data-only: no manifestRef to load, nothing to fetch.
  assert.equal(res.manifestRef, undefined);
});

test("an unknown episode id on a share link is rejected, not resolved", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/studio/some-other-episode");
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test("a manifest-only link resolves to its manifest reference", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/studio/my-show?manifest=episodes/my-episode.json");
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks, []);
  assert.equal(res.manifestRef, "episodes/my-episode.json");
});

test("a bare manifest .json path is treated as a manifest reference", () => {
  const res = R.parseEpisodeLink("fixtures/riverside/sample-episode.json");
  assert.equal(res.ok, true);
  assert.equal(res.manifestRef, "fixtures/riverside/sample-episode.json");
});

test("manifest text (JSON with a tracks object) parses into ordered speaker tracks", () => {
  const manifest = JSON.stringify({
    kind: "riverside-episode-manifest",
    episode: "Sample",
    tracks: { host: "fixtures/riverside/host.webm", guest1: "fixtures/riverside/guest1.webm", guest2: "fixtures/riverside/guest2.webm" },
  });
  const res = R.parseEpisodeLink(manifest);
  assert.equal(res.ok, true);
  assert.deepEqual(res.tracks.map((t) => t.bucket), ["host", "guest1", "guest2"]);
  assert.equal(res.tracks[0].url, "fixtures/riverside/host.webm");
});

test("the bundled samples registry holds exactly the declared sample with three data: tracks", () => {
  const samples = PDC.riversideSamples;
  assert.ok(samples && samples["pdc-sample-episode"], "the declared sample episode should be registered");
  const tracks = samples["pdc-sample-episode"].tracks;
  for (const bucket of ["host", "guest1", "guest2"]) {
    assert.match(tracks[bucket], /^data:video\/webm;base64,/, bucket + " is a self-contained data: video");
  }
});

test("direct tracks win over a manifest reference in the same link", () => {
  const res = R.parseEpisodeLink("https://riverside.fm/e?manifest=x/y.json&host=blob:h&guest1=blob:g");
  assert.equal(res.ok, true);
  assert.equal(res.tracks.length, 2);
  assert.equal(res.manifestRef, undefined);
});
