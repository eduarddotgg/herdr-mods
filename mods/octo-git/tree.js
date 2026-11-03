// The change tree: folders nest by path, and a folder whose only child is one
// folder folds into it ("apps/shop"), as JetBrains' commit view does.

const byName = (a, b) => a.name.localeCompare(b.name);

// "all" when every file is fully staged, "none" when none is, else "some".
function stagedOf(states) {
  if (states.every((s) => s === "all")) return "all";
  if (states.every((s) => s === "none")) return "none";
  return "some";
}

function finish(node) {
  const dirs = [...node.dirs.values()].map(finish).map((dir) => {
    while (dir.dirs.length === 1 && dir.files.length === 0) {
      const only = dir.dirs[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return dir;
  }).sort(byName);
  const files = node.files.sort(byName);
  const paths = [...dirs.flatMap((d) => d.paths), ...files.map((f) => f.path)];
  const staged = stagedOf([...dirs.map((d) => d.staged), ...files.map((f) => f.staged)]);
  return { name: node.name, path: node.path, dirs, files, paths, staged };
}

// files: [{ path, staged: "all" | "some" | "none", ... }]
export function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ ...file, name });
  }
  return finish(root);
}

// Rows top to bottom; folders whose path is in `collapsed` hide their contents.
// The root row's path is "".
export function flattenTree(tree, collapsed) {
  const rows = [{ kind: "dir", key: "d:", depth: 0, node: tree, root: true, open: !collapsed.has("") }];
  const walk = (node, depth) => {
    for (const dir of node.dirs) {
      const open = !collapsed.has(dir.path);
      rows.push({ kind: "dir", key: `d:${dir.path}`, depth, node: dir, open });
      if (open) walk(dir, depth + 1);
    }
    for (const file of node.files) rows.push({ kind: "file", key: `f:${file.path}`, depth, file });
  };
  if (rows[0].open) walk(tree, 1);
  return rows;
}

// A folder's path and the paths of every folder under it.
export const dirPaths = (node) => [node.path, ...node.dirs.flatMap(dirPaths)];

// The files whose path holds `query`, ignoring case; all of them for a blank query.
export function filterFiles(files, query) {
  const text = query.trim().toLowerCase();
  return text ? files.filter((f) => f.path.toLowerCase().includes(text)) : files;
}
