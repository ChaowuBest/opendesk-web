#!/usr/bin/env node

/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at:
 *          http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Pre-commit hook 入口：支持完整检查和增量检查。
 *
 *   tsx scripts/docs-freshness/docs-freshness.ts              完整检查
 *   tsx scripts/docs-freshness/docs-freshness.ts <files...>   增量检查（只检查指定文件）
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { checkMarkdownFile, checkVersionConsistency, checkSlashCommandDocs, runFullCheck } from './checker.js';
import { formatReport } from './reporter.js';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..', '..');

function runIncremental(files: string[]): void {
    const results = [];

    for (const f of files.filter((f) => f.endsWith('.md'))) {
        const abs = path.isAbsolute(f) ? f : path.join(rootDir, f);
        results.push(...checkMarkdownFile(abs, rootDir));
    }

    if (files.some((f) => f.endsWith('package.json'))) {
        results.push(...checkVersionConsistency(rootDir));
    }

    // 中英文命令文档都要能触发命令检查，否则改了 cliguide_en.md 不会校验命令是否对得上
    const touchesCommandDocs = files.some(
        (f) => f.includes('cliguide') || f.includes('commands/index.ts') || f.includes('commands\\index.ts')
    );
    if (touchesCommandDocs) {
        results.push(...checkSlashCommandDocs(rootDir));
    }

    const errors = results.filter((r) => r.type === 'error');
    const warnings = results.filter((r) => r.type === 'warning');
    const infos = results.filter((r) => r.type === 'info');

    console.log(formatReport({ errors, warnings, infos, fileCount: files.length }));
    process.exit(errors.length > 0 ? 1 : 0);
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法:
  tsx scripts/docs-freshness/docs-freshness.ts              完整检查
  tsx scripts/docs-freshness/docs-freshness.ts <files...>   增量检查
`);
    process.exit(0);
}

if (args.length === 0) {
    const result = runFullCheck(rootDir);
    console.log(formatReport(result, { verbose: true }));
    process.exit(result.errors.length > 0 ? 1 : 0);
} else {
    runIncremental(args);
}
