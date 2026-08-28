import {
    compactOutputToolName,
    formatOutputProcessSummary,
    formatOutputToolActivity
} from '../../../common/output-process-summary.js';

const translations: Record<string, string> = {
    'output.processSummary.reasoning': 'Deep reasoning',
    'output.processSummary.combined': '${reasoning} · ${tools}',
    'output.processSummary.listSeparator': ', ',
    'output.processSummary.usedTools.one': 'Used ${tools} in ${count} tool call',
    'output.processSummary.usedTools.many': 'Used ${tools} in ${count} tool calls',
    'output.processSummary.withElapsed': '${summary} · ${elapsed}',
    'output.running.tool': 'Running ${tool}…',
    'output.running.waiting': 'Generating response…'
};

function translate(key: string, params?: Record<string, string | number>): string {
    return Object.entries(params || {}).reduce(
        (text, [name, value]) => text.replaceAll(`\${${name}}`, String(value)),
        translations[key] || key
    );
}

describe('shared output process summary', () => {
    test('compacts a tool name by phrase and Unicode characters', () => {
        expect(compactOutputToolName('搜索文件内容，包含后续说明')).toBe('搜索文件内容');
        expect(compactOutputToolName('very-long-specialized-operation')).toBe('very-long-s…');
    });

    test('deduplicates compact names, lists two, and preserves the real call count', () => {
        expect(
            formatOutputProcessSummary({
                toolDisplayNames: ['Read file', 'Read file', 'Search files', 'Run command'],
                toolCount: 4,
                hasReasoning: true,
                elapsed: 'Elapsed 2s',
                translate
            })
        ).toBe('Deep reasoning · Used Read file, Search files in 4 tool calls · Elapsed 2s');
    });

    test('uses the same 64-character cap without losing aggregated names or call count', () => {
        const summary = formatOutputProcessSummary({
            toolDisplayNames: ['very-long-specialized-operation-name-1', 'another-long-specialized-operation-name-2'],
            toolCount: 4,
            hasReasoning: true,
            translate
        });

        expect(Array.from(summary).length).toBeLessThanOrEqual(64);
        expect(summary).toContain('very-long-s…');
        expect(summary).toContain('another-lon…');
        expect(summary).toContain('4 tool calls');
    });

    test('prefers activity, then summary, then display name for running tools', () => {
        expect(
            formatOutputToolActivity(
                { displayName: 'Read file', summary: 'Read package.json', activity: 'Reading `package.json`…' },
                translate
            )
        ).toBe('Reading `package.json`…');
        expect(formatOutputToolActivity({ displayName: 'Read file', summary: 'Read package.json' }, translate)).toBe(
            'Running Read package.json…'
        );
        expect(formatOutputToolActivity({ displayName: 'Read file' }, translate)).toBe('Running Read file…');
        expect(formatOutputToolActivity(undefined, translate)).toBe('Generating response…');
    });
});
