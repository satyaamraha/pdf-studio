// Copies runtime assets into public/ so they're served with the app (and work offline):
// PDF.js character maps and fonts, and the Tesseract OCR engine with English language data.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const copy = (from, to) => {
  if (!existsSync(from)) throw new Error(`Missing ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
};

const pdfjs = pkg('pdfjs-dist');
for (const dir of ['cmaps', 'standard_fonts']) copy(join(pdfjs, dir), join(root, 'public', 'pdfjs', dir));

const tess = pkg('tesseract.js');
const core = pkg('tesseract.js-core');
const out = join(root, 'public', 'tesseract');
copy(join(tess, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
// Text-recognition engines (LSTM only); the browser picks the fastest one it supports.
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copy(join(core, f), join(out, 'core', f));
}
copy(join(pkg('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), join(out, 'lang', 'eng.traineddata.gz'));
console.log('Copied PDF.js assets and the OCR engine to public/');
