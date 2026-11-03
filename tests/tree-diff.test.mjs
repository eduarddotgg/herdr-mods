import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, flattenTree, dirPaths, filterFiles } from "../mods/octo-git/tree.js";
import { splitDiff, sideBySide, unified, addedLines, countLines, gaps, withContext, fileLines } from "../mods/octo-git/diff.js";

const files = [
  { path: "apps/shop/src/Cart.tsx", staged: "none" },
  { path: "apps/shop/src/api/client.ts", staged: "some" },
  { path: "apps/shop/ios/App.swift", staged: "all" },
  { path: "README.md", staged: "all" },
  { path: "docs/old.md", staged: "all" },
];

test("folds single-folder chains and sorts folders before files", () => {
  const tree = buildTree(files);
  assert.deepEqual(tree.dirs.map((d) => d.name), ["apps/shop", "docs"]);
  assert.deepEqual(tree.files.map((f) => f.name), ["README.md"]);
  const shop = tree.dirs[0];
  assert.equal(shop.path, "apps/shop");
  assert.deepEqual(shop.dirs.map((d) => d.name), ["ios", "src"]);
  assert.equal(shop.paths.length, 3);
  assert.equal(tree.paths.length, 5);
});

test("folder check state is tri-state", () => {
  const tree = buildTree(files);
  assert.equal(tree.staged, "some");
  assert.equal(tree.dirs[1].staged, "all");
  assert.equal(tree.dirs[0].dirs[0].staged, "all");
  assert.equal(tree.dirs[0].dirs[1].staged, "some");
  assert.equal(buildTree([{ path: "a/b", staged: "none" }]).staged, "none");
});

test("does not fold a folder that has files", () => {
  const tree = buildTree([{ path: "a/x.txt", staged: "none" }, { path: "a/b/y.txt", staged: "none" }]);
  assert.equal(tree.dirs[0].name, "a");
  assert.equal(tree.dirs[0].dirs[0].name, "b");
});

test("flatten respects collapsed folders and depth", () => {
  const tree = buildTree(files);
  const all = flattenTree(tree, new Set());
  assert.deepEqual(all.map((r) => r.key), ["d:", "d:apps/shop", "d:apps/shop/ios", "f:apps/shop/ios/App.swift", "d:apps/shop/src", "d:apps/shop/src/api", "f:apps/shop/src/api/client.ts", "f:apps/shop/src/Cart.tsx", "d:docs", "f:docs/old.md", "f:README.md"]);
  assert.deepEqual(all.map((r) => r.depth), [0, 1, 2, 3, 2, 3, 4, 3, 1, 2, 1]);
  const some = flattenTree(tree, new Set(["apps/shop/src"]));
  assert.ok(!some.some((r) => r.key === "f:apps/shop/src/Cart.tsx"));
  assert.deepEqual(flattenTree(tree, new Set([""])).map((r) => r.key), ["d:"]);
});

const DIFF = `diff --git a/my file.txt b/my file.txt
index 1..2 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1,4 +1,5 @@
 one
-two
-three
+TWO
 four
+five
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"
--- a/x
+++ b/x
@@ -10 +10 @@ ctx
-a\tb
+c
`;

test("splits a diff per file, including spaced and quoted paths", () => {
  const map = splitDiff(DIFF);
  assert.deepEqual([...map.keys()], ["my file.txt", "logo.png", 'q"uote.txt']);
  assert.equal(map.get("logo.png").binary, true);
  assert.equal(map.get("logo.png").lines.length, 0);
  assert.equal(map.get("my file.txt").lines[0], "@@ -1,4 +1,5 @@");
});

test("pairs uneven -/+ runs row for row with fillers", () => {
  const rows = sideBySide(splitDiff(DIFF).get("my file.txt").lines);
  assert.equal(rows[0].kind, "hunk");
  const lines = rows.slice(1).map((r) => [r.left && `${r.left.number}${r.left.type[0]}:${r.left.text}`, r.right && `${r.right.number}${r.right.type[0]}:${r.right.text}`]);
  assert.deepEqual(lines, [
    ["1c:one", "1c:one"],
    ["2d:two", "2a:TWO"],
    ["3d:three", null],
    ["4c:four", "3c:four"],
    [null, "4a:five"],
  ]);
});

test("tabs become spaces and rows are capped", () => {
  const rows = sideBySide(splitDiff(DIFF).get('q"uote.txt').lines);
  assert.equal(rows[1].left.text, "a    b");
  assert.equal(rows[1].left.number, 10);
  assert.equal(sideBySide(addedLines("a\nb\nc\nd\n"), 3).length, 3);
});

test("new files are all added lines", () => {
  assert.deepEqual(addedLines("x\ny\n"), ["@@ -0,0 +1,2 @@", "+x", "+y"]);
  const rows = sideBySide(addedLines("x\ny\n"));
  assert.equal(rows[2].left, null);
  assert.equal(rows[2].right.number, 2);
  assert.equal(countLines("x\ny\n"), 2);
  assert.equal(countLines(""), 0);
});

test("a folder's own path and every folder under it, folded chains by their full path", () => {
  const tree = buildTree([
    { path: "apps/shop/src/a.ts", staged: "none" },
    { path: "apps/shop/src/ui/b.ts", staged: "none" },
    { path: "apps/shop/test/c.ts", staged: "none" },
    { path: "docs/d.md", staged: "none" },
  ]);
  const shop = tree.dirs.find((d) => d.name === "apps/shop");
  assert.deepEqual(dirPaths(shop).sort(), ["apps/shop", "apps/shop/src", "apps/shop/src/ui", "apps/shop/test"]);
  assert.deepEqual(dirPaths(tree).sort(), ["", "apps/shop", "apps/shop/src", "apps/shop/src/ui", "apps/shop/test", "docs"]);
});

test("the filter keeps files whose path holds the text, any case", () => {
  const files = [{ path: "apps/shop/src/Cart.tsx" }, { path: "docs/cart-notes.md" }, { path: "api/client.ts" }];
  assert.deepEqual(filterFiles(files, "CART").map((f) => f.path), ["apps/shop/src/Cart.tsx", "docs/cart-notes.md"]);
  assert.deepEqual(filterFiles(files, "shop/src").map((f) => f.path), ["apps/shop/src/Cart.tsx"]);
  assert.equal(filterFiles(files, "  ").length, 3);
  assert.equal(filterFiles(files, "zzz").length, 0);
});

test("unified rows: one per diff line, in git's order, same cells as side by side", () => {
  const rows = unified(splitDiff(DIFF).get("my file.txt").lines);
  assert.equal(rows[0].kind, "hunk");
  const lines = rows.slice(1).map((r) => [r.left && `${r.left.number}${r.left.type[0]}:${r.left.text}`, r.right && `${r.right.number}${r.right.type[0]}:${r.right.text}`]);
  assert.deepEqual(lines, [
    ["1c:one", "1c:one"],
    ["2d:two", null],
    ["3d:three", null],
    [null, "2a:TWO"],
    ["4c:four", "3c:four"],
    [null, "4a:five"],
  ]);
  assert.equal(unified(addedLines("a\nb\nc\nd\n"), 3).length, 3);
});

// Line n of a 60-line file is `line n`; a hunk changes line `at`, with git's 3 lines around it.
const FILE = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
const hunk = (at) => [`@@ -${at - 3},7 +${at - 3},7 @@ h${at}`, ...[3, 2, 1].map((k) => ` line ${at - k}`), `-line ${at}`, `+LINE ${at}`, ...[1, 2, 3].map((k) => ` line ${at + k}`)];
const TWO = [...hunk(30), ...hunk(45)];
const show = (rows) => rows.map((r) => r.kind === "expand" ? `${r.dir} ${r.from}-${r.to}${r.text ? ` ${r.text}` : ""}`
  : r.context ? `ctx ${r.context}` : r.kind === "hunk" ? r.text : `#${r.index}`);

test("hunk rows carry their header's numbers, a missing count being 1", () => {
  for (const layout of [sideBySide, unified]) {
    const [row] = layout(["@@ -10 +12,3 @@ x", " a"]);
    assert.deepEqual([row.old, row.oldCount, row.new, row.newCount], [10, 1, 12, 3]);
  }
});

test("gaps: before each hunk, and after the last until the file's end", () => {
  const rows = sideBySide(TWO);
  assert.deepEqual(gaps(rows).map(({ at, from, to, delta }) => [at, from, to, delta]), [[0, 1, 26, 0], [8, 34, 41, 0], [null, 49, Infinity, 0]]);
  assert.equal(gaps(rows, { total: 60 }).at(-1).to, 60);
  assert.equal(gaps(rows, { cut: true }).length, 2);
  // Fewer than 3 lines after the last change: that's the end of the file.
  const end = gaps(sideBySide(["@@ -56,5 +56,5 @@", " line 56", " line 57", " line 58", "-line 59", "+LINE 59", " line 60"]));
  assert.deepEqual(end.at(-1), { at: null, from: 61, to: 60, delta: 0 });
  // An added line puts new numbers one ahead of old ones after it.
  const moved = gaps(sideBySide(["@@ -1,2 +1,3 @@", " a", "+b", " c", "@@ -20,3 +21,3 @@", " x", " y", " z"]));
  assert.deepEqual(moved.map(({ from, to, delta }) => [from, to, delta]), [[1, 0, 0], [4, 20, 1], [24, Infinity, 1]]);
  // New and deleted files have nothing around them.
  assert.deepEqual(gaps(sideBySide(addedLines("a\nb\n"))).map(({ from, to }) => to - from + 1), [0, 0]);
  assert.deepEqual(gaps(sideBySide(["@@ -1,2 +0,0 @@", "-a", "-b"])).map(({ from, to }) => to - from + 1), [0, 0]);
});

test("hidden stretches become expanders, and a hunk's header moves onto the last one", () => {
  const rows = sideBySide(TWO);
  // 26 lines above the first change: only up, 20 lines. 8 between: all. Below: down, size unknown.
  assert.deepEqual(show(withContext(rows, gaps(rows))), [
    "up 7-26 @@ -27,7 +27,7 @@ h30", ...[1, 2, 3, 4, 5, 6, 7].map((i) => `#${i}`),
    "all 34-41 @@ -42,7 +42,7 @@ h45", ...[9, 10, 11, 12, 13, 14, 15].map((i) => `#${i}`),
    "down 49-68",
  ]);
});

test("shown lines come from the file, numbered on both sides", () => {
  const rows = sideBySide(TWO), lines = FILE;
  const out = withContext(rows, gaps(rows, { total: 60 }), { revealed: [[7, 26], [34, 41], [49, 52]], lines });
  const text = show(out);
  assert.deepEqual(text.slice(0, 3), ["up 1-6 @@ -27,7 +27,7 @@ h30", "ctx 7", "ctx 8"]);
  // The middle gap is all shown, so the two hunks join: no header between them.
  assert.ok(!text.some((t) => t.includes("h45")));
  assert.deepEqual(text.slice(-2), ["ctx 52", "down 53-60"]);
  const row = out.find((r) => r.context === 7);
  assert.deepEqual([row.left.number, row.right.number, row.right.text, row.left.type], [7, 7, "line 7", "ctx"]);
  // Big hidden stretches between hunks get both directions.
  const far = sideBySide([...hunk(10), ...hunk(50)]);
  assert.deepEqual(show(withContext(far, gaps(far))).filter((t) => !t.startsWith("#")), ["up 1-6 @@ -7,7 +7,7 @@ h10", "down 14-33", "up 27-46 @@ -47,7 +47,7 @@ h50", "down 54-73"]);
  // A file whose start is in the diff keeps its plain header row.
  const top = sideBySide(hunk(4));
  assert.equal(show(withContext(top, gaps(top)))[0], "@@ -1,7 +1,7 @@ h4");
});

test("a file's lines", () => {
  assert.deepEqual(fileLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(fileLines("a"), ["a"]);
  assert.deepEqual(fileLines(""), []);
});
