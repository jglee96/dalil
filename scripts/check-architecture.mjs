#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function walk(dirPath) {
  const out = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.normalize(candidate);
    }
  }
  return null;
}

function classify(filePath) {
  const rel = toPosix(path.relative(srcRoot, filePath));
  if (rel === "main.ts") {
    return { scope: "main", rel };
  }
  if (rel.startsWith("shared/")) {
    return { scope: "shared", rel };
  }
  if (rel.startsWith("infrastructure/")) {
    return { scope: "infrastructure", rel };
  }
  if (rel.startsWith("features/")) {
    const parts = rel.split("/");
    const feature = parts[1] ?? "";
    let layer = "root";
    if (parts[2] === "application") {
      layer = "application";
    } else if (parts[2] === "interface") {
      layer = "interface";
    }
    return { scope: "feature", feature, layer, rel };
  }
  return { scope: "other", rel };
}

function parseSpecifiers(fileContent) {
  const specs = [];
  const re = /^\s*(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["'];?/gm;
  let match = re.exec(fileContent);
  while (match) {
    specs.push(match[1]);
    match = re.exec(fileContent);
  }
  return specs;
}

const files = walk(srcRoot).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
const violations = [];

for (const sourceFile of files) {
  const sourceText = fs.readFileSync(sourceFile, "utf8");
  const sourceClass = classify(sourceFile);
  const specs = parseSpecifiers(sourceText);

  for (const spec of specs) {
    if (!spec.startsWith(".")) {
      continue;
    }

    const targetFile = resolveRelativeImport(sourceFile, spec);
    if (!targetFile) {
      violations.push({
        source: sourceClass.rel,
        spec,
        reason: "Relative import could not be resolved",
      });
      continue;
    }

    if (!targetFile.startsWith(srcRoot)) {
      continue;
    }

    const targetClass = classify(targetFile);

    if (sourceClass.scope === "shared" && targetClass.scope !== "shared") {
      violations.push({
        source: sourceClass.rel,
        spec,
        reason: `shared layer cannot import ${targetClass.scope} layer`,
      });
      continue;
    }

    if (sourceClass.scope === "infrastructure" && (targetClass.scope === "feature" || targetClass.scope === "main")) {
      violations.push({
        source: sourceClass.rel,
        spec,
        reason: `infrastructure layer cannot import ${targetClass.scope} layer`,
      });
      continue;
    }

    if (sourceClass.scope === "feature" && sourceClass.layer === "application" && targetClass.scope === "feature" && targetClass.layer === "interface") {
      violations.push({
        source: sourceClass.rel,
        spec,
        reason: "feature application layer cannot import feature interface layer",
      });
      continue;
    }

    if (sourceClass.scope === "feature" && targetClass.scope === "feature" && sourceClass.feature !== targetClass.feature) {
      const expected = `features/${targetClass.feature}/index.ts`;
      if (targetClass.rel !== expected) {
        violations.push({
          source: sourceClass.rel,
          spec,
          reason: `cross-feature imports must use public API (${expected})`,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture import checks failed:\n");
  for (const item of violations) {
    console.error(`- ${item.source} -> ${item.spec}`);
    console.error(`  ${item.reason}`);
  }
  process.exit(1);
}

console.log(`Architecture import checks passed (${files.length} files).`);
