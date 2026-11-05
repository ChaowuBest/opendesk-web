import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillAnalyzer } from '../../../main/applications/skillmgr/analyzer/analyze.js';

describe('SkillAnalyzer single file export', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'opendesk-skill-export-'));
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    function createAnalyzer() {
        const analyzer = new SkillAnalyzer();
        jest.spyOn(analyzer as any, '_collectAnalyzeSkillExports').mockReturnValue([
            { skill: { id: 'demo', name: 'Exported skill', description: '', body: '**Body**' } }
        ]);
        return analyzer;
    }

    test('writes the selected HTML file instead of a directory with sibling data.js', async () => {
        const analyzer = createAnalyzer();
        const target = path.join(directory, 'selected.html');

        expect(await analyzer.exportAnalyzePage(target, ['demo'])).toEqual({ success: true, skillCount: 1 });

        expect(await readdir(directory)).toEqual(['selected.html']);
        const html = await readFile(target, 'utf8');
        expect(html).toContain('Exported skill');
        expect(html).not.toMatch(/<script[^>]+src=/);
        expect(html).not.toContain('data.js');
    });

    test('CLI index.html destination retains a directory artifact while making the page standalone', async () => {
        const analyzer = createAnalyzer();
        const target = path.join(directory, 'cli-artifacts', 'index.html');

        expect(await analyzer.exportAnalyzePage(target, ['demo'])).toEqual({ success: true, skillCount: 1 });

        expect(await readdir(path.dirname(target))).toEqual(['index.html']);
    });

    test('a write failure is reported without falsely claiming an exported page', async () => {
        const analyzer = createAnalyzer();
        const blocker = path.join(directory, 'blocker');
        await writeFile(blocker, 'file');

        expect(await analyzer.exportAnalyzePage(path.join(blocker, 'report.html'))).toMatchObject({
            success: false,
            skillCount: 0,
            error: expect.any(String)
        });
        expect(await readdir(directory)).toEqual(['blocker']);
    });
});
