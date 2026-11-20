// Copies PDF.js character maps and standard fonts into public/ so they are served with the app.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdfjs = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
for (const dir of ['cmaps', 'standard_fonts']) {
  const from = join(pdfjs, dir);
  if (!existsSync(from)) throw new Error(`Missing ${from}`);
  cpSync(from, join(root, 'public', 'pdfjs', dir), { recursive: true });
}
console.log('Copied PDF.js cmaps and standard fonts to public/pdfjs');
