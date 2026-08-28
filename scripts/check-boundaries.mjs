import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const modules = [
  {
    allowed: new Set(),
    directory: "packages/contracts/src",
    packageName: "@proofstack/contracts",
  },
  {
    allowed: new Set(["@proofstack/contracts"]),
    directory: "packages/core/src",
    packageName: "@proofstack/core",
  },
  {
    allowed: new Set(["@proofstack/contracts"]),
    directory: "sdks/typescript/src",
    packageName: "@proofstack/sdk",
  },
  {
    allowed: new Set(["@proofstack/contracts", "@proofstack/core"]),
    directory: "packages/postgres/src",
    packageName: "@proofstack/postgres",
  },
  {
    allowed: new Set(["@proofstack/contracts", "@proofstack/core"]),
    directory: "apps/api/src",
    packageName: "@proofstack/api",
  },
  {
    allowed: new Set(["@proofstack/contracts"]),
    directory: "apps/web",
    packageName: "@proofstack/web",
  },
  {
    allowed: new Set(["@proofstack/sdk"]),
    directory: "examples/basic-agent/src",
    packageName: "@proofstack/example-basic-agent",
  },
];

const internalPackages = new Set(modules.map((module) => module.packageName));

function sourceFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function packageNameFor(specifier) {
  if (!specifier.startsWith("@proofstack/")) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
}

function importedSpecifiers(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

const violations = [];
let checkedFileCount = 0;

for (const module of modules) {
  const directory = resolve(repositoryRoot, module.directory);
  for (const file of sourceFiles(directory)) {
    checkedFileCount += 1;
    for (const specifier of importedSpecifiers(file)) {
      const importedPackage = packageNameFor(specifier);
      if (!importedPackage || !internalPackages.has(importedPackage)) continue;
      if (importedPackage === module.packageName || module.allowed.has(importedPackage)) continue;

      violations.push(
        `${relative(repositoryRoot, file)}: ${module.packageName} cannot import ${specifier}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture boundaries: ${checkedFileCount} source files checked`);
}
