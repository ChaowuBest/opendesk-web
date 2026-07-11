import chalk from 'chalk';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../entry.js';
import type { ContextDiagnosticsReport } from '../../aikernel/context/types.js';
import type { ContextSuggestion } from '../../aikernel/context/suggestions.js';
import { formatContextDiagnosticsReport } from '../../aikernel/context/format.js';

interface LegendEntry {
    name: string;
    tokens: number;
    color: string;
    symbol: string;
    isFreeSpace: boolean;
}

interface AllocatedEntry extends LegendEntry {
    exactSquares: number;
    squares: number;
    minimumSquares: number;
    remainder: number;
}

const CATEGORY_COLORS: Record<string, string> = {
    'system prompt': '#FFAB00',
    tools: '#00C853',
    messages: '#9C4DFF',
    'free space': '#E5E7EB',
    'autocompact buffer': '#9E9E9E'
};

const FALLBACK_COLORS = ['#42A5F5', '#EC407A', '#00ACC1', '#7E57C2'];

function formatCompactScaledNumber(value: number, suffix: string): string {
    if (value >= 100) {
        return `${Math.round(value)}${suffix}`;
    }
    return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

function formatCompactTokens(tokens: number): string {
    if (!Number.isFinite(tokens)) {
        return '0';
    }

    const abs = Math.abs(tokens);
    const sign = tokens < 0 ? '-' : '';
    if (abs >= 1_000_000) {
        return `${sign}${formatCompactScaledNumber(abs / 1_000_000, 'm')}`;
    }
    if (abs >= 1_000) {
        return `${sign}${formatCompactScaledNumber(abs / 1_000, 'k')}`;
    }
    return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

function formatCompactPercent(value: number | undefined, digits = 1): string {
    if (value === undefined || !Number.isFinite(value)) {
        return 'n/a';
    }
    return `${(value * 100).toFixed(digits)}%`;
}

function categoryColor(name: string, fallbackIndex: number): string {
    const key = name.toLowerCase();
    return CATEGORY_COLORS[key] ?? FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length]!;
}

function makeLegendEntry(name: string, tokens: number, fallbackIndex: number): LegendEntry {
    const isFreeSpace = name.toLowerCase() === 'free space';
    return {
        name,
        tokens,
        color: categoryColor(name, fallbackIndex),
        symbol: isFreeSpace ? '○' : '◉',
        isFreeSpace
    };
}

function collectLegendEntries(report: ContextDiagnosticsReport): LegendEntry[] {
    const entries: LegendEntry[] = [];
    const seen = new Set<string>();

    for (const category of report.categories) {
        const isFreeSpace = category.name.toLowerCase() === 'free space';
        if (category.tokens <= 0 && !isFreeSpace) {
            continue;
        }

        entries.push(makeLegendEntry(category.name, category.tokens, entries.length));
        seen.add(category.name);
    }

    if (!seen.has('Free space') && report.contextWindow > 0) {
        entries.push(
            makeLegendEntry(
                'Free space',
                Math.max(report.contextWindow - report.totalEstimatedTokens, 0),
                entries.length
            )
        );
    }

    return entries;
}

function allocateSquares(
    report: ContextDiagnosticsReport,
    entries: LegendEntry[],
    totalSquares: number
): AllocatedEntry[] {
    const contextWindow = Math.max(report.contextWindow, 1);
    const allocated: AllocatedEntry[] = entries.map((entry) => {
        const exactSquares = (entry.tokens / contextWindow) * totalSquares;
        const baseSquares = Math.floor(exactSquares);
        const minimumSquares = entry.isFreeSpace ? 0 : entry.tokens > 0 ? 1 : 0;

        return {
            ...entry,
            exactSquares,
            squares: Math.max(baseSquares, minimumSquares),
            minimumSquares,
            remainder: exactSquares - baseSquares
        };
    });

    let assigned = allocated.reduce((sum, entry) => sum + entry.squares, 0);
    if (assigned > totalSquares) {
        let overflow = assigned - totalSquares;
        const reducible = [...allocated].sort((a, b) => {
            if (a.isFreeSpace !== b.isFreeSpace) {
                return a.isFreeSpace ? -1 : 1;
            }

            const aFlex = a.squares - a.minimumSquares;
            const bFlex = b.squares - b.minimumSquares;
            if (aFlex !== bFlex) {
                return bFlex - aFlex;
            }

            return a.remainder - b.remainder;
        });

        for (const entry of reducible) {
            while (overflow > 0 && entry.squares > entry.minimumSquares) {
                entry.squares -= 1;
                overflow -= 1;
                assigned -= 1;
            }
        }
    }

    if (assigned < totalSquares) {
        let remaining = totalSquares - assigned;
        const priority = [...allocated].sort((a, b) => {
            if (a.remainder !== b.remainder) {
                return b.remainder - a.remainder;
            }
            if (a.isFreeSpace !== b.isFreeSpace) {
                return a.isFreeSpace ? 1 : -1;
            }
            return b.tokens - a.tokens;
        });

        for (let index = 0; remaining > 0; index = (index + 1) % priority.length) {
            priority[index]!.squares += 1;
            remaining -= 1;
        }
    }

    return allocated;
}

function chooseGridColumns(report: ContextDiagnosticsReport, terminalWidth: number, rightWidth: number): number {
    const availableWidth = Math.min(Math.max(terminalWidth, 20), 120);
    const candidates = report.contextWindow >= 1_000_000 ? [20, 10, 5] : [10, 5];

    for (const columns of candidates) {
        const leftWidth = Math.max(1, columns * 2 - 1);
        const requiredWidth = leftWidth + 4 + rightWidth;
        if (requiredWidth <= availableWidth) {
            return columns;
        }
    }

    return candidates[candidates.length - 1] ?? 5;
}

function buildGridRows(entries: AllocatedEntry[], columns: number, rows: number): string[] {
    const totalSquares = columns * rows;
    const cells: Array<{ symbol: string; color: string }> = [];

    for (const entry of entries) {
        for (let i = 0; i < entry.squares; i += 1) {
            cells.push({
                symbol: entry.symbol,
                color: entry.color
            });
        }
    }

    const freeColor = CATEGORY_COLORS['free space'];
    while (cells.length < totalSquares) {
        cells.push({
            symbol: '○',
            color: freeColor
        });
    }

    if (cells.length > totalSquares) {
        cells.length = totalSquares;
    }

    const rowsOut: string[] = [];
    for (let row = 0; row < rows; row += 1) {
        const start = row * columns;
        const rowCells = cells.slice(start, start + columns);
        const line = rowCells.map((cell) => chalk.hex(cell.color)(cell.symbol)).join(' ');
        rowsOut.push(line);
    }

    return rowsOut;
}

function buildLegendLine(entry: LegendEntry, contextWindow: number): string {
    const percent = contextWindow > 0 ? entry.tokens / contextWindow : undefined;
    const circle = chalk.hex(entry.color)(entry.symbol);
    const label = entry.isFreeSpace ? chalk.white(entry.name) : entry.name;
    return `${circle} ${label}: ${formatCompactTokens(entry.tokens)} tokens (${formatCompactPercent(percent)})`;
}

function buildSuggestionLine(suggestions: ContextSuggestion[]): string {
    if (suggestions.length === 0) {
        return chalk.dim('No suggestions');
    }

    const first = suggestions[0]!;
    const severity = first.severity === 'warn' ? chalk.hex('#FFAB00')('[warn]') : chalk.hex('#42A5F5')('[info]');
    const extra = suggestions.length > 1 ? chalk.dim(` (+${suggestions.length - 1} more)`) : '';
    return `1. ${severity} ${first.title}${extra}`;
}

function buildCompactRightColumn(
    report: ContextDiagnosticsReport,
    legendEntries: LegendEntry[],
    suggestions: ContextSuggestion[],
    totalSquares: number
): string[] {
    const usageRatio =
        report.usageRatio ??
        (report.contextWindow > 0 ? report.totalEstimatedTokens / report.contextWindow : undefined);
    const lines: string[] = [
        `Model: ${report.modelName ?? 'unknown'}`,
        `${formatCompactTokens(report.totalEstimatedTokens)}/${formatCompactTokens(report.contextWindow)} tokens (${formatCompactPercent(usageRatio)})`,
        chalk.dim.italic('Estimated usage by category')
    ];

    const visibleLegendEntries = legendEntries.slice(0, 4);
    for (const entry of visibleLegendEntries) {
        lines.push(buildLegendLine(entry, report.contextWindow));
    }

    if (legendEntries.length > visibleLegendEntries.length) {
        lines.push(chalk.dim(`+${legendEntries.length - visibleLegendEntries.length} more categories`));
    }

    lines.push(chalk.dim(`Each circle ≈ ${formatCompactPercent(1 / totalSquares, 1)} of window`));
    lines.push(chalk.bold('Suggestions'));
    lines.push(buildSuggestionLine(suggestions));

    return lines;
}

function padLineToWidth(line: string, width: number): string {
    const currentWidth = visibleWidth(line);
    if (currentWidth >= width) {
        return truncateToWidth(line, width, '…', true);
    }
    return line + ' '.repeat(width - currentWidth);
}

function composeLine(left: string, right: string, width: number): string {
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    const gapWidth = Math.max(4, width - leftWidth - rightWidth);
    const composed = `${left}${' '.repeat(gapWidth)}${right}`;
    return padLineToWidth(composed, width);
}

function renderContextUsagePage(
    report: ContextDiagnosticsReport,
    suggestions: ContextSuggestion[],
    terminalWidth: number
): string[] {
    const availableWidth = Math.min(Math.max(terminalWidth, 20), 120);
    const legendEntries = collectLegendEntries(report);
    const rightTemplate = buildCompactRightColumn(report, legendEntries, suggestions, 100);
    const rightWidth = Math.max(...rightTemplate.map((line) => visibleWidth(line)), 0);
    const columns = chooseGridColumns(report, availableWidth, rightWidth);
    const rows = 10;
    const totalSquares = columns * rows;
    const allocated = allocateSquares(report, legendEntries, totalSquares);
    const gridRows = buildGridRows(allocated, columns, rows);
    const rightLines = buildCompactRightColumn(report, legendEntries, suggestions, totalSquares);
    const maxRows = Math.max(gridRows.length, rightLines.length);
    const composed: string[] = [];

    for (let i = 0; i < maxRows; i += 1) {
        composed.push(composeLine(gridRows[i] ?? '', rightLines[i] ?? '', availableWidth));
    }

    return composed;
}

function showVisualPage(tui: OpenDeskTUI, title: string, lines: string[]): void {
    tui.showTextPage(title, lines.join('\n'));
}

export function openContextVisualPage(
    tui: OpenDeskTUI,
    report: ContextDiagnosticsReport,
    suggestions: ContextSuggestion[]
): void {
    const lines = renderContextUsagePage(report, suggestions, tui.tui.terminal.columns - 8);
    showVisualPage(tui, 'Context Usage', lines);
}

export function openContextDataPage(
    tui: OpenDeskTUI,
    report: ContextDiagnosticsReport,
    suggestions: ContextSuggestion[]
): void {
    tui.showTextPage('Context Diagnostics', formatContextDiagnosticsReport(report, suggestions));
}
