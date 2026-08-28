import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : markdownFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function withoutFencedCode(markdown) {
  return markdown.replace(/^```[\s\S]*?^```/gm, "");
}

function headingSlug(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchors(markdown) {
  const seen = new Map();
  const values = new Set();
  for (const match of withoutFencedCode(markdown).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = headingSlug(match[1] ?? "");
    if (!base) continue;
    const duplicateIndex = seen.get(base) ?? 0;
    seen.set(base, duplicateIndex + 1);
    values.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
  }
  return values;
}

function localLinks(markdown) {
  const links = [];
  for (const match of withoutFencedCode(markdown).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let destination = (match[1] ?? "").trim();
    if (destination.startsWith("<") && destination.includes(">")) {
      destination = destination.slice(1, destination.indexOf(">"));
    } else {
      destination = destination.split(/\s+['"]/u, 1)[0] ?? destination;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(destination)) continue;
    links.push(destination);
  }
  return links;
}

const failures = [];
const files = markdownFiles(repositoryRoot);
const anchorCache = new Map();

for (const sourceFile of files) {
  const markdown = readFileSync(sourceFile, "utf8");
  for (const destination of localLinks(markdown)) {
    const [rawPath = "", rawAnchor] = destination.split("#", 2);
    let decodedPath;
    let decodedAnchor;
    try {
      decodedPath = decodeURIComponent(rawPath);
      decodedAnchor =
        rawAnchor === undefined ? undefined : decodeURIComponent(rawAnchor).toLowerCase();
    } catch {
      failures.push(
        `${relative(repositoryRoot, sourceFile)}: invalid URL encoding in ${destination}`,
      );
      continue;
    }

    const target = decodedPath ? resolve(dirname(sourceFile), decodedPath) : sourceFile;
    const relativeTarget = relative(repositoryRoot, target);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
      failures.push(
        `${relative(repositoryRoot, sourceFile)}: link escapes repository: ${destination}`,
      );
      continue;
    }
    if (!existsSync(target)) {
      failures.push(`${relative(repositoryRoot, sourceFile)}: missing target: ${destination}`);
      continue;
    }
    if (!decodedAnchor) continue;
    if (!statSync(target).isFile() || !target.endsWith(".md")) {
      failures.push(
        `${relative(repositoryRoot, sourceFile)}: anchor target is not Markdown: ${destination}`,
      );
      continue;
    }

    let targetAnchors = anchorCache.get(target);
    if (!targetAnchors) {
      targetAnchors = anchors(readFileSync(target, "utf8"));
      anchorCache.set(target, targetAnchors);
    }
    if (!targetAnchors.has(decodedAnchor)) {
      failures.push(`${relative(repositoryRoot, sourceFile)}: missing anchor: ${destination}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation link failures:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation links: ${files.length} Markdown files checked`);
}
