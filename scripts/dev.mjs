// Copies mods/octo-git and the octo-git layout into Herdr's folder; with --watch,
// again after every change. The repo is the one place to edit: Herdr reloads the
// copy it runs (it doesn't notice edits through a symlink), and that copy is
// overwritten.
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const from = new URL("../mods/octo-git/", import.meta.url).pathname;
const to = join(home, "mods", "octo-git") + "/";
const layouts = new URL("../layouts/", import.meta.url).pathname;

// Herdr writes its own type files into the mod's folder; they're left alone.
// Herdr's layouts folder holds every other layout too, so nothing is deleted there.
const sync = () => {
  execFileSync("rsync", ["-a", "--delete", "--exclude", "gpui-kit.d.ts", "--exclude", "herdr.d.ts", "--exclude", "jsconfig.json", "--exclude", ".*", from, to]);
  execFileSync("rsync", ["-a", "--exclude", ".*", layouts, join(home, "layouts") + "/"]);
  console.log(`${new Date().toLocaleTimeString()} copied to ${to} and ${join(home, "layouts")}/`);
};

sync();
if (process.argv.includes("--watch")) {
  let timer = null;
  for (const dir of [from, layouts]) watch(dir, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(sync, 150); });
  console.log("Watching mods/octo-git and layouts for changes (Ctrl-C to stop).");
}
