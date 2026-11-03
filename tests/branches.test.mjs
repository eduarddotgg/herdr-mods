import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefs, recentBranches, menuRows, ACTIONS, branchActions, updateStep, blockedFiles, gitError, worktreeFolder, pushTarget, parseCommit, parseNameStatus } from "../mods/octo-git/branches.js";

const line = (ref, upstream = "", track = "", head = " ") => [ref, upstream, track, head].join("\0");
const REFS = [
  line("refs/heads/main", "origin/main", "ahead 2, behind 4", "*"),
  line("refs/heads/release/1.4/hotfix"),
  line("refs/heads/old", "origin/old", "gone"),
  line("refs/heads/feature/x", "origin/feature/x", "behind 3"),
  line("refs/remotes/origin/HEAD"),
  line("refs/remotes/origin/main"),
  line("refs/remotes/origin/feature/x"),
  line("refs/tags/v1.0"),
].join("\n") + "\n";

test("parses local, remote and tag refs", () => {
  const refs = parseRefs(REFS);
  assert.deepEqual(refs.local.map((r) => r.name), ["main", "release/1.4/hotfix", "old", "feature/x"]);
  assert.deepEqual(refs.local[0], { kind: "local", name: "main", upstream: "origin/main", ahead: 2, behind: 4, current: true, gone: false });
  assert.deepEqual(refs.local[1], { kind: "local", name: "release/1.4/hotfix", upstream: null, ahead: 0, behind: 0, current: false, gone: false });
  assert.equal(refs.local[2].gone, true);
  assert.equal(refs.local[2].ahead + refs.local[2].behind, 0);
  assert.equal(refs.local[3].behind, 3);
  assert.deepEqual(refs.remote.map((r) => r.name), ["origin/main", "origin/feature/x"]);
  assert.deepEqual(refs.remote[1], { kind: "remote", name: "origin/feature/x", remote: "origin", short: "feature/x", upstream: null, ahead: 0, behind: 0, current: false, gone: false });
  assert.deepEqual(refs.tags.map((r) => [r.kind, r.name]), [["tag", "v1.0"]]);
});

test("recent branches come from checkouts, newest first, existing and not current", () => {
  const reflog = [
    "checkout: moving from feature/x to main",
    "commit: b",
    "checkout: moving from deleted to feature/x",
    "checkout: moving from main to deleted",
    "checkout: moving from feature/x to main",
    "checkout: moving from release/1.4/hotfix to feature/x",
  ].join("\n");
  const local = ["main", "feature/x", "release/1.4/hotfix"];
  assert.deepEqual(recentBranches(reflog, { local, current: "main" }), ["feature/x", "release/1.4/hotfix"]);
  assert.deepEqual(recentBranches(reflog, { local, current: "main", limit: 1 }), ["feature/x"]);
});

const labels = (rows) => rows.map((r) => r.kind === "sep" ? "—" : `${"  ".repeat(r.depth ?? 0)}${r.kind}:${r.label ?? ""}`);

test("menu rows: actions, then Recent and Local open, Remote and Tags closed, '/' as folders", () => {
  const refs = parseRefs(REFS);
  const rows = menuRows({ refs, recent: ["feature/x"], query: "", toggled: new Set() });
  assert.deepEqual(labels(rows), [
    "action:Update Project…", "action:Commit…", "action:Push…", "—", "action:New Branch…", "action:Checkout Tag or Revision…", "—",
    "section:Recent", "  branch:feature/x",
    "section:Local", "  folder:feature", "    branch:x", "  folder:release", "    folder:1.4", "      branch:hotfix", "  branch:main", "  branch:old",
    "section:Remote", "section:Tags",
  ]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  const recentRow = rows.find((r) => r.kind === "branch");
  assert.equal(recentRow.ref.name, "feature/x");
  // Toggling flips the defaults.
  const local = rows.find((r) => r.label === "Local"), remote = rows.find((r) => r.label === "Remote");
  const flipped = menuRows({ refs, recent: [], query: "", toggled: new Set([local.key, remote.key]) });
  assert.deepEqual(labels(flipped).slice(7), ["section:Local", "section:Remote", "  folder:origin", "    folder:feature", "      branch:x", "    branch:main", "section:Tags"]);
});

test("search filters actions and branches, opens everything, drops empties", () => {
  const refs = parseRefs(REFS);
  const rows = menuRows({ refs, recent: [], query: "FEAT", toggled: new Set() });
  assert.deepEqual(labels(rows), [
    "section:Local", "  folder:feature", "    branch:x",
    "section:Remote", "  folder:origin", "    folder:feature", "      branch:x",
  ]);
  assert.deepEqual(labels(menuRows({ refs, recent: [], query: "push", toggled: new Set() })), ["action:Push…"]);
});

test("search caps branch rows at 300 with a note", () => {
  const many = Array.from({ length: 1000 }, (_, i) => line(`refs/remotes/origin/b${i}`)).join("\n");
  const rows = menuRows({ refs: parseRefs(many), recent: [], query: "b", toggled: new Set() });
  assert.equal(rows.filter((r) => r.kind === "branch").length, 300);
  assert.equal(rows.at(-1).kind, "note");
  assert.match(rows.at(-1).label, /300 of 1,000/);
});

test("actions per kind of row", () => {
  const ids = (list) => list.map((a) => a?.id ?? "—");
  const refs = parseRefs(REFS);
  const [main, , , feature] = refs.local;
  assert.deepEqual(ACTIONS.map((a) => a?.id ?? "—"), ["update-project", "commit", "push", "—", "new-branch", "checkout-revision"]);
  assert.deepEqual(ids(branchActions(feature, "main")), ["checkout", "new-from", "checkout-rebase", "checkout-update", "—", "rebase-onto", "merge-into", "—", "worktree", "—", "update", "push", "—", "rename", "delete"]);
  assert.deepEqual(ids(branchActions(main, "main")), ["new-from", "—", "update", "push", "—", "rename"]);
  assert.deepEqual(ids(branchActions(refs.remote[1], "main")), ["checkout", "new-from", "checkout-rebase", "—", "rebase-onto", "merge-into", "—", "worktree", "—", "delete"]);
  assert.deepEqual(ids(branchActions(refs.tags[0], "main")), ["checkout", "new-from", "—", "merge-into", "—", "delete"]);
  const labels = branchActions(feature, "main").filter(Boolean).map((a) => a.label);
  assert.ok(labels.includes("Checkout and Rebase onto 'main'"));
  assert.ok(labels.includes("Rebase 'main' onto 'feature/x'"));
  assert.ok(labels.includes("Merge 'feature/x' into 'main'"));
  assert.ok(labels.includes("New Worktree from 'feature/x'…"));
  // Detached HEAD: nothing to rebase or merge into by name.
  assert.deepEqual(ids(branchActions(feature, "")), ["checkout", "new-from", "checkout-update", "—", "worktree", "—", "update", "push", "—", "rename", "delete"]);
  assert.deepEqual(ids(branchActions(refs.tags[0], "")), ["checkout", "new-from", "—", "delete"]);
});

test("update step", () => {
  assert.equal(updateStep({ upstream: null }), "no-upstream");
  assert.equal(updateStep({ upstream: "origin/old", gone: true }), "gone");
  assert.equal(updateStep({ upstream: "origin/main", ahead: 0, behind: 0 }), "up-to-date");
  assert.equal(updateStep({ upstream: "origin/main", ahead: 3, behind: 0 }), "up-to-date");
  assert.equal(updateStep({ upstream: "origin/main", ahead: 0, behind: 2 }), "fast-forward");
  assert.equal(updateStep({ upstream: "origin/main", ahead: 1, behind: 2 }), "ask");
});

test("files named in git's refusal to switch", () => {
  const stderr = [
    "error: Your local changes to the following files would be overwritten by checkout:",
    "\tf",
    "\tsrc/a b.ts",
    "Please commit your changes or stash them before you switch branches.",
    "error: The following untracked working tree files would be overwritten by checkout:",
    "\tnew",
    "Please move or remove them before you switch branches.",
    "Aborting",
  ].join("\n");
  assert.deepEqual(blockedFiles(stderr), ["f", "src/a b.ts", "new"]);
  assert.deepEqual(blockedFiles("fatal: invalid reference: nope"), []);
});

test("git errors lose hints and prefixes", () => {
  const text = "error: the branch 'other' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D other'\nhint: Disable this message\n";
  assert.equal(gitError(text), "the branch 'other' is not fully merged");
  assert.equal(gitError("fatal: a\n\nb\nc\nd\ne\nf\ng\nh"), "a\nb\nc\nd\ne\nf");
});

test("worktree folder sits beside the repo", () => {
  assert.equal(worktreeFolder("/a/shop", "feature/x"), "/a/shop-feature-x");
  assert.equal(worktreeFolder("/a/shop/", "main"), "/a/shop-main");
});

test("push goes to the same name on the upstream's remote", () => {
  const refs = parseRefs(REFS);
  assert.deepEqual(pushTarget(refs.local[0], ["origin"]), { remote: "origin", branch: "main" });
  assert.deepEqual(pushTarget({ ...refs.local[0], upstream: "fork/other" }, ["origin", "fork"]), { remote: "fork", branch: "main" });
  assert.deepEqual(pushTarget(refs.local[1], ["upstream", "origin"]), { remote: "origin", branch: "release/1.4/hotfix" });
  assert.deepEqual(pushTarget(refs.local[1], ["mine"]), { remote: "mine", branch: "release/1.4/hotfix" });
  assert.equal(pushTarget(refs.local[1], []), null);
});

test("a commit's details", () => {
  const text = "1393301\x00Jet User\x00jet@example.com\x0019.08.25 at 20:57\x00Add info about git diff\x00First line\n\nSecond\n\n";
  assert.deepEqual(parseCommit(text), { short: "1393301", author: "Jet User", email: "jet@example.com", date: "19.08.25 at 20:57", subject: "Add info about git diff", body: "First line\n\nSecond" });
  assert.equal(parseCommit("a\x00b\x00c\x00d\x00subject\x00\n").body, "");
});

test("a commit's files from diff-tree --name-status -z", () => {
  assert.deepEqual(parseNameStatus("M\x00src/a b.ts\x00A\x00docs/new.md\x00D\x00old.txt\x00"), [
    { status: "M", path: "src/a b.ts" }, { status: "A", path: "docs/new.md" }, { status: "D", path: "old.txt" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});
