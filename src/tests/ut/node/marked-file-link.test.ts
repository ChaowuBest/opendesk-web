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
    parseLineAnchor,
    renderFilePillFromText
} from '../../../main/aikernel/marked-file-link.js';
import { marked as messagesMarked } from '../../../main/aikernel/messages.js';

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

test('auto-detection: skips domain-like tokens', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('Visit docs.example.com/guide/setup.md for info.') as string;
        assert.ok(!html.includes('od-file-pill'), 'domain-like token must not become a pill');
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

test('auto-detection: detects existing relative file path and renders as pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts for details.') as string;
        assert.ok(html.includes('od-file-pill'), 'should contain pill class');
        assert.ok(html.includes('data-open-preview'), 'should contain data-open-preview');
        assert.ok(html.includes('utils.ts'), 'should contain file name');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// FILE_PATH_RE 的排除字符集含 ':' 与 '\'，Windows 盘符路径（C:/、C:\）暂不被
// tokenizer 支持，属于已知功能限制；绝对路径检测用例仅在 POSIX 平台验证。
const testAbsPathPosix = process.platform === 'win32' ? test.skip : test;

testAbsPathPosix('auto-detection: detects existing absolute file path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        // FILE_PATH_RE 不支持反斜杠分隔符，文本中使用正斜杠形式
        const textPath = absPath.replaceAll('\\', '/');
        const html = marked.parse(`Check ${textPath} now.`) as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes(`data-open-preview="${textPath}"`));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: renders pill for path-like text even if file does not exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/nonexistent.ts for details.') as string;
        assert.ok(html.includes('od-file-pill'), 'path-like text should render as pill (click-time validation)');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: file path inside inline code is rendered as pill when file exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Run `src/utils.ts` now.') as string;
        assert.ok(html.includes('od-file-pill'), 'existing file in backticks should become pill');
        assert.ok(html.includes('data-open-preview'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: non-file text inside inline code stays as code', () => {
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

test('auto-detection: does not convert URLs', () => {
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

test('auto-detection: detects multiple file paths in one line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), 'export {};');
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/main.ts and src/utils.ts.') as string;
        const pillCount = (html.match(/data-open-preview/g) || []).length;
        assert.equal(pillCount, 2);
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: pill contains file icon SVG', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'main.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/main.ts.') as string;
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
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-open-preview'));
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

test('edge case: file path at end of sentence with period', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Check src/utils.ts.') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('utils.ts'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('edge case: file path followed by comma', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('Check src/utils.ts, then continue.') as string;
        assert.ok(html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('edge case: file path in parentheses', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('(see src/utils.ts)') as string;
        assert.ok(html.includes('od-file-pill'));
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

test('edge case: path with multiple dots in filename', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'test.spec.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/test.spec.ts.') as string;
        assert.ok(html.includes('od-file-pill'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: path with spaces in plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'My Documents'));
        fs.writeFileSync(path.join(tmp, 'My Documents', 'report.pptx'), 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse('See My Documents/report.pptx for details.') as string;
        assert.ok(html.includes('od-file-pill'), 'should detect path with spaces');
        assert.ok(html.includes('report.pptx'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

testAbsPathPosix('auto-detection: absolute path with spaces in plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const dir = path.join(tmp, 'Documents', 'Opendesk AI');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'dev.pptx');
        fs.writeFileSync(filePath, 'dummy');
        const marked = setupMarked(tmp);
        // FILE_PATH_RE 不支持反斜杠分隔符，文本中使用正斜杠形式
        const textPath = filePath.replaceAll('\\', '/');
        const html = marked.parse(`Check ${textPath} now.`) as string;
        assert.ok(html.includes('od-file-pill'), 'should detect absolute path with spaces');
        assert.ok(html.includes(`data-open-preview="${textPath}"`));
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

test('auto-detection: plain text path with line number renders pill with data-preview-line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts:134 for details.') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-preview-line="134"'));
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

test('codespan: inline code with file path and line number renders pill with data-preview-line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See `src/utils.ts:134` for details.') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-open-preview'));
        assert.ok(html.includes('data-preview-line="134"'));
        assert.ok(!html.includes('<code>'), 'file path in backticks should become pill, not code');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('codespan: absolute path with line number renders pill with data-preview-line', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse(`See \`${absPath}:3\` now.`) as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes(`data-open-preview="${absPath}"`));
        assert.ok(html.includes('data-preview-line="3"'));
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

test('auto-detection: ellipsis-abbreviated path stays plain text', () => {
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

// ── renderFilePillFromText ───────────────────────────────────────────

test('renderFilePillFromText: single file path with line renders pill with line badge', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        setRenderWorkspace(tmp);
        const html = renderFilePillFromText('src/utils.ts:134');
        assert.ok(html);
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-preview-line="134"'));
        assert.ok(html.includes('od-file-pill-line'), 'pill should display the line number');
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('renderFilePillFromText: single file path without line renders pill without line badge', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        const html = renderFilePillFromText('main.ts');
        assert.ok(html);
        assert.ok(html.includes('od-file-pill'));
        assert.ok(!html.includes('od-file-pill-line'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('renderFilePillFromText: ellipsis-abbreviated path returns null', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        assert.equal(renderFilePillFromText('…\\agent.ts'), null);
        assert.equal(renderFilePillFromText('src/…/utils.ts'), null);
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('renderFilePillFromText: multi-line content returns null', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.writeFileSync(path.join(tmp, 'main.ts'), 'export {};');
        setRenderWorkspace(tmp);
        assert.equal(renderFilePillFromText('main.ts\nother.ts'), null);
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('renderFilePillFromText: non-file content returns null', () => {
    assert.equal(renderFilePillFromText('console.log(1)'), null);
});

test('renderFilePillFromText: blank content returns null', () => {
    assert.equal(renderFilePillFromText('  \n  '), null);
});

test('pill: plain text path with line displays line badge in label', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'utils.ts'), 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/utils.ts:134 for details.') as string;
        assert.ok(html.includes('od-file-pill-line'));
        assert.ok(html.includes(':134'));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ── fenced code block integration (messages.ts marked) ───────────────

test('fenced code block: single file path renders pill (messages marked)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        setRenderWorkspace(tmp);
        const html = messagesMarked.parse('```\n' + absPath + ':3\n```') as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes('data-preview-line="3"'));
        assert.ok(!html.includes('code-block-wrapper'));
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
