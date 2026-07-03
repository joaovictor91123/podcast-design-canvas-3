// app/riverside.js — parse a Riverside-style episode share link (or a manifest
// reference, or a pasted list of speaker track URLs) into per-speaker track
// assignments (Host / Guest 1 / Guest 2). This is the setup path that starts an
// episode FROM A LINK instead of manual per-speaker uploads: the UI (app/ui.js)
// loads each parsed track URL into a File, and feeds it through the SAME ingest
// path uploads use, so imported tracks drive the existing preview/export flow
// with no separate code path. Pure, DOM-free string parsing — no network, no
// third-party sign-in, no cloud fetching (resource loading happens in the UI
// layer). Classic script exposed on window.PDC.riverside so it is unit-testable
// under plain Node.
//
// Deliberately permissive about link SHAPE, because "Riverside-style link" is not
// a real published format: it accepts a share URL whose query names the tracks
// (?host=…&guest1=…&guest2=…), a ?tracks=a,b,c list, a share URL that references
// a manifest (?manifest=fixtures/riverside/sample-episode.json) or a bare .json
// manifest path, a JSON object, or a bare whitespace/comma/newline-separated list
// of track values. Deliberately strict about track SOURCE, because #195 defers
// real network integration: only local fixture/app-relative paths, in-session
// blob: object URLs, and self-contained data:video URLs are importable — remote
// http(s) media URLs are rejected, and the wrapping share URL is only ever
// parsed as text. Whatever the shape, the speaker tracks it references are
// extracted and mapped in canonical order. When the link points at a manifest
// instead of naming tracks directly, parseEpisodeLink returns { manifestRef } and
// the UI loads that manifest's text and parses it with this same function.
(function () {
  const PDC = (window.PDC = window.PDC || {});
  const BUCKETS = ["host", "guest1", "guest2"];

  // Map a query/JSON key to a canonical speaker bucket, else null. Tolerant of
  // separators and casing (host / Guest 1 / guest_2 …).
  function roleForKey(key) {
    const k = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k === "host") return "host";
    if (k === "guest1") return "guest1";
    if (k === "guest2") return "guest2";
    return null;
  }
  // Key whose value is a list of track URLs (comma / pipe separated).
  const TRACK_LIST_KEY = /^tracks?$/i;
  // Key whose value points at an episode manifest rather than naming tracks.
  const MANIFEST_KEY = /^manifest$/i;

  // A scheme-less relative path to a video file ("fixtures/riverside/host.webm")
  // — resolved by the UI against the app's own base URL, exactly how the repo's
  // declared sample manifest references its local fixture tracks.
  function isRelativeVideoPath(s) {
    const t = String(s == null ? "" : s).trim();
    return /^[\w][\w\/.\-]*\.(webm|mp4|m4v|mov|ogg|ogv|mkv|avi)$/i.test(t);
  }

  // #195 explicitly DEFERS real network integration, so a track value is only
  // accepted from non-network sources: a local fixture/app-relative path, an
  // in-session blob: object URL, or a self-contained data:video URL. Remote
  // http(s)/file media URLs are deliberately NOT importable in this step.
  function isTrackish(s) {
    const t = String(s == null ? "" : s).trim();
    return /^blob:/i.test(t) || /^data:video\//i.test(t) || isRelativeVideoPath(t);
  }

  // A manifest reference: an app-relative .json path the tracks live behind
  // (local-only, for the same no-network reason as isTrackish).
  function isManifestRef(s) {
    const t = String(s == null ? "" : s).trim().split(/[?#]/)[0];
    return /\.json$/i.test(t) && /^[\w][\w\/.\-]*$/.test(t);
  }

  // Strip surrounding quotes and percent-decode when the value was URL-encoded
  // inside a query string (so an encoded blob:/https: url becomes usable again).
  function cleanValue(v) {
    let s = String(v == null ? "" : v).trim().replace(/^["']+|["']+$/g, "");
    if (/%[0-9a-f]{2}/i.test(s)) {
      try { s = decodeURIComponent(s); } catch (e) { /* leave as-is on bad escape */ }
    }
    return s.trim();
  }

  // Bare-token form of the same policy (used when scanning un-keyed tokens; the
  // wrapping https share link itself is parsed as text, never treated as media).
  const looksLikeTrack = isTrackish;

  function nameFor(bucket, url) {
    const s = String(url || "");
    if (isRelativeVideoPath(s)) {
      const base = s.substring(s.lastIndexOf("/") + 1);
      if (base) return base;
    }
    return bucket + ".webm";
  }

  // Look up a share URL's episode id (its last path segment) in the bundled
  // samples registry and return its tracks in canonical bucket order, or null.
  function sampleTracksFor(text) {
    const samples = PDC.riversideSamples || {};
    const m = String(text || "").match(/https?:\/\/[^\s"'<>]+/i);
    if (!m) return null;
    const pathPart = m[0].replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
    const segs = pathPart.split("/").filter(Boolean);
    let id = segs.length ? segs[segs.length - 1] : "";
    try { id = decodeURIComponent(id); } catch (e) { /* keep raw id */ }
    const entry = id && samples[id];
    if (!entry || !entry.tracks) return null;
    const tracks = [];
    BUCKETS.forEach((bucket) => {
      const url = entry.tracks[bucket];
      if (typeof url === "string" && isTrackish(url)) tracks.push({ bucket, url, name: nameFor(bucket, url) });
    });
    return tracks.length ? tracks : null;
  }

  // Parse a pasted link/text into ordered speaker track assignments.
  // Returns { ok:true, tracks:[{ bucket, url, name }] } or { ok:false, error }.
  function parseEpisodeLink(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) {
      return { ok: false, error: "Paste a Riverside episode link (or your speaker track URLs) first." };
    }

    const byRole = { host: null, guest1: null, guest2: null };
    const pool = []; // ordered, un-keyed candidate track urls/paths
    let manifestRef = null;

    // (a) JSON object/array form: {"host":"…","guest1":"…"} or {"tracks":[…]} —
    //     this is also the shape of a loaded manifest file's text.
    if (/^[[{]/.test(text)) {
      try {
        (function scan(o) {
          if (Array.isArray(o)) {
            o.forEach((v) => { if (isTrackish(v)) pool.push(cleanValue(v)); else if (v && typeof v === "object") scan(v); });
            return;
          }
          if (o && typeof o === "object") {
            Object.keys(o).forEach((key) => {
              const val = o[key];
              const role = roleForKey(key);
              if (typeof val === "string" && isTrackish(val)) {
                if (role && !byRole[role]) byRole[role] = cleanValue(val);
                else pool.push(cleanValue(val));
              } else if (TRACK_LIST_KEY.test(key) && Array.isArray(val)) {
                val.forEach((v) => { if (isTrackish(v)) pool.push(cleanValue(v)); });
              } else if (val && typeof val === "object") {
                scan(val);
              }
            });
          }
        })(JSON.parse(text));
      } catch (e) { /* not JSON — fall through to query + bare parsing */ }
    }

    // (b) key=value pairs anywhere in the text (the share link's query string).
    //     Each value runs to the next & or whitespace, so a blob:/https: url is
    //     captured whole and split away from the wrapping riverside.fm URL.
    const pairRe = /([A-Za-z][\w.%+\-]*)\s*=\s*("[^"]*"|'[^']*'|[^&\s]+)/g;
    let m;
    while ((m = pairRe.exec(text))) {
      const key = cleanValue(m[1].replace(/\+/g, " "));
      const role = roleForKey(key);
      const val = cleanValue(m[2]);
      if (role) {
        if (isTrackish(val) && !byRole[role]) byRole[role] = val;
      } else if (TRACK_LIST_KEY.test(key)) {
        val.split(/[|,]+/).forEach((v) => { v = cleanValue(v); if (isTrackish(v)) pool.push(v); });
      } else if (MANIFEST_KEY.test(key) && isManifestRef(val) && !manifestRef) {
        manifestRef = val;
      }
    }

    // (c) bare tokens (a pasted list of urls/paths, or a bare manifest path).
    //     Split on whitespace/commas so each token is isolated; the wrapping
    //     share link (a non-media http url) fails looksLikeTrack.
    text.split(/[\s,]+/).forEach((tok) => {
      const t = tok.replace(/[)\]"'>.]+$/, "");
      if (looksLikeTrack(t)) pool.push(t);
      else if (isManifestRef(t) && !manifestRef) manifestRef = t;
    });

    // Assign: honor explicit roles first, then fill any remaining bucket in
    // canonical order from the ordered pool, de-duplicating against used urls.
    const used = new Set(Object.keys(byRole).map((b) => byRole[b]).filter(Boolean));
    const tracks = [];
    BUCKETS.forEach((bucket) => {
      let url = byRole[bucket];
      if (!url) {
        while (pool.length && (used.has(pool[0]) || !isTrackish(pool[0]))) pool.shift();
        if (pool.length) url = pool.shift();
      }
      if (url && isTrackish(url) && !tracks.some((t) => t.url === url)) {
        used.add(url);
        tracks.push({ bucket, url, name: nameFor(bucket, url) });
      }
    });

    // A link that names no tracks directly but references a manifest defers to
    // that manifest: the UI loads its text and parses it with this same function.
    if (!tracks.length && manifestRef) {
      return { ok: true, tracks: [], manifestRef };
    }
    // A bare share URL (no tracks, no manifest) may name a BUNDLED episode by
    // its id — the last path segment — resolved against the samples registry
    // (app/riverside-sample.js). The registry holds self-contained data:video
    // URLs, so resolving the repo's declared sample link performs no file or
    // network read at all (nothing to CORS-block, clean console everywhere).
    if (!tracks.length) {
      const sample = sampleTracksFor(text);
      if (sample) return { ok: true, tracks: sample };
    }
    if (!tracks.length) {
      return {
        ok: false,
        error: "No importable speaker tracks found in that link. Use a Riverside-style link that references local synced speaker tracks (bundled paths, blob:, or data: video) or an episode manifest .json — remote media links are not fetched.",
      };
    }
    return { ok: true, tracks };
  }

  PDC.riverside = { parseEpisodeLink, BUCKETS };
})();
