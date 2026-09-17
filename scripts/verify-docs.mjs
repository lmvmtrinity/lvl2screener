import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Check repository Markdown navigation, including archives, without relying on
// ignored workstation-local documents. External URLs are deliberately not fetched.
const root = process.cwd();
const files = new Set(
  execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.resolve(root, file))),
);
const markdown = [...files].filter(
  (file) =>
    file.endsWith(".md") &&
    (file.startsWith("docs/") || ["README.md", "AGENTS.md"].includes(file)),
);
const withoutFences = (text) =>
  text.replace(/^(`{3,}|~{3,}).*\r?\n[\s\S]*?^\1\s*$/gm, "");
const anchors = new Map();
function headingAnchors(file) {
  if (anchors.has(file)) return anchors.get(file);
  const result = new Set();
  const counts = new Map();
  const source = withoutFences(readFileSync(file, "utf8"));
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of source.matchAll(
    /<(?:a|h[1-6])\b[^>]*(?:id|name)=["']([^"']+)["']/g,
  ))
    result.add(match[1]);
  anchors.set(file, result);
  return result;
}

let checked = 0;
const errors = [];
for (const file of markdown) {
  const source = withoutFences(readFileSync(file, "utf8"));
  // Current docs use inline links; also cover standard reference definitions.
  const targets = [
    ...[
      ...source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g),
    ].map((m) => m[1]),
    ...[...source.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map(
      (m) => m[1],
    ),
  ];
  for (const raw of targets) {
    const target = raw.replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(target)) continue;
    checked++;
    const [pathname, fragment] = target.split("#");
    const absolute = pathname
      ? path.resolve(
          path.dirname(path.resolve(file)),
          decodeURIComponent(pathname),
        )
      : path.resolve(file);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!existsSync(absolute)) {
      errors.push(`${file}: missing ${target}`);
    } else if (statSync(absolute).isDirectory()) {
      if (![...files].some((entry) => entry.startsWith(`${relative}/`)))
        errors.push(`${file}: directory absent from checkout ${target}`);
    } else if (!files.has(relative)) {
      errors.push(`${file}: target ignored or outside checkout ${target}`);
    } else if (
      fragment &&
      absolute.endsWith(".md") &&
      !headingAnchors(absolute).has(decodeURIComponent(fragment))
    ) {
      errors.push(`${file}: missing heading ${target}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Documentation navigation passed: ${markdown.length} Markdown files, ${checked} local links (paths and Markdown heading anchors).`,
  );
}
