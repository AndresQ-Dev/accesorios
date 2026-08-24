import { mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, '..');
const output = resolve(projectRoot, 'app/static/scanner.js');
const wasmOutput = resolve(projectRoot, 'app/static/vendor/zxing_reader.wasm');
const wasmSource = require.resolve('zxing-wasm/reader/zxing_reader.wasm');

await mkdir(dirname(wasmOutput), { recursive: true });
await build({
  entryPoints: [resolve(projectRoot, 'src/client/scanner.ts')],
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
});
await copyFile(wasmSource, wasmOutput);
console.log(`Built ${output} and ${wasmOutput}`);
