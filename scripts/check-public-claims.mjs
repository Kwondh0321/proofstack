import { readdir, readFile } from "node:fs/promises";

const guidePaths = (await readdir(new URL("../docs/guides/", import.meta.url), { recursive: true }))
  .filter((path) => path.endsWith(".md"))
  .map((path) => `docs/guides/${path}`)
  .sort();
const surfacePaths = [
  "README.md",
  "README.ko.md",
  "apps/web/app/page.tsx",
  "apps/web/app/comparisons/page.tsx",
  "apps/web/app/comparisons/[resultId]/page.tsx",
  "apps/web/components/shell.tsx",
  "docs/product/constitution.md",
  "docs/product/roadmap.md",
  "packages/contracts/src/openapi.ts",
  ...guidePaths,
];

const surfaces = new Map(
  await Promise.all(
    surfacePaths.map(async (path) => [
      path,
      await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
    ]),
  ),
);

const prohibitedClaims = [
  {
    label: "causal trace claim",
    pattern: /causal (?:trace|timeline)/iu,
  },
  {
    label: "automated release-blocking claim",
    pattern: /block the release when/iu,
  },
  {
    label: "stale incomplete operator-view claim",
    pattern: /operator view remain(?:s)? incomplete/iu,
  },
  {
    label: "stale missing comparison-console claim",
    pattern: /baseline\/candidate operator comparison/iu,
  },
  {
    label: "Korean causal trace claim",
    pattern: /인과 관계가 보존된 트레이스/u,
  },
  {
    label: "Korean automated release-blocking claim",
    pattern: /출시를\s*차단하는 과정/u,
  },
];

const requiredBoundaries = [
  {
    label: "English experimental status",
    path: "README.md",
    pattern: /experimental foundation, not a production release/u,
  },
  {
    label: "English non-enforcement boundary",
    path: "README.md",
    pattern: /It does not\s+block a release/u,
  },
  {
    label: "Korean non-enforcement boundary",
    path: "README.ko.md",
    pattern: /이\s+흐름은 release를 차단하지 않습니다/u,
  },
  {
    label: "descriptive-only console status",
    path: "apps/web/app/page.tsx",
    pattern: /value: "Descriptive only"/u,
  },
  {
    label: "unapproved production status",
    path: "apps/web/app/page.tsx",
    pattern: /value: "Not approved"/u,
  },
  {
    label: "comparison decision disclaimer",
    path: "apps/web/app/comparisons/[resultId]/page.tsx",
    pattern: /descriptive evidence, not an approval decision/u,
  },
  {
    label: "development build marker",
    path: "apps/web/components/shell.tsx",
    pattern: /Development build · incomplete/u,
  },
  {
    label: "ordered trace contract wording",
    path: "packages/contracts/src/openapi.ts",
    pattern: /summary: "Read an ordered trace"/u,
  },
];

const failures = [];
for (const [path, source] of surfaces) {
  for (const claim of prohibitedClaims) {
    if (claim.pattern.test(source)) failures.push(`${path}: prohibited ${claim.label}`);
  }
}
for (const boundary of requiredBoundaries) {
  const source = surfaces.get(boundary.path);
  if (!source || !boundary.pattern.test(source)) {
    failures.push(`${boundary.path}: missing ${boundary.label}`);
  }
}

if (failures.length > 0) {
  console.error("Public claim verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${surfacePaths.length} public surfaces against ${prohibitedClaims.length} prohibited claims and ${requiredBoundaries.length} required boundaries.`,
  );
}
