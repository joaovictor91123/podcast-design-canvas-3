// app/riverside.js — resolves a Riverside-style episode link into the direct
// speaker track URLs it references. This is link-to-track import only: no
// third-party sign-in, no private Riverside API calls, no cloud fetching.
// Two link shapes are supported:
//   1. A self-contained fixture MANIFEST: a "data:application/json;base64,..."
//      URI decoding to a JSON object mapping bucket -> track URL (each track
//      is typically itself a "data:video/webm;base64,..." URI). This is the
//      maintainer-provided local fixture format — fully self-contained, so
//      resolving it needs no network access and no browser file-access
//      permissions at all, unlike fetching an arbitrary external/file:// URL.
//      See app/riverside-sample.js for the committed sample manifest link.
//   2. A plain link whose query string or hash fragment directly carries
//      per-speaker track URLs (host=<url>&guest1=<url>&guest2=<url>, or the
//      generic track1/track2/track3 fallback) — kept for flexibility with
//      links that reference tracks by URL rather than embedding a manifest.
// Pure, DOM-free parsing (no fetch here — a manifest is decoded entirely
// in-memory via atob/JSON.parse); unit-testable like app/moments.js and
// app/captions.js. Classic script — exposed on window.PDC.riverside.
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

  function tracksFromObject(obj) {
    const tracks = {};
    Object.keys(TRACK_KEYS).forEach(function (bucket) {
      for (const key of TRACK_KEYS[bucket]) {
        const value = obj[key];
        if (value) {
          tracks[bucket] = value;
          break;
        }
      }
    });
    return tracks;
  }

  // A "data:application/json[;charset=...];base64,<payload>" manifest link.
  const MANIFEST_PATTERN = /^data:application\/json(?:;charset=[^;,]+)?;base64,(.+)$/i;

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
  // error } — a creator-readable reason — for empty input, an undecodable
  // manifest, an unparseable URL, or a link that carries no recognizable
  // track URL at all. Never throws.
  function parseRiversideLink(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return { ok: false, error: "Paste a Riverside episode link first." };

    const manifestMatch = raw.match(MANIFEST_PATTERN);
    if (manifestMatch) {
      let manifest;
      try {
        manifest = JSON.parse(atob(manifestMatch[1]));
      } catch (e) {
        return { ok: false, error: "That Riverside manifest link could not be decoded." };
      }
      if (!manifest || typeof manifest !== "object") {
        return { ok: false, error: "That Riverside manifest link could not be decoded." };
      }
      const tracks = tracksFromObject(manifest);
      if (!Object.keys(tracks).length) {
        return { ok: false, error: "That manifest doesn't include any speaker track URLs (host/guest1/guest2)." };
      }
      return { ok: true, tracks: tracks };
    }

    let url;
    try {
      url = new URL(raw);
    } catch (e) {
      return { ok: false, error: "That doesn't look like a valid link." };
    }
    const tracks = tracksFromObject(Object.fromEntries(collectParams(url)));
    if (!Object.keys(tracks).length) {
      return { ok: false, error: "That link doesn't include any speaker track URLs (host/guest1/guest2)." };
    }
    return { ok: true, tracks: tracks };
  }

  PDC.riverside = { parseRiversideLink };
})();
