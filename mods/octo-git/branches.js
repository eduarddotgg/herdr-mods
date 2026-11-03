// The branch menu's logic: reading git's refs and deciding what the menu lists
// and offers. Nothing here runs git.

// One line per ref from `git for-each-ref --format=REF_FORMAT`: the full ref
// name, its upstream, how far it is from it ("ahead 2, behind 4", "gone"), and
// "*" on the checked-out branch.
export const REF_FORMAT = "%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)";

// A ref: { kind: "local" | "remote" | "tag", name, upstream, ahead, behind,
// current, gone }. A remote branch's name keeps its remote ("origin/x");
// `remote` and `short` take it apart.
export function parseRefs(text) {
  const out = { local: [], remote: [], tags: [] };
  for (const entry of text.split("\n")) {
    if (!entry) continue;
    const [full, upstream, track, head] = entry.split("\0");
    const ref = { upstream: upstream || null, ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), current: head === "*", gone: track === "gone" };
    if (full.startsWith("refs/heads/")) out.local.push({ kind: "local", name: full.slice(11), ...ref });
    else if (full.startsWith("refs/tags/")) out.tags.push({ kind: "tag", name: full.slice(10), ...ref });
    else if (full.startsWith("refs/remotes/")) {
      const name = full.slice(13), cut = name.indexOf("/");
      // origin/HEAD only points at another remote branch.
      if (cut < 0 || name.slice(cut + 1) === "HEAD") continue;
      out.remote.push({ kind: "remote", name, remote: name.slice(0, cut), short: name.slice(cut + 1), ...ref });
    }
  }
  return out;
}

// Branches switched to or from, newest first, from `git reflog --format=%gs`
// lines: the ones still in `local` and not checked out now.
export function recentBranches(reflog, { local, current, limit = 5 }) {
  const known = new Set(local), out = [];
  for (const line of reflog.split("\n")) {
    const move = /^checkout: moving from (\S+) to (\S+)$/.exec(line);
    if (!move) continue;
    for (const name of [move[2], move[1]]) {
      if (name === current || !known.has(name) || out.includes(name)) continue;
      out.push(name);
      if (out.length === limit) return out;
    }
  }
  return out;
}

// The actions above the branches; null is a separator.
export const ACTIONS = [
  { id: "update-project", label: "Update Project…", icon: "update" },
  { id: "commit", label: "Commit…", icon: "commit" },
  { id: "push", label: "Push…", icon: "push" },
  null,
  { id: "new-branch", label: "New Branch…", icon: "plus" },
  { id: "checkout-revision", label: "Checkout Tag or Revision…", icon: null },
];

const SECTIONS = [
  { id: "recent", label: "Recent", open: true },
  { id: "local", label: "Local", open: true },
  { id: "remote", label: "Remote", open: false },
  { id: "tags", label: "Tags", open: false },
];
const MAX_MATCHES = 300;

// The menu as rows, top to bottom. Each row has a unique `key`:
//   { kind: "action", id, label, icon }, { kind: "sep" },
//   { kind: "section", id, label, open }, { kind: "folder", path, label, depth, open },
//   { kind: "branch", ref, label, depth }, { kind: "note", label }.
// `toggled` holds the keys of sections and folders flipped from their default
// (Recent and Local open, Remote and Tags closed, folders open). A name with
// "/" sits in folders; Recent lists whole names. A search opens everything,
// shows only what matches and at most MAX_MATCHES branches.
export function menuRows({ refs, recent, query, toggled }) {
  const q = query.trim().toLowerCase(), rows = [];
  const byName = new Map(refs.local.map((r) => [r.name, r]));
  const lists = {
    recent: recent.map((name) => byName.get(name)).filter(Boolean),
    local: refs.local, remote: refs.remote, tags: refs.tags,
  };
  let total = 0, room = MAX_MATCHES;
  if (q) {
    for (const id of Object.keys(lists)) {
      const hits = lists[id].filter((r) => r.name.toLowerCase().includes(q));
      total += hits.length;
      lists[id] = hits.slice(0, room);
      room -= lists[id].length;
    }
  }
  const isOpen = (key, open) => q ? true : toggled.has(key) ? !open : open;

  let seps = 0;
  const sep = () => rows.push({ key: `sep:${seps++}`, kind: "sep" });
  for (const action of ACTIONS) {
    if (!action) { if (!q) sep(); continue; }
    if (!q || action.label.toLowerCase().includes(q)) rows.push({ key: `a:${action.id}`, kind: "action", ...action });
  }
  if (!q) sep();

  for (const section of SECTIONS) {
    const list = lists[section.id];
    if (q && !list.length) continue;
    if (section.id === "recent" && !list.length) continue;
    const key = `s:${section.id}`, open = isOpen(key, section.open);
    rows.push({ key, kind: "section", id: section.id, label: section.label, open });
    if (!open) continue;
    if (section.id === "recent") {
      for (const ref of list) rows.push({ key: `b:recent:${ref.name}`, kind: "branch", ref, label: ref.name, depth: 1 });
      continue;
    }
    const walk = (node, path, depth) => {
      for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const at = path ? `${path}/${name}` : name, fkey = `f:${section.id}:${at}`, fopen = isOpen(fkey, true);
        rows.push({ key: fkey, kind: "folder", path: at, label: name, depth, open: fopen });
        if (fopen) walk(child, at, depth + 1);
      }
      for (const [label, ref] of node.leaves.sort(([a], [b]) => a.localeCompare(b))) rows.push({ key: `b:${section.id}:${ref.name}`, kind: "branch", ref, label, depth });
    };
    walk(folderTree(list), "", 1);
  }
  if (q && total > MAX_MATCHES) rows.push({ key: "note", kind: "note", label: `Showing ${MAX_MATCHES} of ${total.toLocaleString("en-US")} branches` });
  return rows;
}

function folderTree(refs) {
  const root = { folders: new Map(), leaves: [] };
  for (const ref of refs) {
    const parts = ref.name.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), leaves: [] });
      node = node.folders.get(part);
    }
    node.leaves.push([parts.at(-1), ref]);
  }
  return root;
}

// What a branch's submenu offers, null being a separator. `current` is the
// checked-out branch's name ("" with a detached HEAD: nothing to merge into).
export function branchActions(ref, current) {
  const name = ref.name, local = ref.kind === "local", tag = ref.kind === "tag", here = Boolean(current);
  if (local && ref.current) {
    return [{ id: "new-from", label: `New Branch from '${name}'…` }, null, { id: "update", label: "Update" }, { id: "push", label: "Push…" }, null, { id: "rename", label: "Rename…" }];
  }
  const list = [
    { id: "checkout", label: "Checkout" },
    { id: "new-from", label: `New Branch from '${name}'…` },
    here && !tag && { id: "checkout-rebase", label: `Checkout and Rebase onto '${current}'` },
    local && { id: "checkout-update", label: "Checkout and Update" },
    null,
    here && !tag && { id: "rebase-onto", label: `Rebase '${current}' onto '${name}'` },
    here && { id: "merge-into", label: `Merge '${name}' into '${current}'` },
    null,
    !tag && { id: "worktree", label: `New Worktree from '${name}'…` },
    null,
    local && { id: "update", label: "Update" },
    local && { id: "push", label: "Push…" },
    null,
    local && { id: "rename", label: "Rename…" },
    { id: "delete", label: "Delete" },
  ].filter((entry) => entry !== false);
  // No separator first, last or twice in a row.
  return list.filter((entry, i) => entry !== null || (i > 0 && list[i - 1] !== null && list.slice(i + 1).some(Boolean)));
}

// What Update does for a branch, from its upstream and how far apart they are.
export function updateStep({ upstream, ahead = 0, behind = 0, gone = false }) {
  if (!upstream) return "no-upstream";
  if (gone) return "gone";
  if (!behind) return "up-to-date";
  return ahead ? "ask" : "fast-forward";
}

// The files git names when it refuses to switch or merge because they'd be
// overwritten: tab-indented lines under each "would be overwritten by" line.
export function blockedFiles(stderr) {
  const out = [];
  let listing = false;
  for (const line of stderr.split("\n")) {
    if (/would be overwritten by/.test(line)) { listing = true; continue; }
    if (listing && line.startsWith("\t")) { out.push(line.slice(1)); continue; }
    listing = false;
  }
  return out;
}

// git's message without hints, blank lines or "error:" prefixes, at most 6 lines.
export function gitError(text) {
  return text.split("\n").filter((line) => line.trim() && !line.startsWith("hint:"))
    .map((line) => line.replace(/^(error|fatal|warning): /, "")).slice(0, 6).join("\n");
}

// A new worktree's default folder: beside the repo, "<repo>-<branch>".
export function worktreeFolder(root, branch) {
  const base = root.replace(/\/+$/, ""), cut = base.lastIndexOf("/");
  return `${base.slice(0, cut)}/${base.slice(cut + 1)}-${branch.replaceAll("/", "-")}`;
}

// Where Push sends a local branch: the same name, on its upstream's remote, or
// on origin (else the first remote) when it has none yet. Null with no remotes.
export function pushTarget(ref, remotes) {
  if (!remotes.length) return null;
  const remote = ref.upstream
    ? remotes.find((r) => ref.upstream.startsWith(`${r}/`)) ?? ref.upstream.split("/")[0]
    : remotes.includes("origin") ? "origin" : remotes[0];
  return { remote, branch: ref.name };
}

// `git show --no-patch --format=COMMIT_FORMAT`: what the push dialog shows for a commit.
export const COMMIT_FORMAT = "%h%x00%an%x00%ae%x00%ad%x00%s%x00%b";
export function parseCommit(text) {
  const [short, author, email, date, subject, ...body] = text.split("\0");
  return { short, author, email, date, subject, body: body.join("\0").trim() };
}

// `git diff-tree -r --name-status -z`: the files a commit changed, [{ status, path }].
export function parseNameStatus(text) {
  const parts = text.split("\0").filter(Boolean), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}
