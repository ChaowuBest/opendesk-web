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

import type { CheckResult, FullCheckResult } from './checker.js';

const C = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m'
};

function colorize(color: keyof typeof C, text: string): string {
    return `${C[color]}${text}${C.reset}`;
}

function formatItem(symbol: string, color: keyof typeof C, item: CheckResult): string {
    const lines = [`   ${colorize(color, symbol)} [${item.file}] ${item.message}`];
    if (item.detail) {
        const isSuggestion = item.detail.startsWith('建议:') || item.detail.startsWith('建议: ');
        const prefix = isSuggestion ? '💡 ' : '→ ';
        const detailColor = isSuggestion ? 'cyan' : 'yellow';
        lines.push(`     ${colorize(detailColor, prefix + item.detail)}`);
    }
    return lines.join('\n');
}

export interface ReportOptions {
    verbose?: boolean;
}

export function formatReport(result: FullCheckResult, opts: ReportOptions = {}): string {
    const lines: string[] = [];
    const divider = colorize('cyan', '═'.repeat(60));

    lines.push('');
    lines.push(divider);
    lines.push(colorize('cyan', '📊 文档新鲜度检查报告'));
    lines.push(divider);

    if (result.errors.length > 0) {
        lines.push(colorize('red', `\n❌ 错误 (${result.errors.length}):`));
        for (const e of result.errors) {
            lines.push(formatItem('✗', 'red', e));
        }
    }

    if (result.warnings.length > 0) {
        lines.push(colorize('yellow', `\n⚠️  警告 (${result.warnings.length}):`));
        for (const w of result.warnings) {
            lines.push(formatItem('!', 'yellow', w));
        }
    }

    if (opts.verbose && result.infos.length > 0) {
        lines.push(colorize('blue', `\nℹ️  信息 (${result.infos.length}):`));
        for (const i of result.infos) {
            lines.push(formatItem('•', 'blue', i));
        }
    }

    lines.push('');
    lines.push(divider);

    const hasSuggestions = [...result.errors, ...result.warnings].some((r) => r.detail && r.detail.startsWith('建议:'));

    if (result.errors.length > 0) {
        lines.push(colorize('red', `❌ 检查完成: ${result.errors.length} 个错误, ${result.warnings.length} 个警告`));
    } else if (result.warnings.length > 0) {
        lines.push(colorize('green', `✅ 检查通过 (${result.warnings.length} 个警告)`));
    } else {
        lines.push(colorize('green', '✅ 所有文档新鲜度检查通过'));
    }

    if (hasSuggestions) {
        lines.push(colorize('cyan', '💡 部分问题附带修复建议，请查看上方 💡 标记的条目'));
    }

    return lines.join('\n');
}

export interface FixReport {
    fixed: { file: string; message: string }[];
    skipped: { file: string; message: string }[];
}

export function formatFixReport(report: FixReport): string {
    const lines: string[] = [];
    const divider = colorize('cyan', '═'.repeat(60));

    lines.push('');
    lines.push(divider);
    lines.push(colorize('cyan', '🔧 文档自动修复报告'));
    lines.push(divider);

    if (report.fixed.length > 0) {
        lines.push(colorize('green', `\n✅ 已修复 (${report.fixed.length}):`));
        for (const f of report.fixed) {
            lines.push(`   ${colorize('green', '✓')} [${f.file}] ${f.message}`);
        }
    }

    if (report.skipped.length > 0) {
        lines.push(colorize('yellow', `\n⏭️  跳过 (${report.skipped.length}):`));
        for (const s of report.skipped) {
            lines.push(`   ${colorize('yellow', '-')} [${s.file}] ${s.message}`);
        }
    }

    if (report.fixed.length === 0 && report.skipped.length === 0) {
        lines.push(colorize('green', '\n✅ 无需修复'));
    }

    lines.push('');
    lines.push(divider);

    return lines.join('\n');
}

export function formatScanResult(files: { path: string; size: number }[]): string {
    const lines: string[] = [];

    lines.push(colorize('cyan', `📚 找到 ${files.length} 个 Markdown 文件:\n`));

    for (const f of files) {
        const sizeStr = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
        lines.push(`  ${colorize('dim', '•')} ${f.path} ${colorize('dim', `(${sizeStr})`)}`);
    }

    return lines.join('\n');
}
