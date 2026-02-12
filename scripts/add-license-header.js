/**
 * One-off script: add Mulan PSL v2 license header to all source files under src/
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

const HEADER = `/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */
`;

const COPYRIGHT_MARKER = 'Copyright (c) 2026 The OpenDesk Team';

function* walk(dir, extList) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') {
        yield* walk(full, extList);
      }
    } else if (extList.some(ext => e.name.endsWith(ext))) {
      yield full;
    }
  }
}

const exts = ['.js', '.ts', '.tsx', '.mjs', '.cjs', '.d.ts'];
const files = [...walk(SRC, exts)];
let added = 0;
let skipped = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes(COPYRIGHT_MARKER)) {
    skipped++;
    continue;
  }
  const newContent = HEADER + (content.startsWith('\n') ? '' : '\n') + content;
  fs.writeFileSync(file, newContent, 'utf8');
  added++;
  console.log('Added header:', path.relative(SRC, file));
}

console.log('\nDone. Added:', added, 'Skipped (already had header):', skipped);
