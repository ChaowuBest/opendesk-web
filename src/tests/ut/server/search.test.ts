import fs from 'fs';
import os from 'os';
import path from 'path';
import { findFiles, findText, fuzzyScore, InvalidSearchPatternError } from '../../../main/server/opencode/search.js';

function createWorkspace(files: Record<string, string | Buffer>): string {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-opencode-search-')));
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(workspace, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
    return workspace;
}

describe('opencode find', () => {
    let workspace: string | undefined;

    afterEach(() => {
        if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
        workspace = undefined;
    });

    test('text matches use the ripgrep JSON shape with byte offsets', async () => {
        workspace = createWorkspace({ 'src/a.ts': 'const x = 1;\n// 中文 TODO: fix\nTODO again\n' });

        await expect(findText(workspace, 'TODO')).resolves.toEqual([
            {
                path: { text: 'src/a.ts' },
                lines: { text: '// 中文 TODO: fix\n' },
                line_number: 2,
                absolute_offset: Buffer.byteLength('const x = 1;\n'),
                submatches: [
                    {
                        match: { text: 'TODO' },
                        start: Buffer.byteLength('// 中文 '),
                        end: Buffer.byteLength('// 中文 TODO')
                    }
                ]
            },
            {
                path: { text: 'src/a.ts' },
                lines: { text: 'TODO again\n' },
                line_number: 3,
                absolute_offset: Buffer.byteLength('const x = 1;\n// 中文 TODO: fix\n'),
                submatches: [{ match: { text: 'TODO' }, start: 0, end: 4 }]
            }
        ]);
    });

    test('text search follows .gitignore, includes hidden files and skips binaries', async () => {
        workspace = createWorkspace({
            '.gitignore': 'ignored.txt\n',
            'ignored.txt': 'needle\n',
            '.hidden/config': 'needle\n',
            'binary.bin': Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
            'visible.txt': 'needle\n'
        });

        const matches = await findText(workspace, 'needle');
        expect(matches.map((match) => match.path.text).sort()).toEqual(['.hidden/config', 'visible.txt']);
    });

    test('text search stops at the limit and is case sensitive', async () => {
        workspace = createWorkspace({ 'many.txt': Array.from({ length: 20 }, () => 'hit').join('\n') + '\nHIT\n' });

        await expect(findText(workspace, 'hit')).resolves.toHaveLength(10);
        await expect(findText(workspace, 'HIT')).resolves.toHaveLength(1);
    });

    test('invalid or catastrophic patterns are rejected', async () => {
        workspace = createWorkspace({ 'a.txt': 'aaaa\n' });

        await expect(findText(workspace, '(unclosed')).rejects.toBeInstanceOf(InvalidSearchPatternError);
        await expect(findText(workspace, '(a+)+')).rejects.toBeInstanceOf(InvalidSearchPatternError);
    });

    test('file search ranks the closest names first and lists directories with a trailing slash', async () => {
        workspace = createWorkspace({
            'src/server/routes/session.ts': '',
            'src/server/session-info.ts': '',
            'docs/sessions.md': '',
            'README.md': ''
        });

        const results = await findFiles(workspace, { query: 'session.ts' });
        expect(results[0]).toBe('src/server/routes/session.ts');
        expect(results).not.toContain('README.md');

        await expect(findFiles(workspace, { query: 'routes', type: 'directory' })).resolves.toEqual([
            'src/server/routes/'
        ]);
        const files = await findFiles(workspace, { query: 'server', type: 'file' });
        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => !file.endsWith('/'))).toBe(true);
    });

    test('file search honours the limit, .gitignore and empty queries', async () => {
        workspace = createWorkspace({
            '.gitignore': 'dist-out/\n',
            'dist-out/app.js': '',
            ...Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`lib/app${index}.js`, '']))
        });

        const results = await findFiles(workspace, { query: 'app', type: 'file', limit: 5 });
        expect(results).toHaveLength(5);
        expect(results.some((file) => file.startsWith('dist-out/'))).toBe(false);
        await expect(findFiles(workspace, { query: '   ' })).resolves.toEqual([]);
    });

    test('fuzzy score requires every term in order', () => {
        expect(fuzzyScore(['srt'], 'src/routes.ts')).toBeDefined();
        expect(fuzzyScore(['src', 'ts'], 'src/routes.ts')).toBeDefined();
        // 字符必须按顺序出现：routes.ts 的最后一个 s 之后没有 r
        expect(fuzzyScore(['tsr'], 'src/routes.ts')).toBeUndefined();
        expect(fuzzyScore(['zzz'], 'src/routes.ts')).toBeUndefined();
        expect(fuzzyScore(['routes'], 'src/routes.ts')!).toBeGreaterThan(fuzzyScore(['routes'], 'r/o/u/t/e/s.ts')!);
    });
});
