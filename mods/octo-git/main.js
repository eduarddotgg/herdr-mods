// octo-git: a commit view (the change tree, checkboxes = staged) beside one
// scrolling side-by-side diff of every changed file, with review comments
// that go to a coding agent. It lives in its space's "Octo Git" tab; the key opens
// that tab, or brings it back. The octo-git layout gives it the terminals' spot
// instead, with a button beside the tab bar.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list, VirtualListScrollHandle, h_resizable, v_resizable, resizable_panel, Popup } from "gpui-base";
import { spaces, panes, focused, agents, knownAgents, exec, hc, run, readTextFile, watchFolder, theme, settings, props, closeOverlay, shared, setShared, layout } from "herdr";
import { buildTree, flattenTree, dirPaths, filterFiles } from "./tree.js";
import { splitDiff, sideBySide, unified, addedLines, countLines, gaps, withContext, fileLines } from "./diff.js";
import { anchorOf, wrapText, reviewPrompt, fingerprint, viewedPaths } from "./review.js";
import { BranchMenu } from "./branch-menu.js";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
const MAX_FILES = 1000, MAX_ROWS = 1500, MAX_NEW = 200, MAX_NEW_CHARS = 400000;
// Files open by default until the diff holds this many rows; later ones start folded.
const ROW_BUDGET = 20000;
const SIZE = { header: 40, hunk: 24, line: 20, notice: 28, gap: 6 };
// Rows in a virtual list can't have their own click handlers, so a click in the
// diff is placed by its x (px from the list's left edge) against these.
// A file header: chevron, then the checkbox.
const HEADER_PAD = 10, CHEVRON = 12, GAP = 8, BOX = 16;
const CHECK_X = HEADER_PAD + CHEVRON + GAP;
// The header's comment icon sits this far from the right edge; a click within
// COMMENT_ZONE px of it comments on the whole file.
const HEADER_RIGHT = 24, COMMENT_ZONE = 60;
// Left of the comment zone, GitHub's "Viewed" checkbox: a fixed-width button.
const VIEWED = 84;
// The name starts after the checkbox and a 14px file icon. It and the folder are
// 13px mono (≈ 7.8px a character), so the copy button after them is placed, and
// its click found, from their lengths.
const NAME_X = CHECK_X + BOX + GAP + 14 + GAP, HEADER_CHAR = 7.8, COPY = 22;
// A header's change bar: this many 8px blocks, 2px apart.
const STAT = { blocks: 5, size: 8, gap: 2 };
// A line's half: colour bar, line number, the + shown on hover, then the code.
// A click on that gutter comments on the line.
const BAR = 3, NUM = 40, PLUS = 22, GUTTER = BAR + NUM + PLUS;
// The unified view's one column numbers both sides: old, then new.
const UGUTTER = BAR + 2 * NUM + PLUS;
// Comment cards and the comment box sit in the half their line is on, indented
// to the code (whole-file ones span both). Card text is wrapped here (12px mono
// ≈ 7.2px a character) so each row's height is known before it's drawn.
// `space` is the room kept above a card and below it.
const CARD = { margin: 12, pad: 12, head: 30, line: 18, char: 7.2, icon: 24, space: 6 };
// The comment box: three rows, its buttons right-aligned in the last.
const DRAFT = { head: 34, body: 112, foot: 46, save: 84, cancel: 72, gap: 8 };
// Review comments per repo, kept in shared state so they outlast the tab. The
// key keeps the mod's first name ("git-ui"), so comments saved then still show.
const REVIEWS = "git-ui.reviews";
// Files marked "Viewed", per repo: { path: fingerprint of its changes then }.
const VIEWED_KEY = "octo-git.viewed";

const icon = (name) => `mods/octo-git/${name}.svg`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Where the active space is, as Herdr's sidebar has it: the focused terminal's
// live folder when it's in this space, else its first terminal's, else where the
// space was made.
function location() {
  const space = spaces().find((s) => s.active), f = focused(), ps = panes();
  const here = Boolean(space) && f?.space === space.id, tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const pane = here && f.pane ? ps.find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || (here ? f.cwd : null) || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space?.folder, on };
}

// The octo-git layout gives octo-git the terminals' spot instead of a tab: a stack
// VIEW whose children are "main" (the tab's terminals) and "git" (this mod, with
// props { view: true }). The button beside the tab bar (props { button: true })
// flips it.
const VIEW = "work-view";
function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}
const viewStack = () => { const stack = findNode(layout(), VIEW); return stack?.children?.some((c) => c.id === "git") ? stack : null; };

// The key (mod.open) and the button land here. With the view, it flips between
// Git and the terminals; otherwise it shows the space's Octo Git tab, made from
// where the focused pane is the first time.
function openTab() {
  const stack = viewStack();
  if (stack) return run("layout.select", { stack: VIEW, child: stack.active === "git" ? "main" : "git" });
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const ids = new Set(space.tabs.map((t) => t.id));
  const pane = panes().find((p) => p.mod === "octo-git" && ids.has(p.tab));
  if (pane) return run("tab.select", { id: pane.tab });
  const { cwd, on } = location();
  run("tab.new", { space: space.id, name: "Octo Git", mod: "octo-git", props: { folder: cwd, on, space: space.id } });
}

// Porcelain XY → what the tree shows and whether the checkbox is full, partial or empty.
function fileOf(entry) {
  const x = entry[0], y = entry[1], path = entry.slice(3), untracked = x === "?";
  const conflict = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
  const status = conflict ? "U" : untracked || x === "A" ? "A" : x === "D" || y === "D" ? "D" : "M";
  const inIndex = !untracked && !conflict && x !== " ", inTree = untracked || conflict || y !== " ";
  return { path, status, untracked, staged: inIndex && !inTree ? "all" : inIndex ? "some" : "none", add: 0, del: 0, binary: false };
}

export default class GitUi extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.overlay) { this.launcher = true; openTab(); closeOverlay(p.overlay); return; }
    if (p.button) { this.asButton = true; return; }
    this.where = p.folder ? { cwd: p.folder, on: p.on ?? null } : location();
    this.space = p.space ?? focused()?.space ?? null;
    // In the view (no tab of its own), it follows the active space, and the
    // repo of the terminal you were in when Git was shown.
    this.view = Boolean(p.view);
    if (this.view) this.space = spaces().find((s) => s.active)?.id ?? null;
    this.files = []; this.byPath = new Map(); this.diffs = new Map();
    this.collapsedDirs = new Set(); this.openFiles = new Map();
    this.items = []; this.sizes = []; this.headerIndex = new Map();
    this.tree = buildTree([]); this.treeRows = [];
    // The tree's filter. Folders closed while filtering are kept apart and
    // forgotten when the text changes, so the matches always show first.
    this.query = ""; this.filterCollapsed = new Set();
    this.filterInput = InputState.new({ placeholder: "Filter files…" });
    this.filterInput.on("change", (_e, cx) => this.setQuery(this.filterInput.value(), cx));
    this.filterInput.on("focus", (_e, cx) => { this.filtering = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.filtering = false; cx.notify(); });
    this.scroll = VirtualListScrollHandle.new();
    // "split" or "unified"; the items the list last drew, top to bottom; whether
    // the file panel (tree and commit box) shows.
    this.layout = "split"; this.top = 0; this.bottom = 0; this.panel = true;
    this.message = "";
    this.textarea = TextareaState.new({ placeholder: "Commit message" });
    this.textarea.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.textarea.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.textarea.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.textarea.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    // Lines shown around the changes, per file: new-file ranges, and the file's
    // text they come from (read on the first expand, again on each reload).
    this.revealed = new Map(); this.sources = new Map();
    this.diffWidth = 0; this.diffHeight = 0; this.keyIndex = new Map(); this.commentCount = new Map(); this.order = [];
    this.draft = null; this.commentText = ""; this.submitting = false; this.closedAt = 0; this.known = []; this.target = null;
    this.commentInput = TextareaState.new({ placeholder: "Leave a comment" });
    this.commentInput.on("change", (_e, cx) => {
      const had = Boolean(this.commentText.trim());
      this.commentText = this.commentInput.value();
      if (had !== Boolean(this.commentText.trim())) cx.notify();
    });
    this.noteInput = TextareaState.new({ placeholder: "Leave a note for the agent (optional)" });
    this.branches = new BranchMenu(this, cx);
    this.loadedAt = 0;
    this.refresh(cx);
    // A Git tab in the background only notes that something changed, and
    // catches up when it's shown again.
    cx.timer.every(2000, (cx) => {
      if (this.shown() && (this.stale || Date.now() - this.loadedAt >= 10000)) this.refresh(cx);
    });
    if (this.view) cx.timer.every(250, (cx) => this.follow(cx));
  }

  shown() {
    if (this.view) return viewStack()?.active === "git";
    if (!this.space) return true;
    const space = spaces().find((s) => s.id === this.space), tab = space?.active && space.tabs.find((t) => t.active);
    return Boolean(tab && panes().some((p) => p.tab === tab.id && p.mod === "octo-git"));
  }

  // The view: shown again or in another space, it takes that space's repo (see
  // location()). Herdr's tab bar can't bring the terminals back, so another tab
  // chosen in the same space while Git shows does that here.
  follow(cx) {
    const visible = this.shown(), space = spaces().find((s) => s.active), tab = space?.tabs.find((t) => t.active)?.id ?? null;
    const moved = space?.id === this.viewSpace && tab !== this.viewTab;
    this.viewTab = tab;
    if (visible && moved && this.wasShown) { run("layout.select", { stack: VIEW, child: "main" }); this.wasShown = false; return; }
    if (visible && (!this.wasShown || space?.id !== this.viewSpace)) {
      const where = location(), id = space?.id ?? null;
      if (id !== this.space || where.cwd !== this.where.cwd || where.on !== this.where.on) { this.space = id; this.where = where; this.refresh(cx); }
    }
    this.viewSpace = space?.id ?? null;
    this.wasShown = visible;
  }

  // The button at the tab bar's right end, drawn like its Files and Changes
  // buttons on the bar's own background and bottom border.
  renderButton() {
    const t = theme(), on = viewStack()?.active === "git";
    return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("octo-git-button").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => openTab())
        .child(svg(icon("branch")).size(14)).child("Octo Git"));
  }

  // Another repo: what was opened, expanded or selected in the last one goes.
  forget() {
    this.collapsedDirs = new Set(); this.openFiles = new Map(); this.revealed = new Map(); this.sources = new Map();
    this.selected = null; this.draft = null; this.query = ""; this.filterInput.set_value(""); this.filterCollapsed = new Set();
    this.branches.refs = { local: [], remote: [], tags: [] }; this.branches.recent = [];
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched !== root) break;
          if (this.shown()) this.refresh(cx); else this.stale = true;
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = this.where;
    if (!cwd) { this.error = "No folder"; cx.notify(); return; }
    this.loading = true; this.again = false; this.stale = false; this.loadedAt = Date.now();
    cx.spawn(async (cx) => {
      try { await this.load(cwd, on, cx); }
      catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.loading = false;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async load(cwd, on, cx) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (top.code !== 0) { this.root = null; this.setFiles([], new Map()); this.error = `Not a git repository: ${cwd}`; return; }
    const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
    if (status.code !== 0) throw new Error(status.stderr.trim());
    const hasHead = (await git(["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
    const branch = (await git(["branch", "--show-current"])).stdout.trim();
    const head = branch || !hasHead ? "" : (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
    // A merge or rebase stopped partway leaves these behind; the bar under the header offers Abort and Continue.
    const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const exists = async (name) => (await readTextFile(`${gitDir}/${name}`, { on }).catch(() => null)) !== null;
    const progress = await exists("MERGE_HEAD") ? "merge" : await exists("rebase-merge/head-name") || await exists("rebase-apply/head-name") ? "rebase" : null;
    const entries = status.stdout.split("\0").filter(Boolean);
    const files = entries.slice(0, MAX_FILES).map(fileOf), byPath = new Map(files.map((f) => [f.path, f]));

    const numstats = hasHead ? [["diff", "HEAD"]] : [["diff", "--cached"], ["diff"]];
    for (const args of numstats) {
      const r = await git([...args, "--numstat", "-z", "--no-renames"]);
      if (r.code !== 0) throw new Error(r.stderr.trim());
      for (const entry of r.stdout.split("\0")) {
        const [a, d, ...rest] = entry.split("\t"), file = byPath.get(rest.join("\t"));
        if (!file) continue;
        file.add += Number(a) || 0; file.del += Number(d) || 0; file.binary = a === "-";
      }
    }

    // One `git diff` for every tracked file; new files are read whole.
    let blocks = new Map(), tooBig = false;
    if (hasHead) {
      try {
        const r = await git(["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3"]);
        if (r.code !== 0) throw new Error(r.stderr);
        blocks = splitDiff(r.stdout);
      } catch { tooBig = true; }
    }
    const diffs = new Map();
    for (const file of files) file.sig = fingerprint(`${file.status}:${file.add}:${file.del}`);
    const fresh = files.filter((f) => f.untracked || (!hasHead && f.status === "A"));
    await Promise.all(fresh.map(async (file, i) => {
      if (i >= MAX_NEW) return diffs.set(file.path, { notice: `Not read: more than ${MAX_NEW} new files` });
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) return diffs.set(file.path, { notice: "Cannot preview this file (binary, too large or unreadable)" });
      if (text.includes("\0")) return diffs.set(file.path, { notice: "Binary file" });
      file.add = countLines(text); file.sig = fingerprint(text);
      diffs.set(file.path, this.rowsOf(addedLines(text.slice(0, MAX_NEW_CHARS))));
    }));
    for (const file of files) {
      if (diffs.has(file.path)) continue;
      const block = blocks.get(file.path);
      if (file.binary || block?.binary) diffs.set(file.path, { notice: "Binary file" });
      else if (tooBig) diffs.set(file.path, { notice: "The diff is too large to show" });
      else if (!block?.lines.length) diffs.set(file.path, { notice: "No text changes" });
      else { diffs.set(file.path, this.rowsOf(block.lines)); file.sig = fingerprint(block.lines.join("\n")); }
    }

    const sources = new Map();
    await Promise.all([...this.revealed.keys()].filter((path) => byPath.has(path)).map(async (path) => {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text !== null) sources.set(path, fileLines(text));
    }));

    if (this.root && (root !== this.root || on !== this.on)) this.forget();
    this.root = root; this.on = on; this.hasHead = hasHead; this.branch = branch; this.head = head; this.progress = progress;
    this.limited = entries.length > MAX_FILES; this.error = null; this.sources = sources;
    this.setFiles(files, diffs);
    this.watch(root, cx);
  }

  rowsOf(lines) {
    const cap = (rows) => rows.length > MAX_ROWS ? { rows: rows.slice(0, MAX_ROWS), more: true } : { rows };
    return { split: cap(sideBySide(lines, MAX_ROWS + 1)), unified: cap(unified(lines, MAX_ROWS + 1)) };
  }

  setFiles(files, diffs) {
    this.files = files; this.diffs = diffs; this.byPath = new Map(files.map((f) => [f.path, f]));
    for (const path of this.openFiles.keys()) if (!this.byPath.has(path)) this.openFiles.delete(path);
    for (const path of this.revealed.keys()) if (!this.byPath.has(path)) this.revealed.delete(path);
    this.rebuild();
  }

  // The files marked "Viewed" whose changes are still the ones that were marked.
  get viewed() { return viewedPaths(this.reviewKey ? shared(VIEWED_KEY)?.[this.reviewKey] : null, this.files); }

  // As on GitHub: a viewed file folds, and unmarking it opens it again. Marks
  // that no longer match are dropped as they're saved.
  toggleViewed(path, cx) {
    const file = this.byPath.get(path);
    if (!file || !this.reviewKey) return;
    const all = { ...(shared(VIEWED_KEY) ?? {}) }, marks = {};
    for (const p of this.viewed) if (p !== path) marks[p] = this.byPath.get(p).sig;
    if (!this.viewed.has(path)) marks[path] = file.sig;
    if (Object.keys(marks).length) all[this.reviewKey] = marks; else delete all[this.reviewKey];
    setShared(VIEWED_KEY, all);
    this.openFiles.delete(path);
    this.rebuild();
    cx.notify();
  }

  get reviewKey() { return this.root ? `${this.on ?? ""}:${this.root}` : null; }
  get comments() { return (this.reviewKey && shared(REVIEWS)?.[this.reviewKey]) || []; }

  saveComments(list) {
    const all = { ...(shared(REVIEWS) ?? {}) };
    if (list.length) all[this.reviewKey] = list; else delete all[this.reviewKey];
    setShared(REVIEWS, all);
    this.rebuild();
  }

  // Where a card or the comment box spans, in px from the list's left edge:
  // "L" and "R" are the halves of the diff, "full" both. Unified, a line's
  // comments span the one column, indented to the code.
  span(place) {
    const width = this.diffWidth, half = (width - 1) / 2;
    if (place !== "full" && this.layout === "unified") return { left: UGUTTER, right: width - CARD.margin };
    if (place === "L") return { left: GUTTER, right: half - CARD.margin };
    if (place === "R") return { left: half + 1 + GUTTER, right: width - CARD.margin };
    return { left: CARD.margin, right: width - CARD.margin };
  }

  // The tree and the diff's rows follow the files, what's folded, the comments
  // and the comment being written.
  rebuild() {
    const tree = buildTree(this.files), filtered = Boolean(this.query.trim());
    this.tree = filtered ? buildTree(filterFiles(this.files, this.query)) : tree;
    this.treeRows = flattenTree(this.tree, filtered ? this.filterCollapsed : this.collapsedDirs);
    const order = flattenTree(tree, new Set()).filter((r) => r.kind === "file").map((r) => r.file.path);
    const items = [], sizes = [], headerIndex = new Map(), keyIndex = new Map(), commentCount = new Map();
    const push = (item, size) => { keyIndex.set(item.key, items.length); items.push(item); sizes.push(size); };
    const draft = this.draft;
    let drafted = false;
    const pushDraft = (place) => {
      drafted = true;
      push({ kind: "draft", part: "head", key: "d:head", place }, CARD.space + DRAFT.head);
      push({ kind: "draft", part: "body", key: "d:body", place }, DRAFT.body);
      push({ kind: "draft", part: "foot", key: "d:foot", place }, DRAFT.foot + CARD.space);
    };
    // A card being edited turns into the comment box, in its place.
    const pushComment = (comment, place, tone, detached) => {
      if (draft?.id === comment.id) return pushDraft(place);
      const { left, right } = this.span(place);
      const lines = wrapText(comment.text, Math.max(12, Math.floor((right - left - 2 - 2 * CARD.pad) / CARD.char)));
      push({ kind: "card", part: "head", key: `c:${comment.id}:head`, comment, place, tone, detached }, CARD.space + CARD.head);
      push({ kind: "card", part: "body", key: `c:${comment.id}:body`, comment, place, tone, lines }, lines.length * CARD.line + 18 + CARD.space);
    };
    const comments = this.comments;
    for (const c of comments) commentCount.set(c.path, (commentCount.get(c.path) ?? 0) + 1);
    let budget = ROW_BUDGET;
    // Kept for drawing: the headers and the toolbar's count read it every frame.
    const viewed = this.viewedNow = this.viewed;
    for (const path of order) {
      const entry = this.diffs.get(path) ?? { notice: "Loading…" }, diff = entry[this.layout] ?? entry, rows = diff.rows ?? [];
      const open = this.openFiles.get(path) ?? (!viewed.has(path) && rows.length <= budget);
      if (open) budget -= rows.length;
      headerIndex.set(path, items.length);
      push({ kind: "header", key: `h:${path}`, path, open }, SIZE.header);
      if (open) {
        const lines = this.sources.get(path) ?? null;
        const shown = withContext(rows, gaps(rows, { total: lines?.length ?? null, cut: Boolean(diff.more) }), { revealed: this.revealed.get(path), lines });
        // Each line comment goes under its line, in that line's half; whole-file
        // comments, and ones whose line has left the diff, go under the header.
        const atLine = new Map();
        for (const row of shown) {
          if (row.kind !== "line") continue;
          if (row.right) atLine.set(`R${row.right.number}`, []);
          if (row.left?.type === "del") atLine.set(`L${row.left.number}`, []);
        }
        for (const c of comments) {
          if (c.path !== path) continue;
          const list = atLine.get(anchorOf(c));
          if (list) list.push(c); else pushComment(c, "full", "accent", c.line != null);
        }
        if (draft && !draft.id && draft.path === path && draft.line == null) pushDraft("full");
        if (diff.notice) push({ kind: "notice", key: `n:${path}`, text: diff.notice }, SIZE.notice);
        const under = (side, number, tone) => {
          for (const c of atLine.get(`${side}${number}`)) pushComment(c, side, tone, false);
          if (draft && !draft.id && draft.path === path && draft.side === side && draft.line === number) pushDraft(side);
        };
        // A diff row keeps its key (`r:`) whatever is shown around it.
        shown.forEach((row) => {
          const key = row.kind === "expand" ? `e:${path}:${row.dir}:${row.from}` : row.context ? `x:${path}:${row.context}` : `r:${path}:${row.index}`;
          push({ ...row, key, path }, row.kind === "line" ? SIZE.line : SIZE.hunk);
          if (row.kind !== "line") return;
          if (row.left?.type === "del") under("L", row.left.number, "ansi1");
          if (row.right) under("R", row.right.number, row.right.type === "add" ? "ansi2" : "accent");
        });
        if (diff.more) push({ kind: "notice", key: `m:${path}`, text: `Showing the first ${MAX_ROWS.toLocaleString()} lines` }, SIZE.notice);
        // Its line left the diff while it was being written: keep it on screen.
        if (draft && !draft.id && draft.path === path && !drafted) pushDraft("full");
      }
      push({ kind: "gap", key: `g:${path}` }, SIZE.gap);
    }
    this.items = items; this.sizes = sizes; this.headerIndex = headerIndex;
    this.keyIndex = keyIndex; this.commentCount = commentCount; this.order = order;
  }

  // Checked → `git add`, unchecked → out of the index. The boxes flip at once;
  // the refresh after the command shows what git really did.
  stage(all, add, cx) {
    // Only files whose state changes: git rejects the whole command for a path it
    // has nothing to do with (a staged deletion to add, an untracked file to unstage).
    const paths = all.filter((path) => { const f = this.byPath.get(path); return f && f.staged !== (add ? "all" : "none"); });
    if (this.busy || !this.root || !paths.length) return;
    for (const path of paths) this.byPath.get(path).staged = add ? "all" : "none";
    this.rebuild();
    const root = this.root, on = this.on;
    const command = add ? ["add", "-A"] : this.hasHead ? ["restore", "--staged"] : ["rm", "--cached", "-r", "-q"];
    this.busy = true; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      try {
        for (let i = 0; i < paths.length; i += 200) {
          const r = await exec("git", ["--literal-pathspecs", ...command, "--", ...paths.slice(i, i + 200)], { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { this.note = `${add ? "Stage" : "Unstage"} failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // With `push`, the push dialog opens once the commit is made (Commit and Push…).
  commit(cx, push = false) {
    const message = this.message.trim();
    if (!message || !this.root || this.busy || !this.files.some((f) => f.staged !== "none")) return;
    const root = this.root, on = this.on;
    this.busy = true; this.note = null; this.done = null;
    cx.spawn(async (cx) => {
      let made = false;
      try {
        const r = await exec("git", ["commit", "-m", message], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.done = r.stdout.split("\n")[0];
        this.message = ""; this.textarea.set_value("");
        made = true;
      } catch (e) { this.note = `Commit failed: ${e?.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
      if (made && push) this.branches.pushCurrent(cx);
    });
    cx.notify();
  }

  setQuery(query, cx) {
    if (query === this.query) return;
    this.query = query; this.filterCollapsed = new Set();
    this.rebuild();
    cx.notify();
  }

  // Closing a folder closes every folder under it too, and they stay closed
  // when it opens again.
  toggleDir(row, cx) {
    const collapsed = this.query.trim() ? this.filterCollapsed : this.collapsedDirs;
    if (row.open) for (const path of dirPaths(row.node)) collapsed.add(path);
    else collapsed.delete(row.node.path);
    this.rebuild();
    cx.notify();
  }

  // Where a header's copy button sits, in px from the list's left edge: after the
  // folder path, or as far along as the counts and comment icon leave room for.
  copyX(file) {
    const slash = file.path.lastIndexOf("/"), name = file.path.length - slash - 1, folder = slash + 1;
    const counts = [file.add > 0 && `+${file.add}`, file.del > 0 && `−${file.del}`].filter(Boolean);
    const stat = file.add + file.del ? GAP + STAT.blocks * (STAT.size + STAT.gap) - STAT.gap : 0;
    const right = counts.reduce((w, c) => w + GAP + c.length * HEADER_CHAR, 0) + stat + GAP + VIEWED + GAP + COMMENT_ZONE + HEADER_RIGHT;
    const text = name * HEADER_CHAR + (folder ? 10 + folder * HEADER_CHAR : 0);
    return NAME_X + Math.max(0, Math.min(text + 10, this.diffWidth - NAME_X - right - COPY));
  }

  // The path relative to the repo; the button shows a check for a moment.
  copyPath(path, cx) {
    cx.write_to_clipboard(path);
    this.copied = path;
    cx.timer.after(1500, (cx) => { if (this.copied === path) { this.copied = null; cx.notify(); } });
    cx.notify();
  }

  // An expander shows its lines from the file as it is now (the diff's new
  // side), read the first time.
  expand(item, cx) {
    const path = item.path;
    this.revealed.set(path, [...(this.revealed.get(path) ?? []), [item.from, item.to]]);
    if (this.sources.has(path)) { this.rebuild(); cx.notify(); return; }
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      this.sources.set(path, text === null ? [] : fileLines(text));
      this.rebuild();
      cx.notify();
    });
  }

  toggleFile(path, cx) {
    const item = this.items[this.headerIndex.get(path)];
    this.openFiles.set(path, !item?.open);
    this.rebuild();
    cx.notify();
  }

  // A tree click: open that file's diff and bring its header to the top.
  reveal(path, cx) {
    this.selected = path;
    if (!this.items[this.headerIndex.get(path)]?.open) { this.openFiles.set(path, true); this.rebuild(); }
    const index = this.headerIndex.get(path);
    if (index !== undefined) this.scrollToTop(index, index > this.top, cx);
    cx.notify();
  }

  // The list scrolls an item only to its nearer edge, so one that's `below` the
  // top would stop at the bottom. It goes first to just past it, which leaves
  // it above the top, then back to it a moment later.
  scrollToTop(index, below, cx) {
    if (!below) return this.scroll.scroll_to_item(index, "top");
    let end = index, height = this.sizes[index];
    while (end + 1 < this.sizes.length && height <= this.diffHeight) height += this.sizes[++end];
    this.scroll.scroll_to_item(end, "top");
    cx.timer.after(40, (cx) => { this.scroll.scroll_to_item(index, "top"); cx.notify(); });
  }

  // The file the toolbar acts on: the one picked in the tree or with the arrows
  // while its header is on screen (the last file's can't always reach the top),
  // otherwise the one at the top of the diff.
  currentFile() {
    const picked = this.headerIndex.get(this.selected);
    if (picked !== undefined && picked >= this.top && picked < this.bottom) return this.selected;
    // A file's last item is its gap: with just that showing, the next file is on top.
    const top = this.items[this.top]?.kind === "gap" ? this.top + 1 : this.top;
    let path = null;
    for (const p of this.order) { if (this.headerIndex.get(p) > top) break; path = p; }
    return path;
  }

  // Where each change (a run of added or removed lines) starts, in the diff's
  // order, folded files' too: { path, row }.
  changes() {
    const cache = this.changeList;
    if (cache?.layout === this.layout && cache.diffs === this.diffs) return cache.starts;
    const changed = (row) => row?.kind === "line" && (row.left?.type === "del" || row.right?.type === "add");
    const starts = [];
    for (const path of this.order) {
      const rows = this.diffs.get(path)?.[this.layout]?.rows ?? [];
      rows.forEach((row, i) => { if (changed(row) && !changed(rows[i - 1])) starts.push({ path, row: i }); });
    }
    this.changeList = { layout: this.layout, diffs: this.diffs, starts };
    return starts;
  }

  // The change ↑ (-1) or ↓ (1) goes to: counted from the last one gone to while
  // it's on screen, else from the top of the diff. A folded file's changes
  // count as just under its header.
  changeTarget(by) {
    const at = this.keyIndex.get(this.change);
    const from = at !== undefined && at >= this.top && at < this.bottom ? at : this.top;
    const place = (c) => this.keyIndex.get(`r:${c.path}:${c.row}`) ?? this.headerIndex.get(c.path) + 0.5;
    const starts = this.changes();
    if (by > 0) return starts.find((c) => place(c) > from);
    for (let i = starts.length - 1; i >= 0; i--) if (place(starts[i]) < from) return starts[i];
  }

  // Its file unfolds, and the change's first line comes to the middle.
  stepChange(by, cx) {
    const target = this.changeTarget(by);
    if (!target) return;
    if (!this.items[this.headerIndex.get(target.path)]?.open) { this.openFiles.set(target.path, true); this.rebuild(); }
    this.change = `r:${target.path}:${target.row}`; this.selected = target.path;
    const index = this.keyIndex.get(this.change);
    if (index !== undefined) this.scroll.scroll_to_item(index, "center");
    cx.notify();
  }

  foldAll(open, cx) {
    for (const path of this.order) this.openFiles.set(path, open);
    this.rebuild();
    cx.notify();
  }

  // Switching keeps the file at the top in view. Where its header now is isn't
  // known, so it takes the way for one below the top, which works either way.
  setLayout(layout, cx) {
    if (layout === this.layout) return;
    const path = this.currentFile();
    this.layout = layout;
    this.rebuild();
    const index = this.headerIndex.get(path);
    if (index !== undefined) this.scrollToTop(index, true, cx);
    cx.notify();
  }

  clickDiff(key, cx) {
    const item = this.items[this.keyIndex.get(key)], x = this.downX ?? -1;
    if (item?.kind === "line") return this.clickLine(item, x, cx);
    if (item?.kind === "expand") return this.expand(item, cx);
    if (item?.kind === "card") return this.clickCard(item, x, cx);
    if (item?.kind === "draft" && item.part === "foot") return this.clickDraftButtons(item, x, cx);
    if (item?.kind !== "header") return;
    const path = item.path, file = this.byPath.get(path);
    if (x >= CHECK_X - 4 && x <= CHECK_X + BOX + 4) {
      if (file) this.stage([path], file.staged !== "all", cx);
      return;
    }
    if (file && x >= this.copyX(file) && x <= this.copyX(file) + COPY) return this.copyPath(path, cx);
    const viewedX = this.diffWidth - HEADER_RIGHT - COMMENT_ZONE - GAP - VIEWED;
    if (x >= viewedX && x <= viewedX + VIEWED) return this.toggleViewed(path, cx);
    if (x >= this.diffWidth - HEADER_RIGHT - COMMENT_ZONE) return this.openDraft({ path, side: null, line: null, code: null }, cx);
    this.toggleFile(path, cx);
  }

  // The gutter of a half comments on its line: a removed line on the left (L),
  // any line of the new file on the right (R). Unified, the one gutter does.
  clickLine(item, x, cx) {
    const right = (this.diffWidth - 1) / 2 + 1;
    const cell = this.layout === "unified" ? (x >= 0 && x < UGUTTER ? item.right ?? item.left : null)
      : x >= 0 && x < GUTTER && item.left?.type === "del" ? item.left
      : x >= right && x < right + GUTTER ? item.right : null;
    if (!cell) return;
    this.openDraft({ path: item.path, side: cell === item.right ? "R" : "L", line: cell.number, code: cell.text.trim().slice(0, 200) }, cx);
  }

  // The bin at the right of a card's head deletes it; anywhere else edits it.
  clickCard(item, x, cx) {
    const end = this.span(item.place).right - 7;
    if (item.part === "head" && x >= end - CARD.icon - 2 && x <= end + 2) return this.deleteComment(item.comment.id, cx);
    this.openDraft(item.comment, cx);
  }

  clickDraftButtons(item, x, cx) {
    const save = this.span(item.place).right - 1 - CARD.pad - DRAFT.save, cancel = save - DRAFT.gap - DRAFT.cancel;
    if (x >= save && x <= save + DRAFT.save) return this.saveDraft(cx);
    if (x >= cancel && x <= cancel + DRAFT.cancel) this.cancelDraft(cx);
  }

  // One comment box at a time. One with unsaved text stays, and so does the one
  // already on this line: the click brings it back into view.
  openDraft(target, cx) {
    const d = this.draft;
    const same = d && (target.id ? d.id === target.id : !d.id && d.path === target.path && d.side === target.side && d.line === target.line);
    if (d && (same || this.commentText.trim())) return this.showDraft(cx);
    this.draft = { ...target };
    this.commentText = target.text ?? "";
    this.commentInput.set_value(this.commentText);
    this.showDraft(cx);
  }

  // Its file unfolds, and the list scrolls just enough to show the whole box.
  showDraft(cx) {
    this.openFiles.set(this.draft.path, true);
    this.rebuild();
    const foot = this.keyIndex.get("d:foot");
    if (foot !== undefined) this.scroll.scroll_to_item(foot);
    this.commentInput.focus();
    cx.notify();
  }

  saveDraft(cx) {
    const text = this.commentText.trim(), d = this.draft;
    if (!d || !text || !this.reviewKey) return;
    const comment = { id: d.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, path: d.path, side: d.side, line: d.line, code: d.code, text };
    const list = this.comments;
    this.draft = null;
    this.saveComments(d.id ? list.map((c) => c.id === d.id ? comment : c) : [...list, comment]);
    cx.notify();
  }

  cancelDraft(cx) {
    this.draft = null;
    this.rebuild();
    cx.notify();
  }

  deleteComment(id, cx) {
    if (this.draft?.id === id) this.draft = null;
    this.saveComments(this.comments.filter((c) => c.id !== id));
    cx.notify();
  }

  openSubmit(cx) {
    this.submitting = true; this.sendError = null;
    const on = this.on;
    cx.spawn(async (cx) => {
      try { this.known = (await knownAgents({ on })).filter((a) => a.installed); }
      catch { this.known = []; }
      cx.notify();
    });
    this.noteInput.focus();
    cx.notify();
  }

  closeSubmit(cx) {
    this.submitting = false;
    cx.notify();
  }

  // Where a review can go: the agents running in this space (not one waiting on
  // a question: the review would land in its answer), or a new one in its own tab.
  targets() {
    const running = agents().filter((a) => a.space === this.space).map((a) => {
      const tab = /^\d+$/.test(a.tab_name) ? `tab ${a.tab_name}` : a.tab_name, blocked = a.status === "blocked";
      return { key: a.address, address: a.address, label: `${a.program?.name ?? a.app ?? "Agent"} · ${tab}`, program: a.program, status: a.status, enabled: !blocked, hint: blocked ? "needs an answer first" : "" };
    });
    const fresh = this.known.map((a) => ({ key: `new:${a.key}`, run: a.run, label: `New ${a.name}`, program: a, enabled: true, hint: "new tab" }));
    return [...running, ...fresh];
  }

  // Sends the review as one message: pasted into a running agent (`hc send`), or as
  // a new agent tab's first message. Comments clear only once it went out.
  send(target, cx) {
    if (this.sending) return;
    const text = reviewPrompt({ root: this.root, branch: this.branch, note: this.noteInput.value(), comments: this.comments, order: this.order });
    this.sending = true; this.sendError = null;
    cx.spawn(async (cx) => {
      try {
        if (target.address) {
          const r = await hc(["send", target.address, text]);
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc send exited ${r.code}`);
          run("agent.focus", { terminal: target.address });
        } else {
          run("tab.new", { ...(this.space ? { space: this.space } : {}), folder: this.root, argv: target.run, task: text, name: "Review" });
        }
        if (this.comments.length) this.saveComments([]);
        this.submitting = false; this.noteInput.set_value("");
      } catch (e) { this.sendError = `Send failed: ${e?.message ?? e}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  checkbox(state, t) {
    return div().size(BOX).flex_none().rounded(4).border_1().flex().items_center().justify_center()
      .border_color(state === "none" ? t.input : t.accent)
      .when(state !== "none", (e) => e.bg(t.accent).child(svg(icon(state === "all" ? "check" : "minus")).size(11).text_color(t.accent_foreground)));
  }

  statusColor(file, t) {
    return file.status === "A" ? t.ansi2 : file.status === "D" ? t.ansi1 : file.status === "U" ? t.ansi3 : t.ansi4;
  }

  treeRow(row, t) {
    const pad = 6 + row.depth * 18;
    if (row.kind === "dir") {
      const node = row.node, n = node.paths.length;
      return h_flex().id(row.key).h(28).flex_none().pl(pad).pr(10).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleDir(row, cx))
        .child(svg(icon(row.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
        .child(div().id(`c${row.key}`).flex_none().cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.stage(node.paths, node.staged !== "all", cx); }).child(this.checkbox(node.staged, t)))
        .when(!row.root, (e) => e.child(svg(icon("folder")).size(14).flex_none().text_color(t.muted)))
        .child(div().min_w(0).truncate().when(row.root, (e) => e.font_semibold()).child(row.root ? "Changes" : node.name))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(plural(n, "file")));
    }
    const file = row.file;
    return h_flex().id(row.key).h(28).flex_none().pl(pad + 18).pr(10).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.selected === file.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.reveal(file.path, cx))
      .child(div().id(`c${row.key}`).flex_none().cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); this.stage([file.path], file.staged !== "all", cx); }).child(this.checkbox(file.staged, t)))
      .child(svg(icon("file")).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(this.statusColor(file, t)).child(file.name));
  }

  // One half of a line, or the unified view's one column (its `numbers`: old and
  // new). Where it can take a comment, a + shows over its gutter while the
  // pointer is on it (a hover style: rows can't have handlers).
  side(cell, t, marked, commentable, numbers = [cell?.number]) {
    if (!cell) return div().flex_1().min_w(0).h_full().bg(t.raised);
    const color = cell.type === "add" ? t.ansi2 : cell.type === "del" ? t.ansi1 : null;
    return div().flex_1().min_w(0).h_full().relative()
      .child(h_flex().size_full().items_center().when(Boolean(color), (e) => e.bg(color + "2a")).when(marked, (e) => e.bg(t.selected))
        .child(div().w(BAR).h_full().flex_none().when(Boolean(color), (e) => e.bg(color)))
        .children(numbers.map((n) => div().w(NUM).flex_none().pr(6).text_right().text_color(color ?? t.dim).child(n == null ? "" : String(n))))
        .child(div().w(PLUS).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(cell.text)))
      .when(commentable, (e) => e.child(h_flex().absolute().inset_0().items_center().pl(BAR + NUM * numbers.length + 2).opacity(0).hover((s) => s.opacity(1))
        .child(div().size(17).rounded(4).bg(t.accent).flex().items_center().justify_center()
          .child(svg(icon("plus")).size(11).text_color(t.accent_foreground)))));
  }

  // A card or the comment box's row, in the half its line is on (unified: the
  // one column, indented to the code).
  placed(place, content, t) {
    const unified = this.layout === "unified";
    const inner = div().size_full().pl(place === "full" ? CARD.margin : unified ? UGUTTER : GUTTER).pr(CARD.margin).child(content);
    if (place === "full" || unified) return inner;
    const blank = div().flex_1().min_w(0).h_full(), half = div().flex_1().min_w(0).h_full().child(inner);
    return h_flex().size_full()
      .child(place === "L" ? half : blank)
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(place === "R" ? half : blank);
  }

  card(item, t) {
    const c = item.comment, tone = t[item.tone] ?? t.accent;
    if (item.part === "body") {
      return v_flex().size_full().pb(CARD.space).child(v_flex().size_full().px(CARD.pad).py(8).rounded_b(8).border_b(1).border_l(1).border_r(1).border_color(tone + "88").bg(t.surface)
        .children(item.lines.map((line) => div().h(CARD.line).flex_none().truncate().text_color(t.foreground).child(line || " "))));
    }
    const label = c.line == null ? "Whole file" : `${anchorOf(c)}${item.detached ? " · no longer in the diff" : ""}`;
    const tool = (name) => div().size(CARD.icon).flex_none().rounded(5).flex().items_center().justify_center().hover((s) => s.bg(t.hover))
      .child(svg(icon(name)).size(13).text_color(t.muted));
    return v_flex().size_full().pt(CARD.space).child(h_flex().size_full().pl(CARD.pad).pr(6).gap(8).items_center().rounded_t(8).border_t(1).border_l(1).border_r(1)
      .border_color(tone + "88").bg(tone + "1a").text_size(11).cursor_pointer()
      .child(svg(icon("comment")).size(12).flex_none().text_color(tone))
      .child(div().flex_none().text_color(tone).child(label))
      .when(Boolean(item.detached && c.code), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(c.code)))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(2).child(tool("pencil")).child(tool("trash"))));
  }

  draftRow(item, t) {
    const d = this.draft, frame = (el) => el.border_l(1).border_r(1).border_color(t.accent).bg(t.surface);
    if (item.part === "head") {
      const where = d.line == null ? "the whole file" : `line ${d.side}${d.line}`;
      return v_flex().size_full().pt(CARD.space).child(frame(h_flex().size_full().px(CARD.pad).gap(8).items_center().rounded_t(8).border_t(1))
        .child(svg(icon("comment")).size(13).flex_none().text_color(t.accent))
        .child(div().flex_none().font_semibold().child(`${d.id ? "Edit comment" : "Add a comment"} on ${where}`)));
    }
    if (item.part === "body") {
      return frame(div().size_full().px(CARD.pad).pb(4))
        .child(div().size_full().px(10).py(6).rounded(6).border_1().border_color(t.input).bg(t.background).cursor_text()
          .child(Textarea.new(this.commentInput).size_full().text_size(12).text_color(t.foreground)));
    }
    const canSave = Boolean(this.commentText.trim());
    const button = (label, width, solid, enabled) => div().w(width).h(28).flex_none().flex().items_center().justify_center().rounded(7).text_size(12)
      .when(solid, (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!solid, (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(enabled, (e) => e.cursor_pointer()).child(label);
    return v_flex().size_full().pb(CARD.space).child(frame(h_flex().size_full().px(CARD.pad).gap(DRAFT.gap).items_center().rounded_b(8).border_b(1))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Plain text, sent to the agent as written"))
      .child(button("Cancel", DRAFT.cancel, false, true))
      .child(button(d.id ? "Update" : "Comment", DRAFT.save, true, canSave)));
  }

  diffItem(item, t) {
    if (item.kind === "gap") return div().w_full().h(SIZE.gap);
    if (item.kind === "notice") return div().w_full().h(SIZE.notice).px(16).flex().items_center().text_color(t.dim).child(item.text);
    if (item.kind === "hunk") return div().w_full().h(SIZE.hunk).px(16).flex().items_center().bg(t.surface).text_color(t.dim).truncate().child(item.text);
    if (item.kind === "expand") {
      // The whole row expands; the button sits in the line-number gutter.
      return h_flex().w_full().h(SIZE.hunk).items_center().bg(t.surface).cursor_pointer().hover((s) => s.bg(t.hover))
        .child(div().w(this.layout === "unified" ? UGUTTER : GUTTER).h_full().flex_none().flex().items_center().justify_center().bg(t.accent + "22")
          .child(svg(icon(`expand-${item.dir}`)).size(16).text_color(t.accent)))
        .child(div().flex_1().min_w(0).px(10).truncate().text_color(t.dim).child(item.text ?? ""));
    }
    if (item.kind === "card") return div().w_full().h(this.sizes[this.keyIndex.get(item.key)]).child(this.placed(item.place, this.card(item, t), t));
    if (item.kind === "draft") return div().w_full().h(this.sizes[this.keyIndex.get(item.key)]).child(this.placed(item.place, this.draftRow(item, t), t));
    if (item.kind === "line") {
      // The line the comment box is open on is marked, and shows no +.
      const d = this.draft, boxed = (side, cell) => Boolean(d && d.path === item.path && d.line != null && d.side === side && cell?.number === d.line);
      if (this.layout === "unified") {
        const cell = item.right ?? item.left, marked = boxed(item.right ? "R" : "L", cell);
        return h_flex().w_full().h(SIZE.line).child(this.side(cell, t, marked, !marked, [item.left?.number, item.right?.number]));
      }
      const left = item.left?.type === "del", markedL = left && boxed("L", item.left), markedR = boxed("R", item.right);
      return h_flex().w_full().h(SIZE.line)
        .child(this.side(item.left, t, markedL, left && !markedL))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(this.side(item.right, t, markedR, Boolean(item.right) && !markedR));
    }
    const file = this.byPath.get(item.path);
    if (!file) return div().w_full().h(SIZE.header);
    const slash = file.path.lastIndexOf("/"), name = file.path.slice(slash + 1), folder = slash < 0 ? "" : file.path.slice(0, slash + 1);
    const count = this.commentCount.get(file.path) ?? 0;
    const copyAt = this.copyX(file) - NAME_X, copied = this.copied === file.path, viewed = this.viewedNow?.has(file.path) ?? false;
    return h_flex().w_full().h(SIZE.header).pl(HEADER_PAD).pr(HEADER_RIGHT).gap(GAP).items_center().bg(t.chrome).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
      .child(svg(icon(item.open ? "chevron-down" : "chevron-right")).size(CHEVRON).flex_none().text_color(t.dim))
      .child(this.checkbox(file.staged, t))
      .child(svg(icon("file")).size(14).flex_none().text_color(t.muted))
      .child(h_flex().flex_1().min_w(0).h_full().gap(10).items_center().relative()
        .child(div().flex_none().text_color(file.status === "D" ? t.ansi1 : t.accent).child(name))
        .when(Boolean(folder), (e) => e.child(div().min_w(0).truncate().text_color(t.dim).child(folder)))
        .child(div().w(COPY).flex_none())
        // Over the name and path, a layer that shows the copy button while the
        // pointer is on it (a hover style: rows can't have handlers).
        .child(h_flex().absolute().top_0().left_0().h_full().w(copyAt + COPY).pl(copyAt).items_center()
          .when(!copied, (e) => e.opacity(0).hover((s) => s.opacity(1)))
          .child(div().size(COPY).flex_none().rounded(5).flex().items_center().justify_center().hover((s) => s.bg(t.hover))
            .child(svg(icon(copied ? "check" : "copy")).size(13).text_color(copied ? t.ansi2 : t.muted)))))
      .when(file.add > 0, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`−${file.del}`)))
      .when(file.add + file.del > 0, (e) => e.child(this.statBar(file, t)))
      .child(h_flex().w(VIEWED).h(24).flex_none().px(8).gap(6).items_center().rounded(6).border_1()
        .border_color(viewed ? t.accent + "66" : t.border).bg(viewed ? t.accent + "1f" : t.chrome).hover((s) => s.bg(t.hover))
        .child(div().size(14).flex_none().rounded(3).border_1().border_color(viewed ? t.accent : t.input).bg(viewed ? t.accent : t.background).flex().items_center().justify_center()
          .when(viewed, (e) => e.child(svg(icon("check")).size(11).text_color(t.background))))
        .child(div().text_size(12).text_color(viewed ? t.foreground : t.muted).child("Viewed")))
      .child(h_flex().w(COMMENT_ZONE).flex_none().gap(4).items_center().justify_end()
        .when(count > 0, (e) => e.child(div().text_size(11).text_color(t.accent).child(String(count))))
        .child(svg(icon("comment")).size(14).text_color(count ? t.accent : t.dim)));
  }

  // Added and removed lines as a share of five blocks, rounded down; the rest
  // stay neutral.
  statBar(file, t) {
    const total = file.add + file.del, adds = Math.floor(STAT.blocks * file.add / total), dels = Math.floor(STAT.blocks * file.del / total);
    return h_flex().flex_none().gap(STAT.gap).items_center()
      .children(Array.from({ length: STAT.blocks }, (_, i) => div().size(STAT.size).rounded(2)
        .bg(i < adds ? t.ansi2 : i < adds + dels ? t.ansi1 : t.input)));
  }

  button(id, label, kind, enabled, action, t) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .when(kind === "solid", (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(kind === "plain", (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(enabled, (e) => e.cursor_pointer().on_click((_e, cx) => action(cx)))
      .child(label);
  }

  // Above the diff: show or hide the file panel, fold or unfold every file,
  // split or unified lines, the totals, the change before or after, and
  // staging. Stage and Unstage act on currentFile(); their tooltips name it.
  toolbar(t) {
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const file = this.byPath.get(this.currentFile()), name = file?.path.split("/").pop();
    const anyOpen = this.order.some((path) => this.items[this.headerIndex.get(path)]?.open);
    const ready = Boolean(this.root) && !this.busy;
    const tool = (id, iconName, tip, enabled, active, action) => div().id(id).size(28).flex_none().rounded(6).flex().items_center().justify_center()
      .tooltip(tip)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)))
      .child(svg(icon(iconName)).size(16).text_color(active ? t.accent : enabled ? t.muted : t.dim));
    const action = (id, label, tip, enabled, run) => div().id(id).h(28).px(8).flex().flex_none().items_center().rounded(6).text_size(13)
      .text_color(enabled ? t.foreground : t.dim)
      .when(Boolean(tip), (e) => e.tooltip(tip))
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => run(cx)))
      .child(label);
    const divider = () => div().w(1).h(18).flex_none().mx(6).bg(t.border);
    const total = this.files.length, seen = this.viewedNow?.size ?? 0;
    return h_flex().id("octo-git-toolbar").h(40).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .child(tool("octo-git-panel", "panel-left", this.panel ? "Hide files" : "Show files", true, false, (cx) => { this.panel = !this.panel; cx.notify(); }))
      .child(divider())
      .child(tool("octo-git-fold", "chevrons-up-down", anyOpen ? "Collapse all files" : "Expand all files", this.order.length > 0, false, (cx) => this.foldAll(!anyOpen, cx)))
      .child(tool("octo-git-unified", "rows", "Unified view", true, this.layout === "unified", (cx) => this.setLayout("unified", cx)))
      .child(tool("octo-git-split", "columns", "Split view", true, this.layout === "split", (cx) => this.setLayout("split", cx)))
      .child(div().flex_1())
      .when(total > 0, (e) => e.child(h_flex().gap(8).items_center()
        .child(div().w(48).h(4).flex_none().rounded(2).bg(t.input).child(div().h_full().rounded(2).bg(t.accent).w(Math.round((48 * seen) / total))))
        .child(div().text_size(12).text_color(t.muted).child(`${seen} / ${total} viewed`)))
        .child(divider()))
      .child(div().text_size(12).text_color(t.ansi2).child(`+${add.toLocaleString()}`))
      .child(div().ml(6).text_size(12).text_color(t.ansi1).child(`−${del.toLocaleString()}`))
      .child(divider())
      .child(tool("octo-git-prev", "arrow-up", "Previous change", Boolean(this.changeTarget(-1)), false, (cx) => this.stepChange(-1, cx)))
      .child(tool("octo-git-next", "arrow-down", "Next change", Boolean(this.changeTarget(1)), false, (cx) => this.stepChange(1, cx)))
      .child(divider())
      .child(action("octo-git-stage", "Stage", file ? `Stage ${name}` : "", ready && Boolean(file) && file.staged !== "all", (cx) => this.stage([this.currentFile()], true, cx)))
      .child(action("octo-git-unstage", "Unstage", file ? `Unstage ${name}` : "", ready && Boolean(file) && file.staged !== "none", (cx) => this.stage([this.currentFile()], false, cx)))
      .child(divider())
      .child(action("octo-git-stage-all", "Stage All", "Stage every changed file", ready && this.files.some((f) => f.staged !== "all"), (cx) => this.stage(this.files.map((f) => f.path), true, cx)));
  }

  agentIcon(program, t) {
    if (!program?.icon) return div().size(14).flex_none();
    return program.tint ? svg(program.icon).size(14).flex_none().text_color(t.foreground) : image(program.icon).size(14).flex_none();
  }

  // The header's button and the "Finish your review" popover under it. It's a bare
  // Popup with its opening and closing done here: a Popover binds Space and Enter
  // to toggle itself, which closes it while you type the note.
  review(t) {
    const comments = this.comments, files = new Set(comments.map((c) => c.path)).size;
    const targets = this.targets();
    const chosen = targets.find((x) => x.key === this.target && x.enabled) ?? targets.find((x) => x.enabled);
    const trigger = h_flex().id("octo-git-review").h(28).px(10).gap(6).items_center().rounded(7).text_size(12).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground)
      // A press on the button while it's open has already closed it (below).
      .on_mouse_down("left", (_e, cx) => {
        if (Date.now() - this.closedAt < 50) return;
        if (this.submitting) this.closeSubmit(cx); else this.openSubmit(cx);
      })
      .child(svg(icon("comment")).size(13).text_color(t.solid_foreground))
      .child("Submit review")
      .when(comments.length > 0, (e) => e.child(div().px(6).rounded(8).bg(t.background).text_color(t.foreground).text_size(11).child(String(comments.length))));
    const option = (x) => h_flex().id(`octo-git-to-${x.key}`).h(32).flex_none().px(8).gap(9).items_center().rounded(7)
      .when(x === chosen, (e) => e.bg(t.selected))
      .when(x.enabled && !this.sending, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.target = x.key; cx.notify(); }))
      .when(!x.enabled, (e) => e.text_color(t.dim))
      .child(div().size(14).flex_none().rounded(7).border_1().border_color(x === chosen ? t.accent : t.input).flex().items_center().justify_center()
        .when(x === chosen, (e) => e.child(div().size(6).rounded(3).bg(t.accent))))
      .child(this.agentIcon(x.program, t))
      .child(div().flex_1().min_w(0).truncate().child(x.label))
      .when(Boolean(x.status), (e) => e.child(div().size(7).flex_none().rounded(4).bg(t[x.status] ?? t.idle)))
      .when(Boolean(x.hint), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(x.hint)));
    const panel = v_flex().id("octo-git-review-panel").w(460).p(14).gap(10).bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_lg().text_size(13).text_color(t.foreground)
      .on_mouse_down_out((_e, cx) => { this.closedAt = Date.now(); this.closeSubmit(cx); })
      .on_key_down((e, cx) => { if (e.key === "escape") this.closeSubmit(cx); })
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().font_semibold().child("Finish your review"))
        .child(div().id("octo-git-review-close").size(24).rounded(6).flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.closeSubmit(cx)).child(svg(icon("x")).size(14).text_color(t.muted))))
      .child(div().text_size(12).text_color(t.muted).child(comments.length
        ? `${plural(comments.length, "comment")} on ${plural(files, "file")} go with it.`
        : "No comments: the agent reviews all uncommitted changes itself."))
      .child(div().id("octo-git-note").h(96).px(10).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).cursor_text()
        .child(Textarea.new(this.noteInput).size_full().text_size(13).text_color(t.foreground)))
      .child(div().text_size(11).text_color(t.dim).child("Send to"))
      .child(v_flex().id("octo-git-targets").max_h(230).gap(2).overflow_y_scrollbar()
        .children(targets.map(option))
        .when(!targets.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("Looking for agents…"))))
      .when(Boolean(this.sendError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.sendError)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child(this.sending ? "Sending…" : ""))
        .child(this.button("octo-git-send-cancel", "Cancel", "plain", true, (cx) => this.closeSubmit(cx), t))
        .child(this.button("octo-git-send", "Submit review", "solid", Boolean(chosen) && !this.sending, (cx) => this.send(chosen, cx), t)));
    return Popup.new("octo-git-review-popup", trigger).anchor("top_right")
      .when(this.submitting, (e) => e.content(panel));
  }

  render(cx) {
    if (this.launcher) return div();
    if (this.asButton) return this.renderButton();
    const t = theme();
    const staged = this.files.filter((f) => f.staged !== "none").length;
    const canCommit = Boolean(this.message.trim() && staged && this.root && !this.busy);
    const empty = this.error || (this.loading && !this.root ? "Loading changes…" : this.files.length ? null : "No uncommitted changes");

    const header = h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Git"))
      .when(Boolean(this.root), (e) => e.child(this.branches.trigger(t)))
      .child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(plural(this.files.length, "file")))
      .child(div().flex_1())
      .when(!this.comments.length && this.files.length > 0, (e) => e.child(div().ml(6).text_size(12).text_color(t.dim).child("Hover a line and click + to comment")))
      .child(this.review(t));

    const commitBox = v_flex().size_full().min_h(0).p(10).gap(8)
      .child(div().id("octo-git-message").flex_1().min_h(0).px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .child(Textarea.new(this.textarea).size_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(8).items_center()
        .child(div().id("octo-git-commit").h(30).px(14).flex().flex_none().items_center().rounded(8).text_size(12)
          .bg(canCommit ? t.solid : t.raised).text_color(canCommit ? t.solid_foreground : t.dim)
          .when(canCommit, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
          .child(this.busy ? "Working…" : "Commit"))
        .child(div().id("octo-git-commit-push").h(30).px(12).flex().flex_none().items_center().rounded(8).text_size(12).border_1().border_color(t.border)
          .text_color(canCommit ? t.foreground : t.dim)
          .when(canCommit, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click((_e, cx) => this.commit(cx, true))
          .child("Commit and Push…"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(`${staged} staged`)))
      .when(Boolean(this.note), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.note)))
      .when(Boolean(this.done), (e) => e.child(div().text_size(11).text_color(t.dim).truncate().child(this.done)));

    const noMatch = !empty && Boolean(this.query.trim()) && !this.tree.paths.length;
    const filter = h_flex().id("octo-git-filter").h(32).flex_none().mx(6).mt(6).px(10).gap(8).items_center().rounded(8).border_1()
      .border_color(this.filtering ? t.accent : t.input).bg(t.background).cursor_text()
      .on_click(() => this.filterInput.focus())
      .child(svg(icon("search")).size(14).flex_none().text_color(t.dim))
      .child(Input.new(this.filterInput).flex_1().min_w(0).text_size(13).text_color(t.foreground))
      .when(Boolean(this.query), (e) => e.child(div().id("octo-git-filter-clear").size(20).flex_none().rounded(5).flex().items_center().justify_center()
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filterInput.set_value(""); this.setQuery("", cx); })
        .child(svg(icon("x")).size(12).text_color(t.muted))));

    // Both dividers drag; the window keeps their sizes under these ids. The tree's
    // rows are built only while the panel shows.
    const left = () => v_resizable("octo-git-commit-split").size_full()
      .child(resizable_panel().child(v_flex().size_full().min_h(0)
        .child(filter)
        .child(v_flex().id("octo-git-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
          .when(!empty && !noMatch, (e) => e.children(this.treeRows.map((row) => this.treeRow(row, t))))
          .when(Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty)))
          .when(noMatch, (e) => e.child(div().p(8).text_color(t.dim).child("No files match")))
          .when(Boolean(this.limited), (e) => e.child(div().p(8).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_FILES.toLocaleString()} changed files`))))))
      .child(resizable_panel().size(150).size_range(110, 480).child(commitBox));

    const items = this.items, sizes = this.sizes;
    const diff = div().id("octo-git-diff-area").flex_1().min_h(0).w_full().relative()
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      // Comment rows wrap to this width, so a new width rebuilds them.
      .on_size_change((size, cx) => { this.diffHeight = size.height; if (Math.abs(size.width - this.diffWidth) >= 1) { this.diffWidth = size.width; this.rebuild(); cx.notify(); } })
      .on_mouse_down("left", (e) => { this.downX = e.local_position?.x ?? null; })
      // A hover style inside a virtual-list row doesn't redraw the window when the
      // pointer enters or leaves it, so the + would wait for some other redraw.
      // Redrawing on every move over the diff shows it at once.
      .on_mouse_move((_e, cx) => cx.notify())
      .on_hover((_hovered, cx) => cx.notify())
      .child(v_virtual_list("octo-git-diff", items.length, items.length ? sizes : SIZE.line, (i) => items[i].key,
        (range) => {
          // What's on screen, for the toolbar's current file.
          this.top = range.start; this.bottom = range.end;
          return items.slice(range.start, range.end).map((item) => this.diffItem(item, t));
        })
        .track_scroll(this.scroll).on_item_click((key, cx) => this.clickDiff(key, cx)).size_full())
      .child(Scrollbar.vertical("octo-git-diff").viewport_from_layout().absolute().inset_0());
    const right = v_flex().size_full().min_w(0).bg(t.background).child(this.toolbar(t)).child(diff);

    const bar = this.branches.bar(t);
    return v_flex().id("octo-git").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size) => { this.size = size; })
      .child(this.branches.layer(t, this.size))
      .child(header)
      .when(Boolean(bar), (e) => e.child(bar))
      .when(this.panel, (e) => e.child(h_resizable("octo-git-split").flex_1().min_h(0)
        .child(resizable_panel().size(360).size_range(240, 720).child(left()))
        .child(resizable_panel().child(right))))
      .when(!this.panel, (e) => e.child(div().flex_1().min_h(0).child(right)));
  }
}
