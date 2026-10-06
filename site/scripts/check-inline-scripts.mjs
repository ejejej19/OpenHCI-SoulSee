import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const pages = ["cuts.html", "cuts-backup.html"];
const publicUrl = new URL("../public/", import.meta.url);

for (const page of pages) {
  const html = await readFile(new URL(page, publicUrl), "utf8");
  const inlineScripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
  if (inlineScripts.length === 0) throw new Error(`${page} has no inline script to check`);
  for (const [index, match] of inlineScripts.entries()) {
    const isModule = /\btype=["']module["']/i.test(match[0]);
    const checked = spawnSync(process.execPath, [
      ...(isModule ? ["--input-type=module"] : []),
      "--check",
      "-",
    ], {
      input: match[1],
      encoding: "utf8",
    });
    if (checked.status !== 0) {
      throw new Error(`${page} inline script ${index + 1} failed syntax check:\n${checked.stderr}`);
    }
  }
}

console.log(`Checked inline scripts in ${pages.join(", ")}.`);
