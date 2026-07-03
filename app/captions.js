// app/captions.js — import a creator-supplied transcript (WebVTT or SRT) and turn
// each timed cue into a real timed CAPTION MOMENT in the existing visual-moments
// system (app/moments.js). Captions are therefore listed in the moments list,
// rendered onto the stage canvas, persisted across preset/template switches, and
// burned into the exported video by exactly the same path as manual title/
// callout/b-roll moments — there is no separate caption pipeline. Pure, DOM-free
// parsing: no network, no automatic transcription. Classic script — exposed on
// window.PDC.captions. Loads after app/moments.js so PDC.moments is available.
(function () {
  const PDC = (window.PDC = window.PDC || {});

  // Parse one WebVTT/SRT timestamp ("hh:mm:ss.mmm" or "mm:ss.mmm"; hours and
  // milliseconds optional, comma tolerated for millis as SRT uses). -> seconds/NaN.
  function parseTimestamp(raw) {
    const s = String(raw == null ? "" : raw).trim();
    const m = s.match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:[.,](\d{1,3}))?$/);
    if (!m) return NaN;
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    const ms = m[4] ? Number((m[4] + "00").slice(0, 3)) : 0;
    return h * 3600 + min * 60 + sec + ms / 1000;
  }

  // Strip inline caption markup (<b>, <i>, <c.classname>, <00:00:01.000> timing
  // tags, &amp; entities) down to plain readable text for canvas rendering.
  function stripCueMarkup(text) {
    return String(text)
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  // Parse a WebVTT or SRT transcript into { cues: [{start, end, text}], error }.
  // Deliberately lenient so real files load: a leading UTF-8 BOM is stripped, a
  // WEBVTT header is optional (SRT and headerless cue lists parse), the header
  // may share a block with the first cue, cue settings after the end time
  // (line:85% align:center …) are ignored, and NOTE/STYLE/REGION blocks and
  // numeric/identifier lines are skipped. `error` is set only when no usable
  // timed cue can be found at all.
  function parseTranscript(input) {
    // Strip a leading UTF-8 BOM (﻿) and normalize line endings.
    const raw = String(input == null ? "" : input).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const hadHeader = /^\s*WEBVTT\b/.test(raw);
    const blocks = raw.split(/\n[ \t]*\n/);
    const cues = [];
    for (const block of blocks) {
      let lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
      if (lines.length && /^\s*WEBVTT\b/.test(lines[0])) lines = lines.slice(1);
      if (!lines.length) continue;
      const head = (lines[0] || "").trim();
      if (/^NOTE\b/.test(head) || /^STYLE\b/.test(head) || /^REGION\b/.test(head)) continue;
      const timingIdx = lines.findIndex((l) => l.indexOf("-->") !== -1);
      if (timingIdx === -1) continue;
      const parts = lines[timingIdx].split("-->");
      if (parts.length < 2) continue;
      const start = parseTimestamp(parts[0]);
      const end = parseTimestamp((parts[1].trim().split(/[ \t]+/)[0]) || "");
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const text = stripCueMarkup(lines.slice(timingIdx + 1).join("\n"));
      if (!text) continue;
      cues.push({ start, end, text });
    }
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    if (!cues.length) {
      return {
        cues: [],
        error: hadHeader
          ? "No caption cues were found in that WebVTT file."
          : "That text is not a valid WebVTT/SRT caption file (no timed cues like 00:00:00.000 --> 00:00:03.000 were found).",
      };
    }
    return { cues, error: "" };
  }

  // Caption moments currently on the episode, in start order.
  function captionMoments(episode) {
    const M = PDC.moments;
    return M ? M.listMoments(episode).filter((m) => m.type === "caption") : [];
  }

  // Plain Levenshtein edit distance (single-row DP) between two strings.
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
      let diag = row[0];
      row[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = row[j];
        row[j] = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(row[j], row[j - 1], diag);
        diag = temp;
      }
    }
    return row[n];
  }

  // How many typos to tolerate for a name of this length — generous enough to
  // catch a real misspelling (one wrong/missing/swapped letter, two for longer
  // names) without matching short, unrelated words. Names of 3 letters or
  // fewer are never fuzzy-matched: the false-positive risk outweighs the value.
  function maxTypos(len) {
    if (len <= 3) return 0;
    return len <= 6 ? 1 : 2;
  }

  // Replaces close misspellings of known speaker names — derived from the
  // creator's own social links via app/episode.js's speakerName(), passed in
  // by the caller as `names` — with their correct spelling. An exact match
  // (any case) is left untouched; a word is corrected only when it is
  // genuinely close (small edit distance relative to the name's length), so
  // real, unrelated words in the transcript are never mangled.
  function correctNames(text, names) {
    const candidates = (names || []).filter((n) => n && String(n).trim());
    if (!candidates.length) return text;
    return String(text).replace(/[A-Za-z][A-Za-z'-]*/g, function (word) {
      const lower = word.toLowerCase();
      let best = null;
      let bestDist = Infinity;
      for (const name of candidates) {
        const nameLower = String(name).toLowerCase();
        if (lower === nameLower) return word; // already correctly spelled
        const allowed = maxTypos(nameLower.length);
        if (!allowed) continue;
        if (Math.abs(lower.length - nameLower.length) > allowed) continue;
        const dist = editDistance(lower, nameLower);
        if (dist <= allowed && dist < bestDist) {
          bestDist = dist;
          best = name;
        }
      }
      return best || word;
    });
  }

  // Import a WebVTT/SRT transcript as timed CAPTION MOMENTS on the episode.
  // Replaces any previously-imported caption moments (so re-importing is
  // idempotent) but leaves manual title/callout/image moments — and every other
  // piece of episode state (uploaded media, preset, social links) — untouched.
  // On invalid/empty input it changes NOTHING and returns a creator-readable
  // reason, so a bad file can never wipe the creator's work. `correctionNames`
  // (optional) is the creator's own derived speaker names — see
  // app/episode.js's speakerName() — used to fix close misspellings of those
  // names in the imported caption text before it is stored.
  function importCaptionMoments(episode, text, correctionNames) {
    const parsed = parseTranscript(text);
    if (parsed.error || !parsed.cues.length) {
      return { ok: false, count: 0, error: parsed.error || "No caption cues were found." };
    }
    const M = PDC.moments;
    if (!M) return { ok: false, count: 0, error: "Moments system unavailable." };
    // Only replace previously-imported caption moments; keep all other moments.
    captionMoments(episode).forEach((m) => M.removeMoment(episode, m.id));
    let count = 0;
    parsed.cues.forEach((c) => {
      const cueText = correctNames(c.text, correctionNames);
      if (M.addMoment(episode, { type: "caption", text: cueText, start: c.start, end: c.end })) count++;
    });
    return { ok: count > 0, count, error: count ? "" : "No usable caption cues were found." };
  }

  PDC.captions = {
    parseTimestamp,
    parseTranscript,
    captionMoments,
    correctNames,
    importCaptionMoments,
  };
})();
