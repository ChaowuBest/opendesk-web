import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Jimp } from 'jimp';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { LLM } from '../../../../main/aikernel/llm.js';
import { ToolCall } from '../../../../main/aikernel/messages.js';
import { Setting, ModelInstance } from '../../../../main/utils/setting.js';
import { loadImageSource } from '../../../../main/applications/filemgr/image.js';
import { setPlatform } from '../../../../platforms/base.js';
import {
    EXTRACT_TEXT_SUPPORTED_EXTENSIONS,
    extractText,
    isExtractTextSupported
} from '../../../../main/applications/filemgr/parser/extract.js';
import {
    AskImageTool,
    ExtractTextTool,
    GlobFilesTool,
    GrepFilesTool,
    ReadImageTool,
    SemanticSearchTool,
    createFileManagerToolset,
    formatSemanticSearchMarkdown
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

test('extractText extracts supported text files', async () => {
    const dir = makeTempDir();
    try {
        const filePath = path.join(dir, 'notes.md');
        fs.writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf8');

        const tool = new ExtractTextTool(extractText);
        const result = JSON.parse(
            await tool.executeCommand({
                file_path: filePath
            })
        );

        assert.equal(result.type, 'text');
        assert.equal(result.file.numLines, 3);
        assert.match(result.file.content, /alpha/);
        assert.match(result.file.content, /beta/);
        assert.match(result.file.content, /gamma/);
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

        const tool = new ExtractTextTool(extractText);
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

        const tool = new ExtractTextTool(extractText);
        const result = JSON.parse(await tool.executeCommand({ file_path: filePath }));

        assert.equal(result.type, 'error');
        assert.match(result.error, /not supported/i);
    } finally {
        cleanup(dir);
    }
});

test('semanticSearch returns at most 30 markdown bullet results without suggesting full-file reads', async () => {
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
    assert.doesNotMatch(output, /extractText/);
});

test('semanticSearch forwards scope and renders snippets within the shared budget', async () => {
    const calls: unknown[][] = [];
    const tool = new SemanticSearchTool(async (...args) => {
        calls.push(args);
        return {
            query: 'plan',
            results: [
                {
                    path: '/workspace/report.md',
                    snippets: [
                        { chunkId: 'a', text: 'A'.repeat(500), score: 0.9 },
                        { chunkId: 'b', text: 'second chunk', score: 0.8 }
                    ]
                }
            ],
            totalHits: 1
        };
    });
    const scope = { type: 'path' as const, path: '/workspace' };
    const output = await tool.executeCommand({ query: 'plan', maxResults: 5, scope } as any);
    assert.deepEqual(calls, [['plan', 5, scope]]);
    assert.match(output, /second chunk/);
});

test('semanticSearch accepts one paths scope and invokes its executor once', async () => {
    const calls: unknown[][] = [];
    const tool = new SemanticSearchTool(async (...args) => {
        calls.push(args);
        return { query: 'plan', results: [], totalHits: 0 };
    });
    const scope = {
        type: 'paths' as const,
        paths: ['/workspace/a', '/workspace/b']
    };

    const result = await tool.execute({ query: 'plan', maxResults: 5, scope } as any);
    assert.equal(result.status, 'success');
    assert.deepEqual(calls, [['plan', 5, scope]]);
});

test('semanticSearch normalizes one JSON-stringified scope before strict validation', async () => {
    const calls: unknown[][] = [];
    const tool = new SemanticSearchTool(async (...args) => {
        calls.push(args);
        return { query: 'plan', results: [], totalHits: 0 };
    });
    const scopes = [
        { type: 'path' as const, path: '/workspace/a' },
        {
            type: 'paths' as const,
            paths: ['/workspace/a', '/workspace/b']
        }
    ];

    for (const scope of scopes) {
        const result = await tool.execute({
            query: 'plan',
            maxResults: 5,
            scope: JSON.stringify(scope)
        } as any);
        assert.equal(result.status, 'success');
    }

    assert.deepEqual(calls, [
        ['plan', 5, scopes[0]],
        ['plan', 5, scopes[1]]
    ]);

    const jsonSchema = tool.params.toJSONSchema() as any;
    assert.ok(Array.isArray(jsonSchema.properties.scope.oneOf));
    assert.equal(jsonSchema.properties.scope.type, undefined);
});

test('semanticSearch rejects malformed or invalid stringified scopes without executing', async () => {
    let calls = 0;
    const tool = new SemanticSearchTool(async () => {
        calls += 1;
        return { query: 'plan', results: [], totalHits: 0 };
    });
    const invalidScopes = [
        'not-json',
        JSON.stringify({ type: 'paths', paths: [] }),
        JSON.stringify({ type: 'unknown', paths: ['/workspace/a'] }),
        JSON.stringify(JSON.stringify({ type: 'path', path: '/workspace/a' }))
    ];

    for (const scope of invalidScopes) {
        const result = await tool.execute({
            query: 'plan',
            maxResults: 5,
            scope
        } as any);
        assert.equal(result.status, 'error');
        assert.match(String(result.result), /scope/);
    }

    assert.equal(calls, 0);
});

test('semanticSearch forwards blank queries with explicit scope for authoritative validation', async () => {
    const calls: unknown[][] = [];
    const tool = new SemanticSearchTool(async (...args) => {
        calls.push(args);
        return {
            query: '',
            results: [],
            totalHits: 0,
            warning: 'Invalid search scope',
            code: 'INVALID_SCOPE'
        };
    });
    const scope = { type: 'paths' as const, paths: ['/unknown'] };

    const result = await tool.execute({ query: '   ', maxResults: 5, scope } as any);

    assert.equal(result.status, 'success');
    assert.deepEqual(calls, [['', 5, scope]]);
    assert.match(String(result.result), /INVALID_SCOPE/);
});

test('semanticSearch keeps the existing extra-key stripping behavior for valid scopes', async () => {
    const calls: unknown[][] = [];
    const tool = new SemanticSearchTool(async (...args) => {
        calls.push(args);
        return { query: 'plan', results: [], totalHits: 0 };
    });

    const result = await tool.execute({
        query: 'plan',
        maxResults: 5,
        scope: {
            type: 'path',
            path: '/workspace/a',
            extraFromOlderCaller: 'ignored'
        }
    } as any);

    assert.equal(result.status, 'success');
    assert.deepEqual(calls, [['plan', 5, { type: 'path', path: '/workspace/a' }]]);
});

test('semanticSearch schema rejects empty and over-limit path arrays before execution', async () => {
    let calls = 0;
    const tool = new SemanticSearchTool(async () => {
        calls += 1;
        return { results: [], totalHits: 0 };
    });

    const empty = await tool.execute({
        query: 'plan',
        maxResults: 5,
        scope: { type: 'paths', paths: [] }
    } as any);
    assert.equal(empty.status, 'error');
    assert.match(String(empty.result), /paths/);

    const overLimit = await tool.execute({
        query: 'plan',
        maxResults: 5,
        scope: {
            type: 'paths',
            paths: Array.from({ length: 65 }, (_, index) => `/workspace/${index}`)
        }
    } as any);
    assert.equal(overLimit.status, 'error');
    assert.match(String(overLimit.result), /paths/);
    assert.equal(calls, 0);
});

test('semanticSearch enforces the real shared 8000 character budget but keeps every path and title', async () => {
    const fullSnippet = (index: number) => `${String(index).padStart(2, '0')}${'x'.repeat(498)}`;
    const output = formatSemanticSearchMarkdown({
        query: 'budget',
        results: [
            {
                path: '/workspace/first.md',
                filename: 'first.md',
                snippets: Array.from({ length: 17 }, (_, index) => ({
                    text: fullSnippet(index),
                    score: 1 - index / 100
                }))
            },
            { path: '/workspace/second.md', filename: 'second.md', snippet: 'must not fit' }
        ],
        totalHits: 2
    });
    assert.match(output, /00x+/);
    assert.match(output, /15x+/);
    assert.doesNotMatch(output, /16x+/);
    assert.doesNotMatch(output, /must not fit/);
    assert.match(output, /\/workspace\/second\.md/);
    assert.match(output, /Title: second\.md/);
});

test('extractText GUI render uses an inline summary without embedding extracted content', async () => {
    const tool = new ExtractTextTool(extractText);
    const filePath = '/workspace/local/report.md';
    const result = JSON.stringify({
        type: 'text',
        file: {
            filePath,
            content: '     1\t<script>alert(1)</script>\n     2\tplain',
            numLines: 2
        }
    });
    const html = await tool.renderToolCall(makeToolCall(tool.name, { file_path: filePath }, 'success', result));

    assert.ok(html);
    assert.match(html, /class="od-inline-toolcall-container filemgr-extract-text-tool"/);
    assert.match(html, /data-open-editor="\/workspace\/local\/report\.md"/);
    assert.match(html, /2 lines/);
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
    const toolset = createFileManagerToolset({ extractDelegate: extractText });
    assert.equal(toolset.hasTool('extractText'), true);
    assert.equal(toolset.hasTool('readImage'), true);
    assert.equal(toolset.hasTool('askImage'), true);
    assert.equal(toolset.hasTool('readFileAsText'), false);
    assert.equal(toolset.hasTool('searchFileByName'), false);
    assert.equal(toolset.hasTool('searchFileByContent'), false);
});

test('readImage returns local image content as a multimodal tool result', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'example.png');
    await sharp({
        create: {
            width: 32,
            height: 24,
            channels: 4,
            background: { r: 20, g: 40, b: 60, alpha: 1 }
        }
    })
        .png()
        .toFile(imagePath);

    const originalSupportsVision = LLM.supportsVision;
    const setting = Setting.getInstance();
    const originalData = setting.data;
    setting.data = {
        ...originalData,
        default_model: 'vision',
        providers: [
            {
                name: 'test',
                provider_type: 'openai',
                base_url: 'https://example.test/v1',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            }
        ],
        models: [
            {
                alias: 'vision',
                provider_name: 'test',
                model_name: 'gpt-4o',
                model_type: 'chat',
                reasoning_effort: '',
                auto_parse_think_tags: false
            }
        ]
    };
    LLM.supportsVision = async () => true;

    try {
        const result = await new ReadImageTool().execute({ path: imagePath });
        assert.equal(result.status, 'success');
        assert.doesNotMatch(result.result, /base64/);
        const summary = JSON.parse(result.result);
        // sanitizePath 统一输出正斜杠路径，Windows 上 path.join 为反斜杠，需归一化后比较
        const forwardSlashPath = imagePath.replace(/\\/g, '/');
        assert.equal(summary.type, 'image');
        assert.equal(summary.source, forwardSlashPath);
        assert.equal(summary.mediaType, 'image/png');
        assert.equal(summary.width, 32);
        assert.equal(summary.height, 24);
        const resultObject = result.result_object as {
            type: string;
            images: Array<{ image_url: string; media_type: string; source: string }>;
        };
        assert.equal(resultObject.type, 'image');
        assert.equal(resultObject.images.length, 1);
        assert.match(resultObject.images[0].image_url, /^data:image\/png;base64,/);
        assert.equal(resultObject.images[0].source, forwardSlashPath);
    } finally {
        LLM.supportsVision = originalSupportsVision;
        setting.data = originalData;
        cleanup(dir);
    }
});

test('readImage reports an error before reading when the current task model lacks vision', async () => {
    const originalSupportsVision = LLM.supportsVision;
    const setting = Setting.getInstance();
    const originalData = setting.data;
    setting.data = {
        ...originalData,
        default_model: 'fallback-vision',
        providers: [
            {
                name: 'test',
                provider_type: 'openai',
                base_url: 'https://example.test/v1',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            }
        ],
        models: [
            {
                alias: 'text-only',
                provider_name: 'test',
                model_name: 'gpt-4',
                model_type: 'chat',
                reasoning_effort: '',
                auto_parse_think_tags: false
            },
            {
                alias: 'fallback-vision',
                provider_name: 'test',
                model_name: 'gpt-4o',
                model_type: 'chat',
                reasoning_effort: '',
                auto_parse_think_tags: false
            }
        ]
    };
    let checkedModel = '';
    LLM.supportsVision = async (model) => {
        checkedModel = String(model);
        return false;
    };
    try {
        const result = await new ReadImageTool().execute({ path: '/path/that/does/not/exist.png' }, undefined, {
            model: 'text-only'
        } as any);
        assert.equal(result.status, 'error');
        assert.match(result.result, /does not support image input/i);
        assert.equal(checkedModel, 'text-only');
    } finally {
        LLM.supportsVision = originalSupportsVision;
        setting.data = originalData;
    }
});

test('askImage sends the image and question to the configured default vision model', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'question.png');
    await sharp({
        create: {
            width: 16,
            height: 12,
            channels: 3,
            background: { r: 200, g: 100, b: 50 }
        }
    })
        .jpeg()
        .toFile(imagePath);

    const setting = Setting.getInstance();
    const originalData = setting.data;
    const originalSupportsVision = LLM.supportsVision;
    const originalAsk = LLM.ask;
    setting.data = {
        ...originalData,
        default_vision_model: 'vision',
        providers: [
            {
                name: 'test',
                provider_type: 'openai',
                base_url: 'https://example.test/v1',
                api_key: '',
                no_proxy: false,
                no_ssl: false
            }
        ],
        models: [
            {
                alias: 'vision',
                provider_name: 'test',
                model_name: 'gpt-4o',
                model_type: 'chat',
                reasoning_effort: '',
                auto_parse_think_tags: false
            }
        ]
    };
    LLM.supportsVision = async () => true;

    let capturedQuestion = '';
    let capturedImage = '';
    let capturedModelName = '';
    LLM.ask = async (question, model) => {
        const userMessage = question as any;
        capturedQuestion = userMessage.content.find((part: any) => part.type === 'text')?.text ?? '';
        capturedImage = userMessage.content.find((part: any) => part.type === 'image_url')?.image_url?.url ?? '';
        capturedModelName = typeof model === 'string' ? model : (model?.model_name ?? '');
        return 'The image is orange.';
    };

    try {
        const output = await new AskImageTool().executeCommand({
            question: 'What color is the image?',
            path: imagePath
        });
        assert.equal(output, 'The image is orange.');
        assert.equal(capturedQuestion, 'What color is the image?');
        assert.match(capturedImage, /^data:image\/jpeg;base64,/);
        assert.equal(capturedModelName, 'gpt-4o');
    } finally {
        LLM.supportsVision = originalSupportsVision;
        LLM.ask = originalAsk;
        setting.data = originalData;
        cleanup(dir);
    }
});

test('askImage reports a localized error when no default vision model is configured', async () => {
    const setting = Setting.getInstance();
    const originalData = setting.data;
    setting.data = {
        ...originalData,
        default_vision_model: ''
    };
    try {
        const result = await new AskImageTool().execute({
            question: 'What is shown?',
            path: '/path/that/does/not/exist.png'
        });
        assert.equal(result.status, 'error');
        assert.match(result.result, /No default vision model is configured/i);
    } finally {
        setting.data = originalData;
    }
});

test('image tools declare network permissions for online image URLs', () => {
    const source = 'https://example.test/image.png';
    assert.deepEqual(new ReadImageTool().getDeclaredPermissions({ path: source }), [
        { resourceType: 'network', action: 'access', resourcePath: source }
    ]);
    assert.deepEqual(
        new AskImageTool().getDeclaredPermissions({
            question: 'What is shown?',
            path: source
        }),
        [{ resourceType: 'network', action: 'access', resourcePath: source }]
    );
});

test('image tools tolerate malformed HTTP URLs while declaring permissions', () => {
    assert.deepEqual(new ReadImageTool().getDeclaredPermissions({ path: 'http://[' }), []);
    assert.deepEqual(
        new AskImageTool().getDeclaredPermissions({
            question: 'What is shown?',
            path: 'https://['
        }),
        []
    );
});

test('online image sources are downloaded, validated, and returned as data URLs', async () => {
    const png = await sharp({
        create: {
            width: 10,
            height: 8,
            channels: 4,
            background: { r: 1, g: 2, b: 3, alpha: 1 }
        }
    })
        .png()
        .toBuffer();
    let requestedUrl = '';
    setPlatform({
        fetch: async (input: string | URL) => {
            requestedUrl = input.toString();
            return new Response(png, {
                status: 200,
                headers: {
                    'content-type': 'image/png',
                    'content-length': String(png.length)
                }
            });
        }
    } as any);

    const loaded = await loadImageSource('https://example.test/image.png');
    assert.equal(requestedUrl, 'https://example.test/image.png');
    assert.equal(loaded.mimeType, 'image/png');
    assert.equal(loaded.width, 10);
    assert.equal(loaded.height, 8);
    assert.match(loaded.dataUrl, /^data:image\/png;base64,/);
});

test('image sources resize large PNG images with Jimp before returning them', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'large.png');
    const png = await sharp({
        create: {
            width: 3000,
            height: 1500,
            channels: 4,
            background: { r: 10, g: 20, b: 30, alpha: 0.5 }
        }
    })
        .png()
        .toBuffer();
    fs.writeFileSync(imagePath, png);

    try {
        const loaded = await loadImageSource(imagePath);
        const output = Buffer.from(loaded.dataUrl.split(',')[1], 'base64');
        const metadata = await sharp(output).metadata();
        assert.equal(loaded.mimeType, 'image/png');
        assert.equal(loaded.width, 2048);
        assert.equal(loaded.height, 1024);
        assert.equal(metadata.width, 2048);
        assert.equal(metadata.height, 1024);
        assert.equal(output.equals(png), false);
    } finally {
        cleanup(dir);
    }
});

test('image sources resize large JPEG images with Jimp before returning them', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'large.jpg');
    const jpeg = await sharp({
        create: {
            width: 1500,
            height: 3000,
            channels: 3,
            background: { r: 10, g: 20, b: 30 }
        }
    })
        .jpeg()
        .toBuffer();
    fs.writeFileSync(imagePath, jpeg);

    try {
        const loaded = await loadImageSource(imagePath);
        const output = Buffer.from(loaded.dataUrl.split(',')[1], 'base64');
        const metadata = await sharp(output).metadata();
        assert.equal(loaded.mimeType, 'image/jpeg');
        assert.equal(loaded.width, 1024);
        assert.equal(loaded.height, 2048);
        assert.equal(metadata.width, 1024);
        assert.equal(metadata.height, 2048);
        assert.equal(output.equals(jpeg), false);
    } finally {
        cleanup(dir);
    }
});

test('image sources read WebP dimensions without converting the image', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'example.webp');
    const webp = await sharp({
        create: {
            width: 23,
            height: 17,
            channels: 4,
            background: { r: 10, g: 20, b: 30, alpha: 0.5 }
        }
    })
        .webp()
        .toBuffer();
    fs.writeFileSync(imagePath, webp);

    try {
        const loaded = await loadImageSource(imagePath);
        assert.equal(loaded.mimeType, 'image/webp');
        assert.equal(loaded.width, 23);
        assert.equal(loaded.height, 17);
        assert.equal(Buffer.from(loaded.dataUrl.split(',')[1], 'base64').equals(webp), true);
    } finally {
        cleanup(dir);
    }
});

test('image sources reject large WebP images because default Jimp has no WebP decoder', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'large.webp');
    await sharp({
        create: {
            width: 3000,
            height: 1500,
            channels: 3,
            background: { r: 10, g: 20, b: 30 }
        }
    })
        .webp()
        .toFile(imagePath);

    try {
        await assert.rejects(loadImageSource(imagePath), (error: unknown) => {
            return error instanceof Error && error.message === 'resize_unsupported';
        });
    } finally {
        cleanup(dir);
    }
});

test('image sources convert BMP, GIF, and TIFF images to PNG with Jimp', async () => {
    const dir = makeTempDir();
    const cases = [
        { extension: 'bmp', mimeType: 'image/bmp' as const },
        { extension: 'gif', mimeType: 'image/gif' as const },
        { extension: 'tiff', mimeType: 'image/tiff' as const }
    ];

    try {
        for (const imageCase of cases) {
            const imagePath = path.join(dir, `example.${imageCase.extension}`);
            const input = await new Jimp({ width: 30, height: 20, color: 0x123456ff }).getBuffer(imageCase.mimeType);
            fs.writeFileSync(imagePath, input);

            const loaded = await loadImageSource(imagePath);
            const output = Buffer.from(loaded.dataUrl.split(',')[1], 'base64');
            const metadata = await sharp(output).metadata();
            assert.equal(loaded.mimeType, 'image/png');
            assert.equal(loaded.width, 30);
            assert.equal(loaded.height, 20);
            assert.equal(metadata.format, 'png');
            assert.equal(metadata.width, 30);
            assert.equal(metadata.height, 20);
        }
    } finally {
        cleanup(dir);
    }
});

test('image sources resize large GIF images with Jimp and use the first frame', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'large.gif');
    const gif = await new Jimp({ width: 2050, height: 50, color: 0x123456ff }).getBuffer('image/gif');
    fs.writeFileSync(imagePath, gif);

    try {
        const loaded = await loadImageSource(imagePath);
        const output = Buffer.from(loaded.dataUrl.split(',')[1], 'base64');
        const metadata = await sharp(output).metadata();
        assert.equal(loaded.mimeType, 'image/png');
        assert.equal(loaded.width, 2048);
        assert.equal(loaded.height, 50);
        assert.equal(metadata.format, 'png');
        assert.equal(metadata.width, 2048);
        assert.equal(metadata.height, 50);
    } finally {
        cleanup(dir);
    }
});

test('image sources reject unsupported image formats', async () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, 'example.svg');
    fs.writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');

    try {
        await assert.rejects(loadImageSource(imagePath), (error: unknown) => {
            return error instanceof Error && error.message === 'unsupported_format';
        });
    } finally {
        cleanup(dir);
    }
});

test('semanticSearch is unavailable when no default embedding model is configured', async (context: TestContext) => {
    const model = Object.assign(Object.create(ModelInstance.prototype), { model_name: 'embed-model' });
    context.mock.method(Setting, 'getInstance', () => ({
        getDefaultEmbeddingModelInstance: () => model
    }));
    const withModel = new SemanticSearchTool(async () => ({ query: 'q', results: [], totalHits: 0 }));
    assert.equal(withModel.isAvailable(), true);

    context.mock.method(Setting, 'getInstance', () => ({
        getDefaultEmbeddingModelInstance: () => null
    }));
    const withoutModel = new SemanticSearchTool(async () => ({ query: 'q', results: [], totalHits: 0 }));
    assert.equal(withoutModel.isAvailable(), false);
});

/**
 * 回归：默认 ignore 模式必须匹配任意层级。
 * 写成 'node_modules/**' 时只忽略搜索根目录下的 node_modules，
 * 对 C:/Projects 这类多项目父目录会遍历各子项目的 node_modules（数十万文件），
 * 导致 grepFiles 长时间占用主线程并最终 V8 堆溢出。
 */
test('grepFiles ignores nested node_modules under a parent directory', async () => {
    const root = makeTempDir();
    try {
        const nestedDir = path.join(root, 'project', 'node_modules', 'pkg');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(path.join(nestedDir, 'index.js'), 'benchmark.json\n', 'utf8');
        fs.writeFileSync(path.join(root, 'project', 'app.ts'), 'benchmark.json\n', 'utf8');

        const taskState = { getWorkspace: () => root } as any;
        const output = await new GrepFilesTool().executeCommand(
            {
                pattern: 'benchmark\\.json',
                path: root,
                ignoreCase: false,
                maxResults: 50,
                contextLines: 1,
                maxColumns: 220
            } as any,
            taskState
        );

        assert.match(output, /app\.ts/);
        assert.doesNotMatch(output, /node_modules/);
    } finally {
        cleanup(root);
    }
});

test('globFiles ignores nested node_modules under a parent directory', async () => {
    const root = makeTempDir();
    try {
        const nestedDir = path.join(root, 'project', 'node_modules', 'pkg');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(path.join(nestedDir, 'index.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(root, 'project', 'app.ts'), 'export {};\n', 'utf8');

        const taskState = { getWorkspace: () => root } as any;
        const output = await new GlobFilesTool().executeCommand(
            { pattern: '**/*.ts', path: root, maxResults: 200 } as any,
            taskState
        );

        assert.match(output, /app\.ts/);
        assert.doesNotMatch(output, /node_modules/);
    } finally {
        cleanup(root);
    }
});

/**
 * 回归：模式匹配统一区分大小写（与 ripgrep / fast-glob / picomatch 的默认一致），
 * 与文件系统是否大小写敏感无关。原 caseSensitive 参数既不生效，又只在 win32 上有后置过滤。
 */
test('globFiles matches patterns case-sensitively on every platform', async () => {
    const root = makeTempDir();
    try {
        fs.writeFileSync(path.join(root, 'App.TS'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(root, 'lower.ts'), 'export {};\n', 'utf8');

        const taskState = { getWorkspace: () => root } as any;
        const output = await new GlobFilesTool().executeCommand(
            { pattern: '**/*.ts', path: root, maxResults: 200 } as any,
            taskState
        );

        assert.match(output, /lower\.ts/);
        assert.doesNotMatch(output, /App\.TS/);
    } finally {
        cleanup(root);
    }
});

/**
 * 空结果的措辞必须区分"确实没有匹配"与"遍历被预算截断"：
 * 后者的结论会让调用方误判"目录里没有这种文件"。
 * 用 -1ms 预算让第一次时间检查必然超时，避免依赖真实耗时的抖动。
 */
test('globFiles reports why an empty result is not conclusive', async () => {
    const root = makeTempDir();
    const previousBudget = process.env['OPENDESK_GLOB_TIME_BUDGET_MS'];
    try {
        fs.writeFileSync(path.join(root, 'a.txt'), 'x\n', 'utf8');
        const taskState = { getWorkspace: () => root } as any;
        const tool = new GlobFilesTool();
        const args = { pattern: '**/*.ts', path: root, maxResults: 200 } as any;

        assert.equal(await tool.executeCommand(args, taskState), '未找到匹配的文件');

        process.env['OPENDESK_GLOB_TIME_BUDGET_MS'] = '-1';
        const output = await tool.executeCommand(args, taskState);

        assert.match(output, /未找到匹配的文件（遍历在时间预算/);
        assert.match(output, /可能仍有匹配/);
    } finally {
        if (previousBudget === undefined) {
            delete process.env['OPENDESK_GLOB_TIME_BUDGET_MS'];
        } else {
            process.env['OPENDESK_GLOB_TIME_BUDGET_MS'] = previousBudget;
        }
        cleanup(root);
    }
});

/**
 * 回归：时间预算必须覆盖 fast-glob 的目录遍历阶段。
 * 之前只在 searchFile 内检查预算，超大目录树会先被完整遍历一遍才结束。
 */
test('grepFiles stops walking the tree when the time budget is exhausted', async () => {
    const root = makeTempDir();
    const previousBudget = process.env['OPENDESK_GREP_TIME_BUDGET_MS'];
    try {
        for (let i = 0; i < 200; i++) {
            fs.writeFileSync(path.join(root, `file-${i}.txt`), 'needle\n', 'utf8');
        }

        process.env['OPENDESK_GREP_TIME_BUDGET_MS'] = '1';
        const taskState = { getWorkspace: () => root } as any;
        const output = await new GrepFilesTool().executeCommand(
            {
                pattern: 'needle',
                path: root,
                ignoreCase: false,
                maxResults: 50,
                contextLines: 0,
                maxColumns: 220
            } as any,
            taskState
        );

        assert.match(output, /搜索超时/);
    } finally {
        if (previousBudget === undefined) {
            delete process.env['OPENDESK_GREP_TIME_BUDGET_MS'];
        } else {
            process.env['OPENDESK_GREP_TIME_BUDGET_MS'] = previousBudget;
        }
        cleanup(root);
    }
});
