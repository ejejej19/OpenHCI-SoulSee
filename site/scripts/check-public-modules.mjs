import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(siteRoot, "public");
const entryNames = ["ghost-app.js", "ghost-edit-app.js"];
const importPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
const visited = new Set();

async function checkModule(modulePath) {
  const resolvedPath = path.resolve(modulePath);
  const relativePath = path.relative(publicRoot, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Module import escapes public/: ${resolvedPath}`);
  }

  await access(resolvedPath);
  if (visited.has(resolvedPath)) return;
  visited.add(resolvedPath);

  const source = await readFile(resolvedPath, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2];
    const dependencyPath = path.resolve(path.dirname(resolvedPath), specifier);
    await checkModule(dependencyPath);
  }
}

for (const entryName of entryNames) {
  await checkModule(path.join(publicRoot, entryName));
}
console.log(`Checked ${visited.size} public modules from ${entryNames.join(", ")}.`);
