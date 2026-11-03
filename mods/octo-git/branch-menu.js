// The branch menu: the header's branch button, the menu under it (actions, then
// Recent / Local / Remote / Tags, a submenu per branch), the small dialogs its
// actions ask with, and the bar shown while a merge or rebase is stopped.
// The view (`host`) owns the repo: root, on, branch, busy, files, refresh().
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup } from "gpui-base";
import { exec, notify, run, shared, setShared } from "herdr";
import { REF_FORMAT, COMMIT_FORMAT, parseRefs, recentBranches, menuRows, branchActions, updateStep, blockedFiles, gitError, worktreeFolder, pushTarget, parseCommit, parseNameStatus } from "./branches.js";
import { buildTree, flattenTree } from "./tree.js";

// As in main.js: reads write nothing under .git, so the folder watch stays quiet.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
// Writes never wait on a password or an editor: nobody is there to answer, and
// exec would sit until its 30 s limit.
const QUIET = ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "GIT_SEQUENCE_EDITOR=true", "GIT_MERGE_AUTOEDIT=no"];
const MENU_W = 480, SUB_W = 360, ROW = 28, SEP = 9, LIST_H = 520;
// "merge" or "rebase", once "Don't show again" was ticked for a repo.
const UPDATE_KEY = (root) => `octo-git.update.${root}`;
const icon = (name) => `mods/octo-git/${name}.svg`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A git write that failed, described for a toast: the files in the way, the
// conflict it stopped on, or git's own words.
class GitFailure extends Error {
  constructor(r) {
    const out = `${r.stdout}\n${r.stderr}`, files = blockedFiles(out);
    super(files.length
      ? `Your changes to these files would be overwritten:\n${files.slice(0, 8).join("\n")}${files.length > 8 ? `\n…and ${files.length - 8} more` : ""}`
      : gitError(r.stderr || r.stdout) || `git exited with ${r.code}`);
    this.conflict = /^CONFLICT/m.test(out);
  }
}

export class BranchMenu {
  constructor(host, cx) {
    this.host = host;
    this.open = false; this.closedAt = 0;
    this.refs = { local: [], remote: [], tags: [] }; this.remotes = []; this.recent = [];
    this.toggled = new Set(); this.query = ""; this.highlight = null;
    // The open submenu: { ref, y } (y: px from the menu's top), and the entry the
    // keyboard is on in it (null when the mouse opened it).
    this.sub = null; this.subIndex = null;
    this.fetching = false; this.fetchNote = null;
    this.dialog = null; this.pendingAsk = null; this.rowTop = null; this.menuTop = null; this.triggerBottom = null;
    this.search = InputState.new({ placeholder: "Search branches and actions" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.highlight = null; this.sub = null; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.enter(cx));
    this.field = InputState.new({});
    this.field.on("submit", (_e, cx) => this.confirm(cx));
    // The dialogs check the name as it's typed.
    this.field.on("change", (_e, cx) => cx.notify());
    this.focus = cx.focus_handle();
  }

  read(args) { return exec("git", [...READ, ...args], { cwd: this.host.root, on: this.host.on }); }
  write(args) { return exec("env", [...QUIET, "git", ...args], { cwd: this.host.root, on: this.host.on }); }

  // One write; a failure throws with what went wrong. An autostash that came
  // back with conflicts still succeeds, so it's noted for the end.
  async git(args) {
    const r = await this.write(args);
    if (/autostash resulted in conflicts/i.test(`${r.stdout}\n${r.stderr}`)) this.stashClash = true;
    if (r.code !== 0) throw new GitFailure(r);
    return r;
  }

  current() { return this.refs.local.find((r) => r.current) ?? null; }
  taken(name) { return this.refs.local.some((r) => r.name === name); }

  toggle(cx) {
    if (this.open) return this.close(cx);
    if (!this.host.root) return;
    this.open = true; this.sub = null; this.subIndex = null; this.highlight = null; this.fetchNote = null;
    this.query = ""; this.search.set_value(""); this.search.focus();
    this.loadRefs(cx);
    this.fetch(cx, true);
    cx.notify();
  }

  close(cx) {
    this.open = false; this.sub = null; this.subIndex = null;
    cx.notify();
  }

  loadRefs(cx) {
    if (!this.host.root) return;
    cx.spawn(async (cx) => {
      try { await this.readRefs(); }
      catch (e) { this.fetchNote = `Couldn't read branches: ${e?.message ?? e}`; }
      cx.notify();
    });
  }

  async readRefs() {
    const [refs, remotes, reflog] = await Promise.all([
      this.read(["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"]),
      this.read(["remote"]),
      this.read(["reflog", "--format=%gs", "-n", "500"]),
    ]);
    if (refs.code !== 0) throw new Error(gitError(refs.stderr));
    this.refs = parseRefs(refs.stdout);
    this.remotes = remotes.stdout.split("\n").filter(Boolean);
    const current = this.current()?.name ?? "";
    this.recent = recentBranches(reflog.code === 0 ? reflog.stdout : "", { local: this.refs.local.map((r) => r.name), current });
    if (this.sub) this.sub.ref = this.find(this.sub.ref) ?? this.sub.ref;
  }

  // Commit and Push: the push dialog for the checked-out branch, once its refs are read.
  pushCurrent(cx) {
    cx.spawn(async (cx) => {
      try { await this.readRefs(); }
      catch (e) { return notify({ title: "Couldn't read branches", body: String(e?.message ?? e), level: "error" }); }
      const ref = this.current();
      if (ref) this.openPush(ref, cx); else notify({ title: "Not on a branch", body: "Check out a branch to push it.", level: "info" });
    });
  }

  find(ref) { return [...this.refs.local, ...this.refs.remote, ...this.refs.tags].find((r) => r.kind === ref.kind && r.name === ref.name); }

  // Quietly on opening, or from the button. Only refs change, so the tab isn't busy.
  fetch(cx, quiet) {
    if (this.fetching) return;
    this.fetching = true; this.fetchNote = null;
    cx.spawn(async (cx) => {
      try {
        const r = await this.write(["fetch", "--all", "--prune"]);
        if (r.code !== 0) throw new GitFailure(r);
        if (!quiet) notify({ title: "Fetched", level: "success", timeout: 2000 });
      } catch (e) {
        if (quiet) this.fetchNote = `Fetch failed: ${String(e?.message ?? e).split("\n")[0]}`;
        else notify({ title: "Fetch failed", body: String(e?.message ?? e), level: "error" });
      } finally { this.fetching = false; this.loadRefs(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Runs `work` with the tab busy and the menu closed. Failures become a toast;
  // `after` runs once it succeeded and the tab is free again.
  perform(label, work, cx, after = null) {
    if (this.host.busy || !this.host.root) return;
    this.host.busy = true; this.open = false; this.sub = null; this.stashClash = false;
    cx.spawn(async (cx) => {
      let ok = false;
      try { const done = await work(cx); ok = true; if (done) notify({ title: done, level: "success", timeout: 2500 }); }
      catch (e) {
        if (e?.conflict) notify({ title: `${label} stopped on conflicts`, body: "Resolve the conflicted files and stage them, then press Continue in the bar under the header. Abort puts everything back.", level: "warning" });
        else notify({ title: `${label} failed`, body: String(e?.message ?? e), level: "error" });
      } finally {
        if (this.stashClash) notify({ title: "Your uncommitted changes clash", body: "Putting them back left conflict markers in some files. A copy is kept: see git stash list.", level: "warning" });
        this.host.busy = false; this.host.refresh(cx); this.loadRefs(cx); cx.notify();
      }
      if (ok && after) after(cx);
    });
    cx.notify();
  }

  // ── What each entry does ──────────────────────────────────────────────────

  act(id, ref, cx, alt = false) {
    const current = this.current(), here = this.host.branch;
    switch (id) {
      case "commit": this.close(cx); this.host.panel = true; this.host.textarea.focus(); return;
      case "update-project": return current ? this.update(current.name, cx, alt) : notify({ title: "Not on a branch", body: "Check out a branch to update it.", level: "info" });
      case "push": return (ref ?? current) ? this.openPush(ref ?? current, cx) : notify({ title: "Not on a branch", level: "info" });
      case "new-branch": return this.ask({ kind: "new-branch", from: here || "HEAD", label: here || "HEAD", checkout: true, overwrite: false }, "", cx);
      case "checkout-revision": return this.ask({ kind: "revision" }, "", cx);
      case "new-from": return this.ask({ kind: "new-branch", from: ref.kind === "tag" ? `refs/tags/${ref.name}` : ref.name, label: ref.name, checkout: true, overwrite: false }, ref.kind === "remote" ? ref.short : ref.name, cx);
      case "checkout": return this.perform("Checkout", async () => { await this.checkout(ref); return `Switched to ${ref.kind === "remote" ? ref.short : ref.name}`; }, cx);
      case "checkout-rebase": return this.perform("Rebase", async () => {
        await this.checkout(ref);
        await this.git(["rebase", "--autostash", here]);
        return `Rebased ${ref.kind === "remote" ? ref.short : ref.name} onto ${here}`;
      }, cx);
      case "checkout-update": return this.perform("Checkout", async () => { await this.checkout(ref); }, cx, (cx) => this.update(ref.name, cx, false));
      case "rebase-onto": return this.perform("Rebase", async () => { await this.git(["rebase", "--autostash", ref.name]); return `Rebased ${here} onto ${ref.name}`; }, cx);
      case "merge-into": return this.perform("Merge", async () => {
        await this.git(["merge", "--no-edit", "--autostash", ref.kind === "tag" ? `refs/tags/${ref.name}` : ref.name]);
        return `Merged ${ref.name} into ${here}`;
      }, cx);
      case "worktree": return this.ask({ kind: "worktree", ref, openTab: true }, worktreeFolder(this.host.root, ref.kind === "remote" ? ref.short : ref.name), cx);
      case "update": return ref.current ? this.update(ref.name, cx, alt) : this.updateOther(ref, cx);
      case "rename": return this.ask({ kind: "rename", ref }, ref.name, cx);
      case "delete": return this.remove(ref, cx);
    }
  }

  async checkout(ref) {
    if (ref.kind === "local") return this.git(["switch", ref.name]);
    if (ref.kind === "tag") return this.git(["switch", "--detach", `refs/tags/${ref.name}`]);
    // A remote branch: its local namesake if there is one, else a new one that follows it.
    if (this.refs.local.some((r) => r.name === ref.short)) return this.git(["switch", ref.short]);
    return this.git(["switch", "--track", ref.name]);
  }

  // Update for the checked-out branch: fetch its remote, then catch up, or ask
  // how (merge or rebase) when both sides have commits. ⌥ asks even after
  // "Don't show again".
  update(name, cx, alt) {
    this.perform("Update", async () => {
      const load = async () => {
        const r = await this.read(["for-each-ref", `--format=${REF_FORMAT}`, `refs/heads/${name}`]);
        const ref = parseRefs(r.stdout).local[0];
        if (!ref) throw new Error(`No branch ${name}`);
        return ref;
      };
      let ref = await load();
      if (ref.upstream && !ref.gone) {
        const remote = this.remotes.find((r) => ref.upstream.startsWith(`${r}/`)) ?? ref.upstream.split("/")[0];
        await this.git(["fetch", "--prune", remote]);
        ref = await load();
      }
      switch (updateStep(ref)) {
        case "no-upstream": notify({ title: `${name} doesn't follow a remote branch`, body: "Push it once to set one.", level: "info" }); return null;
        case "gone": notify({ title: `${ref.upstream} no longer exists`, body: "It was deleted on the remote.", level: "info" }); return null;
        case "up-to-date": return "Already up to date";
        case "fast-forward": await this.git(["merge", "--ff-only", "--autostash", "@{u}"]); return `Updated ${name}: ${plural(ref.behind, "new commit")}`;
      }
      const remembered = shared(UPDATE_KEY(this.host.root));
      if ((remembered === "merge" || remembered === "rebase") && !alt) return this.integrate(remembered, ref);
      // Asking needs the tab free: the dialog's OK starts its own task.
      this.pendingAsk = { kind: "update", ref, choice: "merge", remember: false };
      return null;
    }, cx, (cx) => {
      if (!this.pendingAsk) return;
      const d = this.pendingAsk; this.pendingAsk = null;
      this.ask(d, null, cx);
    });
  }

  async integrate(how, ref) {
    await this.git(how === "rebase" ? ["rebase", "--autostash", "@{u}"] : ["merge", "--no-edit", "--autostash", "@{u}"]);
    return `Updated ${ref.name} (${how === "rebase" ? "rebased" : "merged"} ${plural(ref.behind, "commit")})`;
  }

  // Update for a branch that isn't checked out: only a fast-forward, done by
  // fetching straight into it.
  updateOther(ref, cx) {
    if (!ref.upstream || ref.gone) return notify({ title: ref.gone ? `${ref.upstream} no longer exists` : `${ref.name} doesn't follow a remote branch`, level: "info" });
    const remote = this.remotes.find((r) => ref.upstream.startsWith(`${r}/`)) ?? ref.upstream.split("/")[0];
    const branch = ref.upstream.slice(remote.length + 1);
    this.perform("Update", async () => {
      try { await this.git(["fetch", remote, `${branch}:${ref.name}`]); }
      catch (e) { if (/non-fast-forward|rejected/.test(e.message)) throw new Error(`${ref.name} has commits of its own: check it out to update it with a merge or rebase.`); throw e; }
      return `Updated ${ref.name}`;
    }, cx);
  }

  openPush(ref, cx) {
    const target = pushTarget(ref, this.remotes);
    if (!target) return notify({ title: "No remote to push to", body: "Add one with git remote add.", level: "info" });
    // Commits are counted against the branch Push goes to, which may not be the
    // upstream (a renamed branch keeps its old one) and may not exist yet.
    const isNew = !this.refs.remote.some((r) => r.name === `${target.remote}/${target.branch}`), tracked = !isNew;
    this.ask({ kind: "push", ref, target, isNew, tracked, force: false, tags: false, tagMode: "all", menu: null, commits: null, total: 0, selected: null, info: {}, collapsed: new Set() }, null, cx);
    cx.spawn(async (cx) => {
      const range = tracked ? [`${target.remote}/${target.branch}..${ref.name}`] : [ref.name, "--not", "--remotes"];
      const [log, count] = await Promise.all([
        this.read(["log", "--format=%h%x00%s", "-n", "50", ...range, "--"]),
        this.read(["rev-list", "--count", ...range, "--"]),
      ]);
      if (this.dialog?.kind !== "push") return;
      this.dialog.commits = log.stdout.split("\n").filter(Boolean).map((line) => { const [hash, subject] = line.split("\0"); return { hash, subject }; });
      this.dialog.total = Number(count.stdout.trim()) || 0;
      if (this.dialog.commits.length) this.pickCommit(this.dialog.commits[0].hash, cx);
      cx.notify();
    });
  }

  // The push dialog's selected commit; its files and message are read once.
  pickCommit(hash, cx) {
    const d = this.dialog;
    if (d?.kind !== "push") return;
    d.selected = hash; d.collapsed = new Set();
    cx.notify();
    if (d.info[hash]) return;
    d.info[hash] = { loading: true };
    cx.spawn(async (cx) => {
      const [show, files] = await Promise.all([
        this.read(["show", "--no-patch", `--format=${COMMIT_FORMAT}`, "--date=format-local:%d.%m.%y at %H:%M", hash, "--"]),
        this.read(["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "--no-renames", "-z", hash, "--"]),
      ]);
      d.info[hash] = { ...parseCommit(show.stdout), files: parseNameStatus(files.stdout) };
      cx.notify();
    });
  }

  remove(ref, cx) {
    if (ref.kind === "remote") {
      return this.ask({ kind: "confirm", title: `Delete ${ref.name} on the server?`, body: `This removes the branch from ${ref.remote} for everyone who uses it.`, button: "Delete",
        run: (cx) => this.perform("Delete", async () => { await this.git(["push", ref.remote, "--delete", ref.short]); return `Deleted ${ref.name}`; }, cx) }, null, cx);
    }
    if (ref.kind === "tag") return this.ask({ kind: "delete-tag", ref, remote: false }, null, cx);
    this.perform("Delete", async () => {
      const r = await this.write(["branch", "-d", ref.name]);
      if (r.code === 0) return `Deleted ${ref.name}`;
      if (!/not fully merged/.test(r.stderr)) throw new GitFailure(r);
      const count = await this.read(["rev-list", "--count", `HEAD..${ref.name}`, "--"]);
      this.pendingAsk = { kind: "delete-unmerged", ref, count: Number(count.stdout.trim()) || 0 };
      return null;
    }, cx, (cx) => {
      if (!this.pendingAsk) return;
      const d = this.pendingAsk; this.pendingAsk = null;
      this.ask(d, null, cx);
    });
  }

  // ── Dialogs ───────────────────────────────────────────────────────────────

  // Opens a dialog over the Git tab. `value` fills its text field (null: none).
  ask(dialog, value, cx) {
    this.open = false; this.sub = null;
    this.dialog = { ...dialog, error: null };
    if (value !== null) { this.field.set_value(value); this.field.set_selected_range({ start: 0, end: value.length }); this.field.focus(); }
    else this.focus.focus();
    cx.notify();
  }

  dismiss(cx) {
    this.dialog = null;
    cx.notify();
  }

  // The open dialog, centered over the whole view. It's a
  // Popup (window.open_dialog draws nothing for a mod), pinned under a
  // zero-height trigger at the view's top-left and as big as the view (`size`).
  layer(t, size) {
    this.viewSize = size;
    const trigger = div().id("octo-git-dialog-anchor").w_full().h(0);
    return Popup.new("octo-git-dialog-popup", trigger).anchor("top_left")
      .when(Boolean(this.dialog && size), (e) => e.content(div().id("octo-git-dialog-backdrop").w(size.width).h(size.height).flex().items_center().justify_center()
        .child(this.dialogPanel(t).bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_lg()
          .on_mouse_down_out((_e, cx) => this.dismiss(cx)))));
  }

  // The dialog's main button (and Enter in its field).
  confirm(cx) {
    const d = this.dialog;
    if (!d) return;
    const value = this.field.value().trim(), go = (label, work, after) => { this.dismiss(cx); this.perform(label, work, cx, after); };
    // Typed text goes to git as an argument: a leading "-" would be read as an option ("-f" is --force).
    if (value.startsWith("-")) return;
    switch (d.kind) {
      case "new-branch":
        if (!value || (this.taken(value) && !d.overwrite)) return;
        return go("New branch", async () => {
          await this.git(d.checkout ? ["switch", "--no-track", d.overwrite ? "-C" : "-c", value, d.from] : ["branch", "--no-track", ...(d.overwrite ? ["-f"] : []), value, d.from]);
          return d.checkout ? `Switched to new branch ${value}` : `Created ${value}`;
        });
      case "revision":
        if (!value) return;
        return go("Checkout", async () => { await this.git(["switch", "--detach", value]); return `Checked out ${value}`; });
      case "rename":
        if (!value || value === d.ref.name || this.taken(value)) return;
        return go("Rename", async () => { await this.git(["branch", "-m", d.ref.name, value]); return `Renamed to ${value}`; });
      case "worktree": {
        if (!value) return;
        const ref = d.ref, local = ref.kind === "remote" ? ref.short : ref.name;
        const args = ref.kind === "remote" && !this.refs.local.some((r) => r.name === local)
          ? ["worktree", "add", "--track", "-b", local, value, ref.name]
          : ["worktree", "add", value, local];
        return go("New worktree", async () => {
          await this.git(args);
          if (d.openTab) run("tab.new", { ...(this.host.space ? { space: this.host.space } : {}), folder: value });
          return `Worktree for ${local} at ${value}`;
        });
      }
      case "update": {
        if (d.remember) setShared(UPDATE_KEY(this.host.root), d.choice);
        return go("Update", () => this.integrate(d.choice, d.ref));
      }
      case "push": {
        const { ref, target } = d;
        if (d.commits === null || (d.tracked && !d.total && !d.force && !d.tags)) return;
        const tags = d.tags ? [d.tagMode === "all" ? "--tags" : "--follow-tags"] : [];
        return go(d.force ? "Force push" : "Push", async () => {
          await this.git(["push", ...(d.force ? ["--force-with-lease"] : []), ...tags, "-u", target.remote, `refs/heads/${ref.name}:refs/heads/${target.branch}`]);
          return `Pushed ${d.total ? plural(d.total, "commit") : ref.name} to ${target.remote}/${target.branch}`;
        });
      }
      case "delete-unmerged":
        return go("Delete", async () => { await this.git(["branch", "-D", d.ref.name]); return `Deleted ${d.ref.name}`; });
      case "delete-tag": {
        const remote = this.remotes.includes("origin") ? "origin" : this.remotes[0];
        return go("Delete", async () => {
          await this.git(["tag", "-d", d.ref.name]);
          if (d.remote && remote) await this.git(["push", remote, "--delete", `refs/tags/${d.ref.name}`]);
          return `Deleted tag ${d.ref.name}${d.remote && remote ? ` here and on ${remote}` : ""}`;
        });
      }
      case "confirm": { const action = d.run; this.dismiss(cx); return action(cx); }
    }
  }

  dialogPanel(t) {
    const d = this.dialog;
    if (!d) return div();
    const field = () => div().id("octo-git-branch-field").h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
      .child(Input.new(this.field).flex_1().min_w(0).text_size(13).text_color(t.foreground));
    const box = (id, on, label, flip) => h_flex().id(id).gap(8).items_center().cursor_pointer().on_click((_e, cx) => { flip(); cx.notify(); })
      .child(div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).flex().items_center().justify_center()
        .when(on, (e) => e.child(svg(icon("check")).size(11).text_color(t.background))))
      .child(div().text_color(t.muted).child(label));
    const radio = (id, on, label, pick) => h_flex().id(id).gap(10).items_center().cursor_pointer().on_click((_e, cx) => { pick(); cx.notify(); })
      .child(div().size(14).flex_none().rounded(7).border_1().border_color(on ? t.accent : t.input).flex().items_center().justify_center()
        .when(on, (e) => e.child(div().size(6).rounded(3).bg(t.accent))))
      .child(div().child(label));
    const button = (id, label, kind, enabled, action) => div().id(id).h(30).px(14).flex().flex_none().items_center().rounded(8).text_size(13)
      .when(kind === "solid", (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(kind === "plain", (e) => e.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(kind === "danger", (e) => e.border_1().border_color(t.ansi1 + "66").text_color(t.ansi1).hover((s) => s.bg(t.ansi1 + "1f")))
      .when(enabled, (e) => e.cursor_pointer().on_click((_e, cx) => action(cx)))
      .child(label);
    const cancel = button("octo-git-dialog-cancel", "Cancel", "plain", true, (cx) => this.dismiss(cx));
    const ok = (label, enabled = true, kind = "solid") => button("octo-git-dialog-ok", label, kind, enabled, (cx) => this.confirm(cx));
    const foot = (...children) => h_flex().gap(8).items_center().pt(6).child(div().flex_1()).children(children);
    const note = (text) => div().text_size(12).text_color(t.muted).child(text);
    // "Branch Name:" beside the field, and the checkboxes lined up under the field.
    const LABEL = 92, named = (label) => h_flex().gap(10).items_center().child(div().w(LABEL).flex_none().text_color(t.muted).child(label)).child(field().flex_1());
    const value = this.field.value().trim();
    const clash = Boolean(value) && ((d.kind === "new-branch" && !d.overwrite) || (d.kind === "rename" && value !== d.ref.name)) && this.taken(value);
    const dash = value.startsWith("-");
    const taken = (clash || dash) && div().pl(LABEL + 10).text_size(12).text_color(t.ansi1).child(dash ? "It can't start with “-”." : `Branch '${value}' already exists.`);

    let title = "", body = [];
    switch (d.kind) {
      case "new-branch":
        title = `Create Branch from ${d.label}`;
        body = [
          named("Branch Name:"), taken,
          h_flex().pl(LABEL + 10).gap(18).items_center()
            .child(box("octo-git-dialog-checkout", d.checkout, "Checkout branch", () => { d.checkout = !d.checkout; }))
            .child(box("octo-git-dialog-overwrite", d.overwrite, "Overwrite existing branch", () => { d.overwrite = !d.overwrite; })),
          foot(cancel, ok("Create", Boolean(value) && !clash && !dash)),
        ];
        break;
      case "revision":
        title = "Checkout Tag or Revision";
        body = [note("A tag, a commit hash or any revision git understands. You'll be on no branch afterwards."), field(), dash && note("It can't start with “-”."), foot(cancel, ok("Checkout", Boolean(value) && !dash))];
        break;
      case "rename":
        title = `Rename Branch ${d.ref.name}`;
        body = [named("Branch Name:"), taken, foot(cancel, ok("Rename", Boolean(value) && value !== d.ref.name && !clash && !dash))];
        break;
      case "worktree":
        title = `New Worktree from '${d.ref.name}'`;
        body = [note("Folder"), field(), dash && note("It can't start with “-”."), box("octo-git-dialog-tab", d.openTab, "Open it in a new tab", () => { d.openTab = !d.openTab; }), foot(cancel, ok("Create", Boolean(value) && !dash))];
        break;
      case "update":
        title = "Update Project";
        body = [
          note(`${d.ref.name} has ${plural(d.ref.ahead, "commit")} of yours and ${plural(d.ref.behind, "new commit")} on ${d.ref.upstream}.`),
          radio("octo-git-dialog-merge", d.choice === "merge", "Merge incoming changes into the current branch", () => { d.choice = "merge"; }),
          radio("octo-git-dialog-rebase", d.choice === "rebase", "Rebase the current branch on top of incoming changes", () => { d.choice = "rebase"; }),
          h_flex().gap(8).items_center().pt(6)
            .child(box("octo-git-dialog-remember", d.remember, "Don't show again", () => { d.remember = !d.remember; }))
            .child(div().flex_1())
            .child(button("octo-git-dialog-reset", "Reset to the Remote Branch", "danger", true, (cx) => this.ask({
              kind: "confirm", title: `Reset ${d.ref.name} to ${d.ref.upstream}?`,
              body: `Your ${plural(d.ref.ahead, "commit")} on ${d.ref.name} that ${d.ref.ahead === 1 ? "isn't" : "aren't"} on ${d.ref.upstream} will be dropped from the branch. Uncommitted changes are kept; if they'd be overwritten, nothing happens.`,
              button: "Reset", run: (cx) => this.perform("Reset", async () => { await this.git(["reset", "--keep", "@{u}"]); return `${d.ref.name} now matches ${d.ref.upstream}`; }, cx),
            }, null, cx)))
            .child(cancel).child(ok("OK")),
        ];
        break;
      case "push":
        title = `Push Commits to ${this.host.root.split("/").pop()}`;
        body = this.pushBody(d, t, { box, cancel, note });
        break;
      case "delete-unmerged":
        title = `Delete '${d.ref.name}'?`;
        body = [note(`It has ${plural(d.count, "commit")} that ${d.count === 1 ? "isn't" : "aren't"} in ${this.host.branch || "HEAD"} or on any remote branch it follows. Deleting loses ${d.count === 1 ? "it" : "them"} unless ${d.count === 1 ? "it's" : "they're"} pushed somewhere.`), foot(cancel, ok("Delete anyway", true, "danger"))];
        break;
      case "delete-tag":
        title = `Delete tag '${d.ref.name}'?`;
        body = [
          box("octo-git-dialog-remote", d.remote, "Also delete it on origin (affects everyone)", () => { d.remote = !d.remote; }),
          note(d.remote ? "" : "Deleted only here: if origin has it, the next fetch brings it back."),
          foot(cancel, ok("Delete", true, "danger")),
        ];
        break;
      case "confirm":
        title = d.title;
        body = [note(d.body), foot(cancel, ok(d.button, true, "danger"))];
        break;
    }
    const view = this.viewSize ?? { width: 1000, height: 640 }, wide = d.kind === "push";
    return v_flex().id("octo-git-dialog").track_focus(this.focus).text_size(13).text_color(t.foreground).p(16).gap(12)
      .w(wide ? Math.max(520, Math.min(view.width - 80, 1000)) : d.kind === "update" ? 620 : 460)
      .when(wide, (e) => e.h(Math.max(320, Math.min(view.height - 100, 560))))
      .on_key_down((e, cx) => { if (e.key === "escape") this.dismiss(cx); })
      .child(div().font_semibold().child(title))
      .children(body.filter(Boolean));
  }

  // Left: where the branch goes and the commits going with it. Right: the
  // selected commit's files as a tree, then its message, hash, author and date.
  // Below: push tags (all, or those on the branch's commits), and Push with
  // Force Push under its ▾.
  pushBody(d, t, { box, cancel, note }) {
    const accent = (text) => div().text_color(t.accent).child(text);
    const head = h_flex().h(26).flex_none().gap(6).items_center()
      .child(div().child(d.ref.name)).child(div().text_color(t.muted).child("→"))
      .child(accent(d.target.remote)).child(div().text_color(t.muted).child(":")).child(accent(d.target.branch))
      .when(d.isNew, (e) => e.child(div().px(6).rounded(4).bg(t.ansi2 + "26").text_color(t.ansi2).text_size(11).child("New")));
    const commits = d.commits === null ? [note("Looking for commits…")]
      : !d.commits.length ? [note(d.tracked ? "Nothing to push." : `No new commits: pushing creates ${d.target.branch} on ${d.target.remote}.`)]
      : d.commits.map((c) => h_flex().id(`octo-git-push-${c.hash}`).h(26).flex_none().pl(20).pr(8).items_center().rounded(6).cursor_pointer()
        .bg(c.hash === d.selected ? t.selected : t.popover).hover((s) => s.bg(c.hash === d.selected ? t.selected : t.hover))
        .on_click((_e, cx) => this.pickCommit(c.hash, cx))
        .child(div().flex_1().min_w(0).truncate().child(c.subject)));
    if (d.total > (d.commits?.length ?? 0)) commits.push(div().pl(20).child(note(`…and ${d.total - d.commits.length} older`)));
    const left = v_flex().w_1_2().flex_none().h_full().min_h(0).pr(12).border_r(1).border_color(t.border)
      .child(head)
      .child(v_flex().id("octo-git-push-commits").flex_1().min_h(0).overflow_y_scrollbar().children(commits));

    const info = d.selected ? d.info[d.selected] : null;
    let right;
    if (!info) right = div().flex_1().flex().items_center().justify_center().text_color(t.dim).child(d.selected ? "Loading…" : "No commits selected");
    else if (info.loading) right = div().flex_1().flex().items_center().justify_center().text_color(t.dim).child("Loading…");
    else {
      const tree = buildTree(info.files.map((f) => ({ ...f, staged: "none" }))), rows = flattenTree(tree, d.collapsed);
      const color = (s) => s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : t.ansi4;
      const fileRow = (row) => {
        const pad = 4 + row.depth * 18;
        if (row.kind === "dir") {
          return h_flex().id(`octo-git-push-${row.key}`).h(24).flex_none().pl(pad).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { if (d.collapsed.has(row.node.path)) d.collapsed.delete(row.node.path); else d.collapsed.add(row.node.path); cx.notify(); })
            .child(svg(icon(row.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
            .child(svg(icon("folder")).size(14).flex_none().text_color(t.muted))
            .child(div().min_w(0).truncate().child(row.root ? this.host.root.split("/").pop() : row.node.name))
            .child(div().flex_none().text_size(12).text_color(t.dim).child(plural(row.node.paths.length, "file")));
        }
        return h_flex().id(`octo-git-push-${row.key}`).h(24).flex_none().pl(pad + 18).gap(6).items_center()
          .child(svg(icon("file")).size(14).flex_none().text_color(t.muted))
          .child(div().min_w(0).truncate().text_color(color(row.file.status)).child(row.file.name));
      };
      right = v_flex().flex_1().min_h(0)
        .child(v_flex().id("octo-git-push-files").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(rows.map(fileRow)))
        .child(v_flex().id("octo-git-push-message").flex_none().max_h(200).overflow_y_scrollbar().pt(12).gap(4).border_t(1).border_color(t.border)
          .child(div().font_semibold().child(info.subject))
          .when(Boolean(info.body), (e) => e.children(info.body.split("\n").map((line) => div().text_color(t.muted).child(line || " "))))
          .child(div().pt(6).text_color(t.muted).child(`${info.short}  ${info.author}`))
          .child(h_flex().gap(4).text_color(t.muted).child(accent(`<${info.email}>`)).child(`on ${info.date}`)));
    }

    // The two small menus: which tags go along, and Force Push.
    const menu = (id, items) => v_flex().id(id).absolute().bottom(34).p(4).w(170).bg(t.popover).border_1().border_color(t.border).rounded(8).shadow_lg()
      .children(items.map(([key, label, pick]) => h_flex().id(`${id}-${key}`).h(26).px(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { d.menu = null; pick(cx); cx.notify(); }).child(label)));
    const tagLabel = d.tagMode === "all" ? "All" : "Current Branch";
    const tagSelect = div().relative()
      .child(h_flex().id("octo-git-push-tag-mode").h(28).w(150).px(10).gap(6).items_center().rounded(7).border_1().border_color(t.border)
        .text_color(d.tags ? t.foreground : t.dim)
        .when(d.tags, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { d.menu = d.menu === "tags" ? null : "tags"; cx.notify(); }))
        .child(div().flex_1().child(tagLabel)).child(svg(icon("chevron-down")).size(12).text_color(t.muted)))
      .when(d.menu === "tags", (e) => e.child(menu("octo-git-push-tag-menu", [
        ["all", "All", () => { d.tagMode = "all"; }],
        ["current", "Current Branch", () => { d.tagMode = "current"; }],
      ]).left(0)));
    const ready = d.commits !== null, canPush = ready && (!d.tracked || d.total > 0 || d.tags);
    const push = div().relative()
      .child(h_flex().h(30).flex_none().items_center().rounded(8).bg(canPush ? t.solid : t.raised).text_color(canPush ? t.solid_foreground : t.dim).text_size(13)
        .child(div().id("octo-git-dialog-ok").h_full().px(14).flex().items_center().when(canPush, (e) => e.cursor_pointer().on_click((_e, cx) => { d.force = false; this.confirm(cx); })).child("Push"))
        .child(div().w(1).h(16).bg(canPush ? t.solid_foreground + "40" : t.border))
        .child(div().id("octo-git-push-more").h_full().px(8).flex().items_center().when(ready, (e) => e.cursor_pointer().on_click((_e, cx) => { d.menu = d.menu === "push" ? null : "push"; cx.notify(); }))
          .child(svg(icon("chevron-down")).size(12).text_color(canPush ? t.solid_foreground : t.dim))))
      .when(d.menu === "push", (e) => e.child(menu("octo-git-push-menu", [
        ["force", "Force Push", (cx) => { d.force = true; this.confirm(cx); }],
      ]).right(0)));
    return [
      h_flex().flex_1().min_h(0).gap(12).child(left).child(right),
      h_flex().gap(10).items_center().pt(4)
        .child(box("octo-git-push-tags", d.tags, "Push tags:", () => { d.tags = !d.tags; if (!d.tags && d.menu === "tags") d.menu = null; }))
        .child(tagSelect)
        .child(div().flex_1())
        .child(cancel)
        .child(push),
    ];
  }

  // ── The menu ──────────────────────────────────────────────────────────────

  // Keyboard: ↑/↓ move, Enter runs (or opens a branch's submenu), Esc steps back.
  move(by, cx) {
    if (this.sub && this.subIndex !== null) {
      const n = branchActions(this.sub.ref, this.host.branch).filter(Boolean).length;
      this.subIndex = (this.subIndex + by + n) % n;
      return cx.notify();
    }
    const rows = this.selectable();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === this.highlight);
    this.highlight = rows[at < 0 ? (by > 0 ? 0 : rows.length - 1) : (at + by + rows.length) % rows.length].key;
    this.sub = null;
    cx.notify();
  }

  selectable() { return (this.rows ?? []).filter((r) => r.kind !== "sep" && r.kind !== "note"); }

  enter(cx) {
    if (this.sub && this.subIndex !== null) {
      const entry = branchActions(this.sub.ref, this.host.branch).filter(Boolean)[this.subIndex];
      return entry && this.act(entry.id, this.sub.ref, cx);
    }
    const rows = this.selectable(), row = rows.find((r) => r.key === this.highlight) ?? (this.query.trim() ? rows[0] : null);
    if (!row) return;
    this.highlight = row.key;
    if (row.kind === "branch") { this.sub = { ref: row.ref, key: row.key, y: this.rowY(row) }; this.subIndex = 0; return cx.notify(); }
    this.pick(row, false, cx);
  }

  // Where a row sits in the list when the keyboard opens its submenu (the list's
  // scroll isn't known, so this assumes it's at the top).
  rowY(row) {
    let y = 44 + (this.fetchNote ? 20 : 0);
    for (const r of this.rows) { if (r === row) break; y += r.kind === "sep" ? SEP : ROW; }
    return y;
  }

  pick(row, alt, cx) {
    if (row.kind === "action") return this.act(row.id, null, cx, alt);
    if (row.kind === "section" || row.kind === "folder") {
      if (this.toggled.has(row.key)) this.toggled.delete(row.key); else this.toggled.add(row.key);
      return cx.notify();
    }
  }

  trigger(t) {
    const label = this.host.busy ? "Working…" : this.host.branch || this.host.head || "HEAD";
    const button = h_flex().id("octo-git-branch").h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .bg(this.open ? t.selected : t.raised).hover((s) => s.bg(t.hover)).text_color(t.foreground)
      // A press on the button while it's open has already closed it (below).
      .on_mouse_down("left", (e, cx) => {
        if (e.bounds) this.triggerBottom = e.bounds.y + e.bounds.height;
        if (Date.now() - this.closedAt < 50) return;
        this.toggle(cx);
      })
      .child(svg(icon(this.host.branch ? "branch" : "tag")).size(14).text_color(t.muted))
      .child(div().child(label))
      .child(svg(icon("chevron-down")).size(12).text_color(t.muted));
    return Popup.new("octo-git-branch-popup", button).anchor("top_left")
      .when(this.open, (e) => e.content(this.content(t)));
  }

  content(t) {
    this.rows = menuRows({ refs: this.refs, recent: this.recent, query: this.query, toggled: this.toggled });
    const remembered = shared(UPDATE_KEY(this.host.root));
    const row = (r) => {
      const base = h_flex().id(`octo-git-br-${r.key}`).h(ROW).flex_none().pr(8).gap(8).items_center().rounded(6).pl(8 + (r.depth ?? 0) * 18)
        .when(r.key === this.highlight || r.key === this.sub?.key, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover)).cursor_pointer();
      switch (r.kind) {
        case "sep": return div().h(1).flex_none().mx(6).my(4).bg(t.border);
        case "note": return div().h(ROW).flex_none().px(8).flex().items_center().text_size(12).text_color(t.dim).child(r.label);
        case "action":
          return base.on_click((e, cx) => this.pick(r, e.modifiers?.alt, cx))
            .child(div().size(16).flex_none().when(Boolean(r.icon), (e) => e.child(svg(icon(r.icon)).size(16).text_color(t.muted))))
            .child(div().flex_1().child(r.label))
            .when(r.id === "update-project" && (remembered === "merge" || remembered === "rebase"), (e) => e.child(div().text_size(12).text_color(t.dim).tooltip("⌥-click to choose again").child(remembered)));
        case "section":
        case "folder":
          return base.on_click((_e, cx) => this.pick(r, false, cx))
            .child(svg(icon(r.open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
            .when(r.kind === "folder", (e) => e.child(svg(icon("folder")).size(14).flex_none().text_color(t.muted)))
            .child(div().text_color(t.muted).child(r.label));
        case "branch": {
          const ref = r.ref;
          return base
            .on_mouse_down("left", (e) => { this.rowTop = e.bounds?.y ?? null; })
            .on_click((_e, cx) => { this.highlight = r.key; this.sub = { ref, key: r.key, y: this.rowTop !== null && this.menuTop !== null ? this.rowTop - this.menuTop : this.rowY(r) }; this.subIndex = null; cx.notify(); })
            .child(svg(icon(ref.current ? "tag" : ref.kind === "tag" ? "tag" : "branch")).size(14).flex_none().text_color(ref.current ? t.ansi3 : t.muted))
            .child(div().flex_none().max_w(260).truncate().child(r.label))
            .when(ref.behind > 0, (e) => e.child(div().flex_none().text_size(12).text_color(t.accent).child(`↓${ref.behind}`)))
            .when(ref.ahead > 0, (e) => e.child(div().flex_none().text_size(12).text_color(t.ansi2).child(`↑${ref.ahead}`)))
            .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(ref.gone ? t.ansi1 : t.dim).child(ref.upstream ? (ref.gone ? `${ref.upstream} (gone)` : ref.upstream) : ""))
            .child(svg(icon("chevron-right")).size(12).flex_none().text_color(t.dim));
        }
      }
    };
    const menu = v_flex().id("octo-git-branch-menu").w(MENU_W).p(6).gap(0).bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_lg().text_size(13).text_color(t.foreground)
      .on_mouse_down("left", (e) => { this.menuTop = e.bounds?.y ?? null; })
      .child(h_flex().gap(6).items_center().pb(6)
        .child(h_flex().id("octo-git-branch-search").flex_1().h(32).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
          .on_click(() => this.search.focus())
          .child(svg(icon("search")).size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().min_w(0).text_size(13).text_color(t.foreground)))
        .child(div().id("octo-git-branch-fetch").size(32).flex_none().rounded(8).flex().items_center().justify_center()
          .tooltip(this.fetching ? "Fetching…" : "Fetch").cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.fetch(cx, false))
          .child(svg(icon("fetch")).size(16).text_color(this.fetching ? t.accent : t.muted))))
      .when(Boolean(this.fetchNote), (e) => e.child(div().h(20).px(8).text_size(11).text_color(t.dim).truncate().child(this.fetchNote)))
      .child(v_flex().id("octo-git-branch-list").max_h(LIST_H).overflow_y_scrollbar().children(this.rows.map(row))
        .when(!this.rows.length, (e) => e.child(div().px(8).py(6).text_color(t.dim).child("Nothing matches"))));

    const sub = this.sub && this.submenu(t);
    return h_flex().id("octo-git-branch-layer").items_start().gap(4)
      .on_mouse_down_out((_e, cx) => { this.closedAt = Date.now(); this.close(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "up") return this.move(-1, cx);
        if (e.key === "down") return this.move(1, cx);
        if (e.key === "escape") { if (this.sub) { this.sub = null; this.subIndex = null; return cx.notify(); } return this.close(cx); }
      })
      .child(menu)
      .when(Boolean(sub), (e) => e.child(sub));
  }

  submenu(t) {
    const ref = this.sub.ref, entries = branchActions(ref, this.host.branch);
    const height = 14 + entries.reduce((h, a) => h + (a ? ROW : SEP), 0);
    // Beside its row, moved up only as far as it takes to stay in the window.
    const room = this.triggerBottom === null ? Infinity : window.viewport_size().height - this.triggerBottom - 12;
    const y = Math.max(0, Math.min(this.sub.y - 6, room - height));
    let n = -1;
    return v_flex().id("octo-git-branch-sub").mt(y).w(SUB_W).p(6).bg(t.popover).border_1().border_color(t.border).rounded(10).shadow_lg().text_size(13).text_color(t.foreground)
      .children(entries.map((a, i) => {
        if (!a) return div().h(1).flex_none().mx(6).my(4).bg(t.border);
        const index = ++n;
        return h_flex().id(`octo-git-br-sub-${i}`).h(ROW).flex_none().px(10).items_center().rounded(6).cursor_pointer()
          .when(index === this.subIndex, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .text_color(a.id === "delete" ? t.ansi1 : t.foreground)
          .on_click((e, cx) => this.act(a.id, ref, cx, e.modifiers?.alt))
          .child(div().truncate().child(a.label));
      }));
  }

  // ── A stopped merge or rebase ─────────────────────────────────────────────

  bar(t) {
    const kind = this.host.progress;
    if (!kind) return null;
    const conflicts = this.host.files.filter((f) => f.status === "U").length, name = kind === "rebase" ? "Rebase" : "Merge";
    const action = (id, label, solid, enabled, args) => div().id(id).h(26).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .when(solid, (e) => e.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!solid, (e) => e.border_1().border_color(t.ansi3 + "66").text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(enabled && !this.host.busy, (e) => e.cursor_pointer().on_click((_e, cx) => this.perform(label === "Abort" ? `${name} abort` : name, async () => {
        await this.git(args);
        return label === "Abort" ? `${name} aborted` : `${name} continued`;
      }, cx)))
      .child(label);
    return h_flex().id("octo-git-progress").h(40).flex_none().px(14).gap(10).items_center().bg(t.ansi3 + "22").border_b(1).border_color(t.border)
      .child(div().flex_1().text_color(t.ansi3).child(conflicts ? `${name} stopped: ${plural(conflicts, "file")} ${conflicts === 1 ? "has" : "have"} conflicts. Fix them, stage each one, then Continue.` : `${name} stopped. Everything is resolved: Continue to finish it.`))
      .child(action("octo-git-progress-abort", "Abort", false, true, [kind, "--abort"]))
      .child(action("octo-git-progress-continue", "Continue", true, conflicts === 0, [kind, "--continue"]));
  }
}
