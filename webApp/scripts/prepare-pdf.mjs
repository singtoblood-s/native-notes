import { cp, mkdir } from "node:fs/promises";
const source = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const target = new URL("../public/pdfjs/", import.meta.url);
await mkdir(target, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm", "LICENSE"]) {
  await cp(new URL(directory, source), new URL(directory, target), { recursive: true });
}
