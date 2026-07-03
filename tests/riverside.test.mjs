// tests/riverside.test.mjs — Riverside-style episode link parsing: extracting
// per-speaker track URLs from a self-contained fixture manifest (the primary,
// maintainer-provided-fixture format) or from a link's query/hash params, and
// rejecting empty, undecodable, unparseable, or trackless links with a
// creator-readable reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const R = PDC.riverside;

function manifestLink(obj) {
  return "data:application/json;base64," + Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

test("parseRiversideLink decodes a self-contained fixture manifest", () => {
  const link = manifestLink({ host: "data:video/webm;base64,AAA", guest1: "data:video/webm;base64,BBB", guest2: "data:video/webm;base64,CCC" });
  const result = R.parseRiversideLink(link);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, {
    host: "data:video/webm;base64,AAA",
    guest1: "data:video/webm;base64,BBB",
    guest2: "data:video/webm;base64,CCC",
  });
});

test("parseRiversideLink accepts a manifest with a subset of tracks", () => {
  const link = manifestLink({ host: "a.webm" });
  const result = R.parseRiversideLink(link);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "a.webm" });
});

test("parseRiversideLink accepts the generic track1/track2/track3 keys in a manifest", () => {
  const link = manifestLink({ track1: "a.webm", track2: "b.webm", track3: "c.webm" });
  const result = R.parseRiversideLink(link);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "a.webm", guest1: "b.webm", guest2: "c.webm" });
});

test("parseRiversideLink rejects a manifest with no track fields", () => {
  const link = manifestLink({ title: "My Episode" });
  const result = R.parseRiversideLink(link);
  assert.equal(result.ok, false);
  assert.match(result.error, /track/i);
});

test("parseRiversideLink rejects an undecodable manifest", () => {
  const result = R.parseRiversideLink("data:application/json;base64,not-valid-base64-json!!!");
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be decoded/i);
});

test("parseRiversideLink reads host/guest1/guest2 from a plain link's query string", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo?host=https%3A%2F%2Fx.test%2Fh.webm&guest1=https%3A%2F%2Fx.test%2Fg1.webm&guest2=https%3A%2F%2Fx.test%2Fg2.webm");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, {
    host: "https://x.test/h.webm",
    guest1: "https://x.test/g1.webm",
    guest2: "https://x.test/g2.webm",
  });
});

test("parseRiversideLink reads track URLs from a plain link's hash fragment", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo#host=blob:host-url&guest1=blob:guest1-url");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "blob:host-url", guest1: "blob:guest1-url" });
});

test("parseRiversideLink prefers a hash param over a query param for the same key", () => {
  const result = R.parseRiversideLink("https://riverside.fm/e/x?host=query.webm#host=hash.webm");
  assert.equal(result.ok, true);
  assert.equal(result.tracks.host, "hash.webm");
});

test("parseRiversideLink rejects empty input", () => {
  assert.equal(R.parseRiversideLink("").ok, false);
  assert.equal(R.parseRiversideLink("   ").ok, false);
  assert.match(R.parseRiversideLink("").error, /paste/i);
});

test("parseRiversideLink rejects text that isn't a valid URL or manifest", () => {
  const result = R.parseRiversideLink("not a link at all");
  assert.equal(result.ok, false);
  assert.match(result.error, /valid link/i);
});

test("parseRiversideLink rejects a well-formed URL with no track params", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo?foo=bar");
  assert.equal(result.ok, false);
  assert.match(result.error, /track/i);
});

test("the repo's declared sample manifest link parses to three real speaker tracks", () => {
  assert.ok(PDC.riversideSample && typeof PDC.riversideSample.LINK === "string" && PDC.riversideSample.LINK.length > 0,
    "app/riverside-sample.js should expose a non-empty LINK");
  const result = R.parseRiversideLink(PDC.riversideSample.LINK);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.tracks).sort(), ["guest1", "guest2", "host"]);
  Object.values(result.tracks).forEach((track) => {
    assert.match(track, /^data:video\/webm;base64,/, "each fixture track should be a self-contained data: video URI");
  });
});
