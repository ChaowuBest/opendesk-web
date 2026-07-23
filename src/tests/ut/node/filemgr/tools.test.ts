import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as XLSX from 'xlsx';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { ToolCall } from '../../../../main/aikernel/messages.js';
import {
    EXTRACT_TEXT_SUPPORTED_EXTENSIONS,
    isExtractTextSupported
} from '../../../../main/applications/filemgr/parser/extract.js';
import {
    ExtractTextTool,
    SemanticSearchTool,
    createFileManagerToolset
} from '../../../../main/applications/filemgr/tools.js';

setRuntimeLocale('en-US');

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-filemgr-tools-'));
}

function cleanup(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

function makeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    status: ToolCall['status'],
    result?: string
): ToolCall {
    const call = new ToolCall(0, `${toolName}-call`, toolName, JSON.stringify(args));
    call.args_object = args;
    call.status = status;
    call.result = result;
    return call;
}

test('extractText extracts supported text files with line ranges', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'notes.md');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');

        const tool = new ExtractTextTool();
        const result = JSON.parse(
            await tool.executeCommand({
                file_path: filePath,
                offset: 2,
                limit: 1
            })
        );

        assert.equal(result.type, 'text');
        assert.equal(result.file.numLines, 1);
        assert.equal(result.file.totalLines, 3);
        assert.equal(result.file.content, '     2\tbeta');
    } finally {
        cleanup(dir);
    }
});

test('extractText extracts structured files through the shared extractText support range', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'sheet.xlsx');
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet([
            ['name', 'status'],
            ['OpenDesk', 'indexed']
        ]);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Data');
        XLSX.writeFile(workbook, filePath);

        const tool = new ExtractTextTool();
        const result = JSON.parse(await tool.executeCommand({ file_path: filePath }));

        assert.equal(result.type, 'text');
        assert.match(result.file.content, /OpenDesk\tindexed/);
        assert.equal(isExtractTextSupported(filePath), true);
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('xlsx'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('xls'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('doc'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('docx'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('pptx'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('odt'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('odp'));
        assert.ok(EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes('ods'));
    } finally {
        cleanup(dir);
    }
});

test('extractText rejects unsupported file types before extraction', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'archive.zip');
        fs.writeFileSync(filePath, 'not a supported text container', 'utf8');

        const tool = new ExtractTextTool();
        const result = JSON.parse(await tool.executeCommand({ file_path: filePath }));

        assert.equal(result.type, 'error');
        assert.match(result.error, /not supported/i);
    } finally {
        cleanup(dir);
    }
});

test('semanticSearch returns at most 30 markdown bullet results with path, title, chunk, and read hint', async () => {
    const items = Array.from({ length: 35 }, (_, index) => ({
        path: `/workspace/report-${index + 1}.md`,
        filename: `report-${index + 1}.md`,
        snippet: `matching chunk ${index + 1}`,
        matchTypes: ['name_semantic', 'content_semantic']
    }));
    const tool = new SemanticSearchTool(async (query, maxResults) => {
        assert.equal(query, 'finance plan');
        assert.equal(maxResults, 30);
        return {
            query,
            results: items,
            totalHits: items.length
        };
    });

    const output = await tool.executeCommand({
        query: 'finance plan',
        maxResults: 99
    } as any);

    assert.equal((output.match(/^- `/gm) || []).length, 30);
    assert.match(output, /\/workspace\/report-1\.md/);
    assert.match(output, /Title: report-1\.md/);
    assert.match(output, /Chunk: matching chunk 1/);
    assert.match(output, /extractText/);
});

test('extractText GUI render uses an inline summary without embedding extracted content', async () => {
    const tool = new ExtractTextTool();
    const filePath = '/workspace/local/report.md';
    const result = JSON.stringify({
        type: 'text',
        file: {
            filePath,
            content: '     1\t<script>alert(1)</script>\n     2\tplain',
            numLines: 2,
            startLine: 1,
            totalLines: 2
        }
    });
    const html = await tool.renderToolCall(makeToolCall(tool.name, { file_path: filePath }, 'success', result));

    assert.ok(html);
    assert.match(html, /class="od-inline-toolcall-container filemgr-extract-text-tool"/);
    assert.match(html, /data-open-editor="\/workspace\/local\/report\.md"/);
    assert.match(html, /2 \/ 2 lines/);
    assert.match(html, /45 chars/);
    assert.doesNotMatch(html, /<pre class=/);
    assert.doesNotMatch(html, /alert\(1\)/);
    assert.doesNotMatch(html, /<script>/);
});

test('semanticSearch GUI render uses markdown detailed card and does not render raw HTML from results', async () => {
    const tool = new SemanticSearchTool(async () => ({
        query: 'unsafe',
        results: [
            {
                path: '/workspace/unsafe.md',
                filename: 'unsafe.md',
                snippet: '<script>alert(1)</script>',
                matchTypes: ['content_semantic']
            }
        ],
        totalHits: 1
    }));
    const result = await tool.executeCommand({ query: 'unsafe', maxResults: 30 });
    const html = await tool.renderToolCall(
        makeToolCall(tool.name, { query: 'unsafe', maxResults: 30 }, 'success', result)
    );

    assert.ok(html);
    assert.match(html, /<details class="file-tool-card filemgr-semantic-search-tool/);
    assert.match(html, /markdown-body/);
    assert.match(html, /<li>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('file manager base toolset exposes extractText and no legacy semantic search tools', () => {
    const toolset = createFileManagerToolset();
    assert.equal(toolset.hasTool('extractText'), true);
    assert.equal(toolset.hasTool('readFileAsText'), false);
    assert.equal(toolset.hasTool('searchFileByName'), false);
    assert.equal(toolset.hasTool('searchFileByContent'), false);
});
