import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Marked } from 'marked';
import {
    fileLinkExtension,
    setRenderWorkspace,
    resolveFilePath,
    parseFileReference,
    parseLineAnchor
} from '../../../main/utils/marked-file-link.js';
import { marked as messagesMarked } from '../../../main/aikernel/messages.js';
import { sandboxPathToHostPath } from '../../../common/utils/path.js';

test('file links are non-navigation buttons, including encoded file URLs and line ranges', async () => {
    const html = await messagesMarked.parse('[report.ts:12-20](file:///tmp/report%20%231.ts#L12-L20)');
    assert.match(html, /<button type="button" class="od-file-pill"/);
    assert.ok(html.includes('data-open-preview="/tmp/report #1.ts"'));
    assert.ok(html.includes('data-preview-line="12"'));
    assert.ok(html.includes('od-file-pill-line">:12-20</span>'));
    assert.ok(!html.includes('href='));
});

test('resolveFilePath: returns absolute path when file exists (absolute input)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const filePath = path.join(tmp, 'main.ts');
        fs.writeFileSync(filePath, 'export {};');
        setRenderWorkspace(tmp);
        assert.equal(resolveFilePath(filePath), filePath);
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('resolveFilePath: resolves relative path against workspace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        assert.equal(resolveFilePath('main.ts'), path.join(tmp, 'main.ts'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// 渲染阶段零 IO：resolveFilePath 只做纯字符串解析，不校验存在性。
// "看似路径实则不存在"允许误报，由前端点击时校验并提示。

test('resolveFilePath: returns resolved path even when file does not exist', () => {
    setRenderWorkspace('/tmp');
    assert.equal(resolveFilePath('/nonexistent/path/file.ts'), '/nonexistent/path/file.ts');
    setRenderWorkspace(null);
});

test('resolveFilePath: returns resolved path for directories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        assert.equal(resolveFilePath(tmp), tmp);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('resolveFilePath: resolves relative path against workspace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        assert.equal(resolveFilePath('main.ts'), path.join(tmp, 'main.ts'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('resolveFilePath: returns null for URLs', () => {
    assert.equal(resolveFilePath('https://example.com/file.ts'), null);
});

test('resolveFilePath: returns null for hash links', () => {
    assert.equal(resolveFilePath('#section'), null);
});

test('resolveFilePath: returns null for paths containing ellipsis', () => {
    setRenderWorkspace('/tmp');
    assert.equal(resolveFilePath('…\\agent.ts'), null);
    assert.equal(resolveFilePath('src/…/utils.ts'), null);
    assert.equal(resolveFilePath('D:\\proj\\…\\main.ts'), null);
    setRenderWorkspace(null);
});

test('resolveFilePath: returns null for empty string', () => {
    assert.equal(resolveFilePath(''), null);
});

// ── tokenizer hardening ─────────────────────────────────────────────

test('plain text: domain-like token stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('Visit docs.example.com/guide/setup.md for info.') as string;
        assert.ok(!html.includes('od-file-pill'), 'path-like text must not become a pill');
        assert.ok(html.includes('docs.example.com/guide/setup.md'), 'text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── Integration tests with Marked ──────────────────────────────────

function setupMarked(tmpDir: string): Marked {
    setRenderWorkspace(tmpDir);
    const marked = new Marked();
    marked.use(fileLinkExtension);
    return marked;
}

// ── 仅 markdown 链接渲染为 pill ─────────────────────────────────────
// 真实案例（task_mtx6k01g_9aw1）：模型在正文/codespan 里写的裸文件名
// （`previewer.ts`）与点分标识符（`context.mock`）曾被按 workspace 根目录
// 解析成必然不存在的胶囊，点击即弹"文件不存在"。现约定：只有显式的
// [...]() 链接才转换为 pill，纯文本、codespan、围栏代码块一律不解析。

test('plain text: existing file path stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: absolute file path stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        const textPath = absPath.replaceAll('\\', '/');
        const html = marked.parse(`Check ${textPath} now.`) as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes(textPath), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: nonexistent path-like text stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/nonexistent.ts for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'path-like text should stay plain text');
        assert.ok(html.includes('src/nonexistent.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: existing file path stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Run `src/utils.ts` now.') as string;
        assert.ok(!html.includes('od-file-pill'), 'codespan must not become a pill');
        assert.ok(html.includes('<code>'), 'codespan stays as inline code');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: non-file text stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('Run `npm install` now.') as string;
        assert.ok(!html.includes('od-file-pill'));
        assert.ok(html.includes('<code>'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: URLs stay plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('Visit https://example.com/file.ts for info.') as string;
        assert.ok(!html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: multiple file paths stay plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), 'export {};');
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/main.ts and src/utils.ts.') as string;
        assert.equal((html.match(/data-open-preview/g) || []).length, 0, 'plain text must not produce pills');
        assert.ok(html.includes('src/main.ts') && html.includes('src/utils.ts'), 'text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: pill contains file icon SVG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[main.ts](src/main.ts)') as string;
        assert.ok(html.includes('od-file-pill-icon'));
        assert.ok(html.includes('<svg'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: renders link to existing file as pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts](src/utils.ts)') as string;
        assert.match(html, /<button type="button" class="od-file-pill"/);
        assert.ok(html.includes('data-open-preview'));
        assert.ok(!html.includes('href='));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: renders OpenDesk skill links as skill pills', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[calendar](opendesk-skill:calendar/calendar)') as string;
        assert.ok(html.includes('<button type="button" class="od-skill-pill"'));
        assert.ok(html.includes('data-skill-bundle="calendar"'));
        assert.ok(html.includes('data-skill-name="calendar"'));
        assert.ok(html.includes('od-skill-pill-icon'));
        assert.ok(!html.includes('data-open-preview'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: renders directory link as pill (existence validated at click time)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse(`[root](${tmp})`) as string;
        assert.ok(html.includes('od-file-pill'), 'path-like href renders as pill; existence is validated on click');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: renders link with custom label as pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[click here](src/utils.ts)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('click here'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: does not render URL links as pills', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[example](https://example.com)') as string;
        assert.ok(!html.includes('od-file-pill'));
        assert.ok(html.includes('<a'));
        assert.ok(html.includes('href="https://example.com"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: renders path-like hrefs as pills even if file does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[missing](src/nonexistent.ts)') as string;
        assert.ok(
            html.includes('od-file-pill'),
            'link with path-like href should render as pill (click-time validation)'
        );
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: file path at end of sentence stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Check src/utils.ts.') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: file path followed by comma stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Check src/utils.ts, then continue.') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: file path in parentheses stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('(see src/utils.ts)') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('edge case: does not affect code blocks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('```\nsrc/utils.ts\n```') as string;
        assert.ok(!html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: path with multiple dots in filename renders pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'test.spec.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[test.spec.ts](src/test.spec.ts)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(/data-open-preview="[^"]*test\.spec\.ts"/.test(html));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: path with spaces stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'My Documents'));
        fs.writeFileSync(path.join(tmp, 'My Documents', 'report.pptx'), 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse('See My Documents/report.pptx for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('My Documents/report.pptx'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: absolute path with spaces stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const dir = path.join(tmp, 'Documents', 'Opendesk AI');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'dev.pptx');
        fs.writeFileSync(filePath, 'dummy');
        const marked = setupMarked(tmp);
        const textPath = filePath.replaceAll('\\', '/');
        const html = marked.parse(`Check ${textPath} now.`) as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes(textPath), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: URL-encoded href with spaces is decoded', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'My Documents'));
        fs.writeFileSync(path.join(tmp, 'My Documents', 'report.pptx'), 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse('[report](My%20Documents/report.pptx)') as string;
        assert.ok(html.includes('od-file-pill'), 'should decode %20 and match file');
        assert.ok(html.includes('data-open-preview'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: #L anchor works with %20-encoded spaces', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'My Documents'));
        const filePath = path.join(tmp, 'My Documents', 'report.pptx');
        fs.writeFileSync(filePath, 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse('[report:3](My%20Documents/report.pptx#L3)') as string;
        assert.ok(html.includes('od-file-pill'), 'anchor must be parsed after %20 decoding');
        assert.ok(html.includes(`data-open-preview="${filePath}"`));
        assert.ok(html.includes('data-preview-line="3"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: angle-bracket destination with spaces and #L anchor', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'My Docs'));
        const filePath = path.join(tmp, 'My Docs', 'report.pptx');
        fs.writeFileSync(filePath, 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse('[report:3](<My Docs/report.pptx#L3>)') as string;
        assert.ok(html.includes('od-file-pill'), 'angle-bracket destination must support spaces');
        assert.ok(html.includes(`data-open-preview="${filePath}"`));
        assert.ok(html.includes('data-preview-line="3"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── File path + line reference parsing ───────────────────────────────

test('parseFileReference: strips trailing line number', () => {
    assert.deepEqual(parseFileReference('/path/to/file.ts:134'), {
        filePath: '/path/to/file.ts',
        line: 134
    });
});

test('parseFileReference: strips line and column', () => {
    assert.deepEqual(parseFileReference('/path/to/file.ts:12:8'), {
        filePath: '/path/to/file.ts',
        line: 12
    });
});

test('parseFileReference: returns null line when no suffix', () => {
    assert.deepEqual(parseFileReference('/path/to/file.ts'), {
        filePath: '/path/to/file.ts',
        line: null
    });
});

test('parseFileReference: returns null line for URL', () => {
    assert.deepEqual(parseFileReference('https://example.com/file.ts'), {
        filePath: 'https://example.com/file.ts',
        line: null
    });
});

test('parseFileReference: returns null line for non-numeric suffix', () => {
    assert.deepEqual(parseFileReference('/path/to/file.ts:abc'), {
        filePath: '/path/to/file.ts:abc',
        line: null
    });
});

test('parseFileReference: returns null line for zero line number', () => {
    assert.deepEqual(parseFileReference('/path/to/file.ts:0'), {
        filePath: '/path/to/file.ts:0',
        line: null
    });
});

test('markdown link: renders link with line number as pill with data-preview-line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts](src/utils.ts:134)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-open-preview'));
        assert.ok(html.includes('data-preview-line="134"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: path with line number stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts:134 for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text path must not become a pill');
        assert.ok(html.includes('src/utils.ts:134'), 'path and line text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: pill without line number has no data-preview-line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts](src/utils.ts)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(!html.includes('data-preview-line'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: path with line number stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See `src/utils.ts:134` for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'codespan must not become a pill');
        assert.ok(html.includes('<code>'), 'codespan stays as inline code');
        assert.ok(html.includes('src/utils.ts:134'), 'path and line text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: absolute path with line number stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse(`See \`${absPath}:3\` now.`) as string;
        assert.ok(!html.includes('od-file-pill'), 'codespan must not become a pill');
        assert.ok(html.includes('<code>'), 'codespan stays as inline code');
        assert.ok(html.includes(`${absPath}:3`), 'path and line text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── #L line anchor hrefs (markdown links) ────────────────────────────

test('parseLineAnchor: parses single line anchor', () => {
    assert.deepEqual(parseLineAnchor('src/utils.ts#L134'), {
        filePath: 'src/utils.ts',
        line: 134,
        lineEnd: null
    });
});

test('parseLineAnchor: parses line range anchor', () => {
    assert.deepEqual(parseLineAnchor('src/utils.ts#L12-20'), {
        filePath: 'src/utils.ts',
        line: 12,
        lineEnd: 20
    });
});

test('parseLineAnchor: parses GitHub-style range anchor with second L', () => {
    assert.deepEqual(parseLineAnchor('src/utils.ts#L12-L20'), {
        filePath: 'src/utils.ts',
        line: 12,
        lineEnd: 20
    });
});

test('parseLineAnchor: returns null without anchor', () => {
    assert.equal(parseLineAnchor('src/utils.ts'), null);
});

test('parseLineAnchor: returns null for non-line anchor', () => {
    assert.equal(parseLineAnchor('src/utils.ts#section'), null);
});

test('parseLineAnchor: returns null for zero line anchor', () => {
    assert.equal(parseLineAnchor('src/utils.ts#L0'), null);
});

test('parseLineAnchor: drops reversed range', () => {
    assert.deepEqual(parseLineAnchor('src/utils.ts#L20-L5'), {
        filePath: 'src/utils.ts',
        line: 20,
        lineEnd: null
    });
});

test('parseLineAnchor: collapses single-line range', () => {
    assert.deepEqual(parseLineAnchor('src/utils.ts#L5-L5'), {
        filePath: 'src/utils.ts',
        line: 5,
        lineEnd: null
    });
});

test('markdown link: #L anchor renders pill with line badge and clean path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        const filePath = path.join(tmp, 'src', 'utils.ts');
        fs.writeFileSync(filePath, 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts](src/utils.ts#L134)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes(`data-open-preview="${filePath}"`), 'anchor must be stripped from the opened path');
        assert.ok(html.includes('data-preview-line="134"'));
        assert.ok(html.includes('od-file-pill-line">:134'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: #L range anchor renders range badge', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts](src/utils.ts#L12-20)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-preview-line="12"'));
        assert.ok(html.includes('od-file-pill-line">:12-20'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: ranged label with start-only anchor keeps full range', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        // ZCode 风格：文字带起止区间，锚点只带起始行；区间信息不能丢失，也不能重复展示
        const html = marked.parse('[utils.ts:12-20](src/utils.ts#L12)') as string;
        assert.ok(html.includes('data-preview-line="12"'));
        assert.ok(html.includes('od-file-pill-line">:12-20'));
        assert.ok(!html.includes(':12-20:12'), 'label range must not duplicate with href badge');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: reversed range in label falls back to single line badge', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts:12-5](src/utils.ts#L12)') as string;
        assert.ok(html.includes('data-preview-line="12"'));
        assert.ok(html.includes('od-file-pill-line">:12</span>'), 'invalid range must collapse to single line');
        assert.ok(!html.includes(':12-5'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: legacy href line suffix is not duplicated in label', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('[utils.ts:134](src/utils.ts:134)') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-preview-line="134"'));
        assert.ok(!html.includes(':134:134'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: backslash absolute href with #L anchor renders pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse(`[main.ts](${absPath}#L3)`) as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes(`data-open-preview="${absPath}"`));
        assert.ok(html.includes('data-preview-line="3"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: URL href with #L anchor stays a normal link', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[example](https://example.com/file.ts#L2)') as string;
        assert.ok(!html.includes('od-file-pill'));
        assert.ok(html.includes('href="https://example.com/file.ts#L2"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: ellipsis-abbreviated path stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/…/utils.ts for details.') as string;
        assert.ok(!html.includes('od-file-pill'), 'ellipsis-abbreviated path must not become a pill');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: ellipsis-abbreviated path stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('打开 `…\\agent.ts` 查看。') as string;
        assert.ok(!html.includes('od-file-pill'), 'ellipsis-abbreviated path must not become a pill');
        assert.ok(html.includes('<code>'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('markdown link: ellipsis href renders as normal link, not pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[agent.ts](src/…/agent.ts)') as string;
        assert.ok(!html.includes('od-file-pill'), 'ellipsis href must not become a pill');
        // marked 默认渲染器会对 href 做 percent-encode（… → %E2%80%A6）
        assert.ok(html.includes('<a href="src/%E2%80%A6/agent.ts"'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── POSIX-style drive-root paths (/C:/...) ───────────────────────────

test('resolveFilePath: normalizes POSIX-style drive-root path (/C:/...)', () => {
    setRenderWorkspace(null);
    assert.equal(
        resolveFilePath('/C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py'),
        'C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py'
    );
});

test('resolveFilePath: normalizes lowercase drive-root path and backslash form', () => {
    setRenderWorkspace(null);
    assert.equal(resolveFilePath('/c:/Users/me/file.ts'), 'c:/Users/me/file.ts');
    assert.equal(resolveFilePath('/C:\\Users\\me\\file.ts'), 'C:\\Users\\me\\file.ts');
});

test('resolveFilePath: POSIX absolute paths are not affected', () => {
    setRenderWorkspace(null);
    assert.equal(resolveFilePath('/home/user/file.ts'), '/home/user/file.ts');
    // 盘符必须为单字母，多段名（如 /cc:/）不是盘符根路径
    assert.equal(resolveFilePath('/cc:/file.ts'), '/cc:/file.ts');
});

test('markdown link: POSIX-style drive-root href with #L anchor renders normalized pill', () => {
    const marked = setupMarked('C:/Projects/OpenDesk-ohos/ohos_hap');
    const html = marked.parse(
        '[build_hap.py:1938-1954](/C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py#L1938-L1954)'
    ) as string;
    assert.ok(html.includes('od-file-pill'), 'drive-root href should render as pill');
    assert.ok(
        html.includes('data-open-preview="C:/Projects/OpenDesk-ohos/ohos_hap/build_hap.py"'),
        'leading slash before the drive letter must be stripped'
    );
    assert.ok(html.includes('data-preview-line="1938"'));
    assert.ok(html.includes('od-file-pill-line">:1938-1954'));
});
test('plain text: path with line suffix stays plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts:134 for details.') as string;
        assert.ok(!html.includes('od-file-pill'));
        assert.ok(!html.includes('od-file-pill-line'));
        assert.ok(html.includes('src/utils.ts:134'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── fenced code block integration (messages.ts marked) ───────────────

test('fenced code block: single file path stays as code block (messages marked)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        setRenderWorkspace(tmp);
        const html = messagesMarked.parse('```\n' + absPath + ':3\n```') as string;
        assert.ok(!html.includes('od-file-pill'), 'fenced block with a single path must stay a code block');
        assert.ok(html.includes('code-block-wrapper'));
        assert.ok(html.includes(`${absPath}:3`), 'path and line text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('fenced code block: multi-line code stays as code block (messages marked)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        const html = messagesMarked.parse('```js\nconsole.log(1);\n```') as string;
        assert.ok(html.includes('code-block-wrapper'));
        assert.ok(!html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('indented code block: single file path stays as code block (messages marked)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        setRenderWorkspace(tmp);
        const html = messagesMarked.parse('    ' + absPath) as string;
        assert.ok(html.includes('code-block-wrapper'));
        assert.ok(!html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── 误报胶囊治理（历史案例回归）──────────────────────────────────────
// 真实案例（task_mtx6k01g_9aw1）：模型在 codespan 里写 `previewer.ts`、
// `SemanticSearchTool.isAvailable` 等裸名/标识符，曾被按 workspace 根目录
// 解析成必然不存在的胶囊，点击即弹"文件不存在"。codespan 现已不再解析。

test('codespan: bare filename without directory stays as code even if it exists at workspace root', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'previewer.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('未夹带：`previewer.ts` 仍留在工作区') as string;
        assert.ok(!html.includes('od-file-pill'), 'bare filename in codespan should not become a pill');
        assert.ok(html.includes('<code>'), 'bare filename should stay as inline code');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: dotted code identifier stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse(
            '表格里写 `SemanticSearchTool.isAvailable`，mock 基于 `context.mock` 与 `context.mock.method`。'
        ) as string;
        assert.ok(!html.includes('od-file-pill'), 'dotted identifier should not become a pill');
        assert.ok(html.includes('<code>'), 'dotted identifier should stay as inline code');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: relative path with separator stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        const marked = setupMarked(tmp);
        const html = marked.parse('改动见 `src/utils.ts`。') as string;
        assert.ok(!html.includes('od-file-pill'), 'codespan must not become a pill');
        assert.ok(html.includes('<code>'), 'codespan stays as inline code');
        assert.ok(html.includes('src/utils.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: absolute Windows backslash path stays as code', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('见 `C:\\Projects\\OpenDesk\\src\\main\\a.ts`') as string;
        assert.ok(!html.includes('od-file-pill'), 'codespan must not become a pill');
        assert.ok(html.includes('<code>'), 'codespan stays as inline code');
        assert.ok(html.includes('C:\\Projects\\OpenDesk\\src\\main\\a.ts'), 'path text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('fenced code block: bare filename stays as code block (messages marked)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        setRenderWorkspace(tmp);
        const html = messagesMarked.parse('```\npreviewer.ts\n```') as string;
        assert.ok(!html.includes('od-file-pill'), 'bare filename in fenced block should not become a pill');
        assert.ok(html.includes('code-block-wrapper'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── 误报胶囊治理（历史案例回归）：纯文本不再产生任何胶囊 ─────────────
// 真实案例（task_mtx6k01g_9aw1）：整句中文 "……无关（storage.js/worker.js 均无改动"
// 曾被内联自动识别吞成单个巨型胶囊。自动识别已移除，此类文本一律保持原样。

test('plain text: CJK sentence containing path fragments produces no pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const text =
            'storage.test.js 头部注明使用真实 LLM API（OpenRouter），这类测试依赖外部凭证，与本次改动无关（storage.js/worker.js 均无改动，测试也不导入 tools.ts）。';
        const html = marked.parse(text) as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text must never produce pills');
        assert.ok(html.includes('storage.js/worker.js'), 'path fragment text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('plain text: CJK enumeration between paths produces no pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('改动涉及 src/a.ts、src/b.ts 两个文件。') as string;
        assert.ok(!html.includes('od-file-pill'), 'plain text must never produce pills');
        assert.ok(html.includes('src/a.ts、src/b.ts'), 'text must be preserved');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── 沙箱虚拟路径还原（Dynobox: Z:\C\foo ↔ 宿主 C:\foo）──────────────────

test('sandboxPathToHostPath: rewrites virtual drive paths to host paths', () => {
    assert.equal(sandboxPathToHostPath('Z:\\C\\Users\\a\\out.pptx'), 'C:\\Users\\a\\out.pptx');
    assert.equal(sandboxPathToHostPath('Z:/C/Projects/OpenDesk'), 'C:\\Projects/OpenDesk');
    assert.equal(sandboxPathToHostPath('z:\\d\\data'), 'D:\\data');
    assert.equal(sandboxPathToHostPath('Z:\\D'), 'D:\\');
});

test('sandboxPathToHostPath: leaves non-sandbox paths untouched', () => {
    // 第二段不是单个盘符字母（真实目录名），不能改写
    assert.equal(sandboxPathToHostPath('Z:\\CORS\\rules'), 'Z:\\CORS\\rules');
    assert.equal(sandboxPathToHostPath('Z:\\Users\\a'), 'Z:\\Users\\a');
    // 沙箱卷固定挂载在 Z:，其他盘符上的同形路径是宿主真实路径
    assert.equal(sandboxPathToHostPath('Y:\\C\\data'), 'Y:\\C\\data');
    assert.equal(sandboxPathToHostPath('C:\\Users\\a'), 'C:\\Users\\a');
    assert.equal(sandboxPathToHostPath('/C/foo'), '/C/foo');
    assert.equal(sandboxPathToHostPath(''), '');
});

test('resolveFilePath: resolves sandbox artifact path to the host path', () => {
    setRenderWorkspace(null);
    const result = resolveFilePath('Z:\\C\\Users\\liyif\\AppData\\Local\\Temp\\out.pptx');
    assert.ok(result, 'sandbox path must resolve to a pill target');
    assert.ok(!result.includes('Z:'), 'virtual drive must be stripped');
    assert.ok(/[A-Z]:/.test(result), 'host drive must remain');
});

test('markdown link: sandbox artifact href renders a pill with host path', () => {
    const marked = new Marked(fileLinkExtension);
    setRenderWorkspace(null);
    try {
        const href = 'Z:\\C\\Users\\liyif\\AppData\\Local\\Temp\\out.pptx';
        const html = marked.parse(`[产物](${href})`) as string;
        assert.ok(html.includes('od-file-pill'), 'sandbox path must still render a pill');
        assert.ok(html.includes('data-open-preview="C:'), 'pill must carry the host path');
    } finally {
        setRenderWorkspace(null);
    }
});

test('markdown link: plain CJK characters in href still render pills', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        // 链接是显式引用：汉字是合法路径字符，胶囊路径解析不能对汉字过度排除
        const html = marked.parse('[报告](说明文档/报告.docx)') as string;
        assert.ok(html.includes('od-file-pill'));
        // data-open-preview 在 Windows 上经 path.resolve 变为反斜杠分隔
        assert.ok(
            /data-open-preview="[^"]*说明文档[\\/]+报告\.docx"/.test(html),
            'CJK characters themselves must not be excluded'
        );
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
