import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../dist", import.meta.url));
const files = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (!entry.name.endsWith(".map") && entry.name !== "sw.js") files.push(path);
  }
}

await visit(root);
files.sort();
const digest = createHash("sha256");
for (const file of files) {
  digest.update(relative(root, file).split(sep).join("/"));
  digest.update(await readFile(file));
}
const template = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
digest.update(template);
const buildId = digest.digest("hex").slice(0, 12);
// Publish the shell last. Its presence also identifies a completely populated cache after an interrupted install.
const precache = files.map(file => `./${relative(root, file).split(sep).join("/")}`).filter(path => path !== "./index.html");
precache.push("./index.html");
const indexHash = createHash("sha256").update(await readFile(join(root, "index.html"))).digest("base64");
const source = template
  .replace(/^const BUILD_ID = .*;$/m, `const BUILD_ID = ${JSON.stringify(buildId)};`)
  .replace(/^const PRECACHE = .*;$/m, `const PRECACHE = ${JSON.stringify(precache)};`)
  .replace(/^const INDEX_INTEGRITY = .*;$/m, `const INDEX_INTEGRITY = "sha256-${indexHash}";`);
await writeFile(join(root, "sw.js"), source);
