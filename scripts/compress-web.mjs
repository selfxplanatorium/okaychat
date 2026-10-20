// Writes .br and .gz next to each compressible file in dist/web. The server sends them with
// serveStatic's `precompressed` option, so production responses are compressed without per-request CPU.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const root = path.resolve(process.argv[2] ?? "dist/web");
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|ttf|txt)$/;
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

let before = 0;
let after = 0;
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
  const file = path.join(entry.parentPath, entry.name);
  const data = await readFile(file);
  if (data.length < 1024) continue;
  const [br, gzipped] = await Promise.all([
    brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
    gz(data, { level: 9 }),
  ]);
  // A compressed copy that saves nothing would only cost a disk read.
  if (br.length < data.length) await writeFile(`${file}.br`, br);
  if (gzipped.length < data.length) await writeFile(`${file}.gz`, gzipped);
  before += data.length;
  after += Math.min(br.length, data.length);
}
console.log(`compress-web: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB (brotli)`);
