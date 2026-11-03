// Review comments: how they read inline in the diff and the message an agent gets.
// A comment: { id, path, side: "R" | "L" | null, line: number | null, code: string | null, text }.
// R<n> is line n of the working-tree file, L<n> line n of HEAD; no line = the whole file.

export const anchorOf = (comment) => comment.line == null ? null : `${comment.side}${comment.line}`;

// Display lines of at most `cols` characters, broken at spaces where possible.
export function wrapText(text, cols) {
  const out = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (let word of paragraph.split(" ")) {
      while (word.length > cols) {
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, cols)); word = word.slice(cols);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const DEFAULT_NOTE = "Address each comment below: change the code where a change is asked for, and answer questions in your reply. Change only what the comments ask for.";
const DEFAULT_REVIEW = "Review these changes yourself: report bugs, risks and anything unclear, most important first. Don't change any code yet.";

const quote = (code) => {
  const tick = code.includes("`") ? "``" : "`";
  return `${tick}${tick.length > 1 ? " " : ""}${code}${tick.length > 1 ? " " : ""}${tick}`;
};

// Files in the order the diff shows them (`order`), the whole-file comments first,
// then by line. Without comments it asks the agent to review the changes itself.
export function reviewPrompt({ root, branch, note, comments, order }) {
  const intro = `Code review of the uncommitted changes in ${root}${branch ? ` (branch ${branch})` : ""}.`;
  if (!comments.length) {
    return [intro, "", note.trim() || DEFAULT_REVIEW, "", "See them with `git status` and `git diff HEAD` in that folder."].join("\n");
  }
  const rank = new Map(order.map((path, i) => [path, i]));
  const paths = [...new Set(comments.map((c) => c.path))]
    .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b));
  const out = [
    intro,
    "",
    note.trim() || DEFAULT_NOTE,
    "",
    "Each comment starts with its file's full path. `<path>:<n>` is line n of the file as it is now; \"removed line n of HEAD\" is a line these changes deleted (`git show HEAD:<file>` has it).",
  ];
  const base = root.replace(/\/+$/, "");
  for (const path of paths) {
    out.push("", `## ${path}`);
    const full = `${base}/${path}`;
    const mine = comments.filter((c) => c.path === path)
      .sort((a, b) => (a.line ?? -1) - (b.line ?? -1));
    for (const c of mine) {
      const where = c.line == null ? `${full} (whole file)`
        : c.side === "L" ? `${full}, removed line ${c.line} of HEAD: ${quote(c.code ?? "")}`
        : `${full}:${c.line}: ${quote(c.code ?? "")}`;
      out.push("", `- ${where}`);
      for (const line of c.text.trim().split("\n")) out.push(`  ${line}`);
    }
  }
  return out.join("\n");
}

// A short fingerprint of a file's changes. A "Viewed" mark holds the one the
// file had then, so a file that changes again counts as not viewed.
export function fingerprint(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) | 0;
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}

// The paths of `files` ({ path, sig }) whose mark in `marks` ({ path: sig }) still matches.
export const viewedPaths = (marks, files) => new Set(files.filter((f) => marks?.[f.path] === f.sig).map((f) => f.path));
