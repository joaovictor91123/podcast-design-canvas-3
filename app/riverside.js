// app/riverside.js — parses a Riverside-style episode share link into the
// direct speaker track URLs it references. This is link-to-track import only:
// no third-party sign-in, no private Riverside API calls, no cloud fetching —
// the link is expected to directly carry (or point at) each speaker's track
// URL, exactly like the maintainer-owned local test links this step is
// verified against. Pure, DOM-free parsing (no fetch/File here — app/ui.js
// does the actual fetch, since that's inherently a browser/network concern);
// unit-testable like app/moments.js and app/captions.js. Classic script —
// exposed on window.PDC.riverside.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Recognized per-bucket keys, most-specific first. Accepts either the
  // product's own bucket vocabulary (host/guest1/guest2 — most discoverable,
  // since it mirrors the UI/DOM already) or a generic ordered fallback
  // (track1/track2/track3, or t1/t2/t3) for links that number tracks instead
  // of naming them.
  const TRACK_KEYS = {
    host: ["host", "track1", "t1"],
    guest1: ["guest1", "track2", "t2"],
    guest2: ["guest2", "track3", "t3"],
  };

  // Query-string params, then hash-fragment params layered on top (share
  // links often carry data after "#" to avoid it reaching a server) —
  // case-insensitive keys, hash wins on conflict.
  function collectParams(url) {
    const merged = new Map();
    for (const [k, v] of url.searchParams) merged.set(k.toLowerCase(), v);
    const hash = url.hash.indexOf("#") === 0 ? url.hash.slice(1) : url.hash;
    if (hash) {
      const hashParams = new URLSearchParams(hash);
      for (const [k, v] of hashParams) merged.set(k.toLowerCase(), v);
    }
    return merged;
  }

  // Parses a pasted Riverside-style link into { ok:true, tracks } where
  // tracks maps bucket -> track URL (string), for every bucket the link
  // actually references (1-3 of host/guest1/guest2). Returns { ok:false,
  // error } — a creator-readable reason — for empty input, unparseable URLs,
  // or a link that carries no recognizable track URL at all. Never throws.
  function parseRiversideLink(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return { ok: false, error: "Paste a Riverside episode link first." };
    let url;
    try {
      url = new URL(raw);
    } catch (e) {
      return { ok: false, error: "That doesn't look like a valid link." };
    }
    const params = collectParams(url);
    const tracks = {};
    Object.keys(TRACK_KEYS).forEach(function (bucket) {
      for (const key of TRACK_KEYS[bucket]) {
        const value = params.get(key);
        if (value) {
          tracks[bucket] = value;
          break;
        }
      }
    });
    if (!Object.keys(tracks).length) {
      return { ok: false, error: "That link doesn't include any speaker track URLs (host/guest1/guest2)." };
    }
    return { ok: true, tracks: tracks };
  }

  PDC.riverside = { parseRiversideLink };
})();
