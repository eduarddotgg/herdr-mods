import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapText, reviewPrompt, anchorOf, fingerprint, viewedPaths } from "../mods/octo-git/review.js";

test("wraps at spaces, keeps blank lines, hard-splits long words", () => {
  assert.deepEqual(wrapText("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
  assert.deepEqual(wrapText("abcdefghij xy", 4), ["abcd", "efgh", "ij", "xy"]);
  assert.ok(wrapText("x ".repeat(100), 20).every((l) => l.length <= 20));
});

test("anchors", () => {
  assert.equal(anchorOf({ side: "R", line: 8 }), "R8");
  assert.equal(anchorOf({ side: null, line: null }), null);
});

test("prompt groups by diff order, file comments first, then lines", () => {
  const text = reviewPrompt({
    root: "/repo", branch: "main", note: "",
    order: ["b.ts", "a.ts"],
    comments: [
      { id: "1", path: "a.ts", side: "R", line: 3, code: "x()", text: "rename" },
      { id: "2", path: "b.ts", side: "R", line: 9, code: "const `t` = 1", text: "why?\nexplain" },
      { id: "3", path: "b.ts", side: null, line: null, code: null, text: "add tests" },
      { id: "4", path: "b.ts", side: "L", line: 2, code: "old()", text: "keep this" },
    ],
  });
  assert.match(text, /^Code review of the uncommitted changes in \/repo \(branch main\)\./);
  assert.match(text, /Address each comment below/);
  const b = text.indexOf("## b.ts"), a = text.indexOf("## a.ts");
  assert.ok(b > 0 && a > b);
  const section = text.slice(b, a);
  const whole = section.indexOf("- /repo/b.ts (whole file)\n  add tests");
  const removed = section.indexOf("- /repo/b.ts, removed line 2 of HEAD: `old()`\n  keep this");
  const added = section.indexOf("- /repo/b.ts:9: `` const `t` = 1 ``\n  why?\n  explain");
  assert.ok(whole > 0 && removed > whole && added > removed);
  assert.ok(text.includes("- /repo/a.ts:3: `x()`\n  rename"));
  assert.match(text, /full path/);
});

test("a repo root with a trailing slash doesn't double it", () => {
  const text = reviewPrompt({ root: "/r/", branch: "", note: "", order: [], comments: [{ id: "1", path: "x/y.ts", side: "R", line: 4, code: "a", text: "t" }] });
  assert.ok(text.includes("- /r/x/y.ts:4: `a`"));
});

test("a note replaces the default instruction", () => {
  const text = reviewPrompt({ root: "/r", branch: "", note: "Only analyze, don't edit.", order: [], comments: [{ id: "1", path: "z", side: null, line: null, code: null, text: "t" }] });
  assert.ok(text.includes("Only analyze, don't edit."));
  assert.ok(!text.includes("Address each comment"));
  assert.ok(text.startsWith("Code review of the uncommitted changes in /r."));
});

test("with no comments the agent reviews the changes itself", () => {
  const text = reviewPrompt({ root: "/r", branch: "dev", note: "", order: [], comments: [] });
  assert.ok(text.startsWith("Code review of the uncommitted changes in /r (branch dev)."));
  assert.match(text, /Review these changes yourself/);
  assert.match(text, /git diff HEAD/);
  assert.ok(!text.includes("R<n>") && !text.includes("## "));
  const noted = reviewPrompt({ root: "/r", branch: "", note: "Check error handling only.", order: [], comments: [] });
  assert.ok(noted.includes("Check error handling only.") && !noted.includes("Review these changes yourself"));
  assert.match(noted, /git diff HEAD/);
});

test("a fingerprint is stable and changes with the text", () => {
  assert.equal(fingerprint("@@ -1 +1 @@\n-a\n+b"), fingerprint("@@ -1 +1 @@\n-a\n+b"));
  assert.notEqual(fingerprint("@@ -1 +1 @@\n-a\n+b"), fingerprint("@@ -1 +1 @@\n-a\n+c"));
  assert.notEqual(fingerprint("ab"), fingerprint("ba"));
});

test("a file stays viewed only while its changes match the mark", () => {
  const files = [{ path: "a.ts", sig: "1" }, { path: "b.ts", sig: "2" }, { path: "c.ts", sig: "3" }];
  const viewed = viewedPaths({ "a.ts": "1", "b.ts": "old", "gone.ts": "9" }, files);
  assert.deepEqual([...viewed], ["a.ts"]);
  assert.equal(viewedPaths(undefined, files).size, 0);
});
