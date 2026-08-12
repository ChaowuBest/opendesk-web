import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Marked } from 'marked';
import { fileLinkExtension, setRenderWorkspace, resolveFilePath } from '../../../main/aikernel/marked-file-link.js';

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

test('resolveFilePath: returns null when file does not exist', () => {
    setRenderWorkspace('/tmp');
    assert.equal(resolveFilePath('/nonexistent/path/file.ts'), null);
    setRenderWorkspace(null);
});

test('resolveFilePath: returns null when path points to a directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        assert.equal(resolveFilePath(tmp), null);
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

test('resolveFilePath: returns null for empty string', () => {
    assert.equal(resolveFilePath(''), null);
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

test('auto-detection: detects existing absolute file path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const absPath = path.join(tmp, 'main.ts');
        fs.writeFileSync(absPath, 'export {};');
        const marked = setupMarked(tmp);
        const html = marked.parse(`Check ${absPath} now.`) as string;
        assert.ok(html.includes('od-file-pill'));
        assert.ok(html.includes(`data-open-preview="${absPath}"`));
    } finally {
        setRenderWorkspace(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('auto-detection: does not convert non-existent file path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('See src/nonexistent.ts for details.') as string;
        assert.ok(!html.includes('od-file-pill'));
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

test('markdown link: does not render a directory link as a file pill', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse(`[root](${tmp})`) as string;
        assert.ok(!html.includes('od-file-pill'));
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

test('markdown link: does not render links to non-existent files as pills', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const marked = setupMarked(tmp);
        const html = marked.parse('[missing](src/nonexistent.ts)') as string;
        assert.ok(!html.includes('od-file-pill'));
        assert.ok(html.includes('<a'));
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

test('auto-detection: absolute path with spaces in plain text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfl-'));
    try {
        const dir = path.join(tmp, 'Documents', 'Opendesk AI');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'dev.pptx');
        fs.writeFileSync(filePath, 'dummy');
        const marked = setupMarked(tmp);
        const html = marked.parse(`Check ${filePath} now.`) as string;
        assert.ok(html.includes('od-file-pill'), 'should detect absolute path with spaces');
        assert.ok(html.includes(`data-open-preview="${filePath}"`));
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
