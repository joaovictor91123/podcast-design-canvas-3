// tests/riverside.test.mjs — Riverside-style episode link parsing: extracting
// per-speaker track URLs from query/hash params, and rejecting empty,
// unparseable, or trackless links with a creator-readable reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const R = PDC.riverside;

test("parseRiversideLink reads host/guest1/guest2 from the query string", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo?host=https%3A%2F%2Fx.test%2Fh.webm&guest1=https%3A%2F%2Fx.test%2Fg1.webm&guest2=https%3A%2F%2Fx.test%2Fg2.webm");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, {
    host: "https://x.test/h.webm",
    guest1: "https://x.test/g1.webm",
    guest2: "https://x.test/g2.webm",
  });
});

test("parseRiversideLink reads track URLs from the hash fragment", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo#host=blob:host-url&guest1=blob:guest1-url");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "blob:host-url", guest1: "blob:guest1-url" });
});

test("parseRiversideLink accepts the generic track1/track2/track3 fallback", () => {
  const result = R.parseRiversideLink("https://riverside.fm/e/x?track1=a.webm&track2=b.webm&track3=c.webm");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "a.webm", guest1: "b.webm", guest2: "c.webm" });
});

test("parseRiversideLink prefers a hash param over a query param for the same key", () => {
  const result = R.parseRiversideLink("https://riverside.fm/e/x?host=query.webm#host=hash.webm");
  assert.equal(result.ok, true);
  assert.equal(result.tracks.host, "hash.webm");
});

test("parseRiversideLink accepts a subset of tracks (not all three required)", () => {
  const result = R.parseRiversideLink("https://riverside.fm/e/x?host=a.webm");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tracks, { host: "a.webm" });
});

test("parseRiversideLink rejects empty input", () => {
  assert.equal(R.parseRiversideLink("").ok, false);
  assert.equal(R.parseRiversideLink("   ").ok, false);
  assert.match(R.parseRiversideLink("").error, /paste/i);
});

test("parseRiversideLink rejects text that isn't a valid URL", () => {
  const result = R.parseRiversideLink("not a link at all");
  assert.equal(result.ok, false);
  assert.match(result.error, /valid link/i);
});

test("parseRiversideLink rejects a well-formed URL with no track params", () => {
  const result = R.parseRiversideLink("https://riverside.fm/studio/demo?foo=bar");
  assert.equal(result.ok, false);
  assert.match(result.error, /track/i);
});
