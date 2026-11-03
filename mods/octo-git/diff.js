// Turns `git diff` output into side-by-side rows: old on the left, new on the right.

const MAX_TEXT = 1000;
const clean = (text) => {
  const line = text.replaceAll("\t", "    ");
  return line.length > MAX_TEXT ? line.slice(0, MAX_TEXT) + "…" : line;
};

// A hunk row keeps its header's numbers: where each side starts, and how many
// lines it has (1 when the header leaves the count out).
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const hunkRow = (text, m) => ({ kind: "hunk", text, old: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], new: +m[3], newCount: m[4] === undefined ? 1 : +m[4] });

// `diff --git a/P b/P` with --no-renames names the same path twice, so it splits
// in the middle even when the path has spaces. Git quotes unusual paths ("a/P" "b/P").
function headerPath(rest) {
  if (!rest.startsWith('"')) return rest.slice(2, 2 + (rest.length - 5) / 2);
  const quoted = rest.slice(0, (rest.length - 1) / 2);
  return JSON.parse(quoted).slice(2);
}

// One entry per file: { lines: [from the first "@@"], binary }.
export function splitDiff(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      let path;
      try { path = headerPath(line.slice(11)); } catch { path = null; }
      current = { lines: [], binary: false, hunks: false };
      if (path !== null) files.set(path, current);
      continue;
    }
    if (!current) continue;
    if (!current.hunks) {
      if (line.startsWith("Binary files ")) current.binary = true;
      if (!line.startsWith("@@")) continue;
      current.hunks = true;
    }
    current.lines.push(line);
  }
  return files;
}

// Rows: { kind: "hunk", text, old, oldCount, new, newCount } or { kind: "line", left, right }, where a side is
// { number, text, type: "ctx" | "del" | "add" } or null (nothing on that side).
// A run of "-" lines pairs with the "+" run after it, row for row.
export function sideBySide(lines, max = Infinity) {
  const rows = [];
  let old = 0, next = 0, dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ kind: "line", left: dels[i] ?? null, right: adds[i] ?? null });
    dels = []; adds = [];
  };
  for (const line of lines) {
    if (rows.length >= max) break;
    const hunk = HUNK.exec(line);
    if (hunk) { flush(); old = +hunk[1]; next = +hunk[3]; rows.push(hunkRow(line, hunk)); continue; }
    const kind = line[0], text = clean(line.slice(1));
    if (kind === "-") { if (adds.length) flush(); dels.push({ number: old++, text, type: "del" }); continue; }
    if (kind === "+") { adds.push({ number: next++, text, type: "add" }); continue; }
    if (kind === " ") { flush(); rows.push({ kind: "line", left: { number: old++, text, type: "ctx" }, right: { number: next++, text, type: "ctx" } }); }
  }
  flush();
  return rows.slice(0, max);
}

// The same rows in one column: one per diff line, in git's order. A removed line
// has only its left side, an added one only its right, context both.
export function unified(lines, max = Infinity) {
  const rows = [];
  let old = 0, next = 0;
  for (const line of lines) {
    if (rows.length >= max) break;
    const hunk = HUNK.exec(line);
    if (hunk) { old = +hunk[1]; next = +hunk[3]; rows.push(hunkRow(line, hunk)); continue; }
    const kind = line[0], text = clean(line.slice(1));
    if (kind === "-") rows.push({ kind: "line", left: { number: old++, text, type: "del" }, right: null });
    if (kind === "+") rows.push({ kind: "line", left: null, right: { number: next++, text, type: "add" } });
    if (kind === " ") rows.push({ kind: "line", left: { number: old++, text, type: "ctx" }, right: { number: next++, text, type: "ctx" } });
  }
  return rows;
}

// A new file's whole text as added lines.
export function addedLines(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
}

export const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// A file's text as lines, without the empty one after a final newline.
export const fileLines = (text) => text ? text.replace(/\n$/, "").split("\n") : [];

// What a diff leaves out: the unchanged lines before each hunk (`at`: the hunk
// row's index) and after the last (`at: null`), as new-file line ranges
// [from, to]. `delta` is how far new line numbers run ahead of old ones there.
// The end is `total` (the file's line count) when known. Otherwise the last
// hunk ends the file if fewer than `context` lines follow its last change, and
// else it isn't known yet (Infinity). A diff cut short (`cut`) has no end gap.
export function gaps(rows, { total = null, context = 3, cut = false } = {}) {
  const out = [];
  let next = 1, oldNext = 1, tail = 0;
  rows.forEach((row, at) => {
    if (row.kind === "line") { tail = row.left?.type === "ctx" ? tail + 1 : 0; return; }
    if (row.kind !== "hunk") return;
    // A side with no lines starts at the line before it.
    const before = row.newCount ? row.new - 1 : row.new, oldBefore = row.oldCount ? row.old - 1 : row.old;
    out.push({ at, from: next, to: before, delta: before - oldBefore });
    next = before + row.newCount + 1; oldNext = oldBefore + row.oldCount + 1; tail = 0;
  });
  if (!out.length || cut) return out;
  out.push({ at: null, from: next, to: total ?? (tail < context ? next - 1 : Infinity), delta: next - oldNext });
  return out;
}

// The rows with the unchanged lines asked for: `revealed` holds new-file ranges
// [from, to], drawn from `lines` (the file as it is now; null until read). A
// stretch of a gap that stays hidden becomes expander rows ({ kind: "expand",
// dir, from, to }): "up" shows `step` more lines above the code under it,
// "down" below the code over it, "all" the whole stretch once it's no longer
// than `step`. A hunk's header text moves onto the last expander before it,
// and the header goes once its gap is all shown. Rows from `rows` carry their
// `index` there; a shown line carries `context`, its new-file number.
export function withContext(rows, gapList, { revealed = [], lines = null, step = 20 } = {}) {
  const out = [], byHunk = new Map(gapList.map((gap) => [gap.at, gap]));
  const shown = (n) => lines !== null && n <= lines.length && revealed.some(([a, b]) => n >= a && n <= b);
  const fill = (gap, hunk) => {
    const to = gap.to === Infinity && lines !== null ? lines.length : gap.to;
    let last = null;
    for (let n = gap.from; n <= to;) {
      if (shown(n)) {
        const text = clean(lines[n - 1]);
        out.push({ kind: "line", left: { number: n - gap.delta, text, type: "ctx" }, right: { number: n, text, type: "ctx" }, context: n });
        n++; continue;
      }
      let end = n;
      if (lines === null || to === Infinity) end = to; else while (end < to && !shown(end + 1)) end++;
      const above = n > gap.from || gap !== gapList[0], below = end < to || gap.at !== null;
      const expander = (dir, from, until) => { last = { kind: "expand", dir, from, to: until, text: null }; out.push(last); };
      if (end - n < step) expander(above && below ? "all" : below ? "up" : "down", n, end);
      else {
        if (above) expander("down", n, n + step - 1);
        if (below) expander("up", end - step + 1, end);
      }
      if (end === Infinity) break;
      n = end + 1;
    }
    if (!hunk) return;
    if (last) last.text = hunk.row.text;
    else if (gap.from > gap.to) out.push({ ...hunk.row, index: hunk.index });
  };
  rows.forEach((row, index) => {
    const gap = row.kind === "hunk" ? byHunk.get(index) : undefined;
    if (gap) fill(gap, { row, index }); else out.push({ ...row, index });
  });
  if (byHunk.has(null)) fill(byHunk.get(null), null);
  return out;
}
