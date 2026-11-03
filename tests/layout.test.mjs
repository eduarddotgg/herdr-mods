import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const at = (path) => new URL(`../${path}`, import.meta.url);
const root = JSON.parse(readFileSync(at("layouts/octo-git.json"), "utf8"));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

test("Git shares the terminals' spot: stack work-view holds main, then git", () => {
  const stack = find(root, "work-view");
  assert.equal(stack.type, "stack");
  assert.equal(stack.active, "main");
  assert.deepEqual(stack.children.map((c) => c.id), ["main", "git"]);
  assert.equal(stack.children[0].content.tab, "active");
  assert.deepEqual(stack.children[1].content, { mod: "octo-git", props: { view: true } });
});

test("the button sits after Herdr's own tab bar, in the same row", () => {
  const row = find(root, "tab-row");
  assert.deepEqual(row.children.map((c) => c.id), ["tabs", "git-button"]);
  assert.equal(row.children[0].content.mod, "tabs");
  assert.deepEqual(row.children[1].content, { mod: "octo-git", props: { button: true } });
  assert.equal(row.resizable, false);
});

test("Herdr's mods are used as shipped, and the tab bar still finds its panel", () => {
  for (const id of ["sidebar", "panel", "panel-body", "files", "changes", "status"]) assert.ok(find(root, id), id);
  assert.equal(find(root, "status").content.mod, "workspace-status");
});

test("the preview picture exists", () => {
  assert.equal(root.preview, "layouts/octo-git.svg");
  assert.ok(existsSync(at(root.preview)));
});
