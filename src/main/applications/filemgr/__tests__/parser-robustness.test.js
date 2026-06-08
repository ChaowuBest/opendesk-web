import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { LLM } from '../../../aikernel/llm.ts';
import { Setting, setCustomOpendeskDirectory } from '../../../utils/setting.js';
import { chunkStructured } from '../parser/chunk.js';
import { extractText, RAW_TEXT_MAX_FILE_SIZE } from '../parser/extract.js';

async function run(name, fn) {
    console.log(`  ${name}...`);
    await fn();
    console.log(`  ✅ ${name}`);
}

await run('line-list txt is split before embedding-sized chunks', async () => {
    const text = Array.from({ length: 12811 }, (_, i) => `n04235860_${i}.JPEG`).join('\n');
    const result = chunkStructured(text, '/tmp/1percent.txt', { chunkSize: 1000 });
    const chunks = result.chunks ?? [];

    assert.equal(result.chunk_type, 'chunk');
    assert.ok(chunks.length > 1, 'line-list should not become one huge chunk');
    assert.ok(
        chunks.every((chunk) => chunk.text.length <= 1200),
        'chunks should stay close to the target size'
    );
    assert.ok(
        chunks.every((chunk) => chunk.text.includes('.JPEG')),
        'chunks should preserve line-list records'
    );
});

await run('oversized raw text file returns null for filename-only embedding fallback', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-raw-limit-'));
    try {
        const filePath = path.join(dir, 'huge.js');
        fs.closeSync(fs.openSync(filePath, 'w'));
        fs.truncateSync(filePath, RAW_TEXT_MAX_FILE_SIZE + 1);

        const text = await extractText(filePath);

        assert.equal(text, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

await run('wide table abstracts are capped before embedding', async () => {
    for (const { ext, separator } of [
        { ext: 'csv', separator: ',' },
        { ext: 'xlsx', separator: '\t' }
    ]) {
        const headers = Array.from({ length: 120 }, (_, i) => `column_${i}_${'h'.repeat(40)}`);
        const row = Array.from({ length: 120 }, (_, i) => `cell_${i}_${'v'.repeat(120)}`);
        const text = [headers.join(separator), ...Array.from({ length: 12 }, () => row.join(separator))].join('\n');
        const result = chunkStructured(text, `/tmp/wide.${ext}`);
        const chunks = result.chunks ?? [];

        assert.equal(result.chunk_type, 'abstract');
        assert.equal(chunks.length, 1);
        assert.ok(chunks[0].text.length <= 2000, `${ext} abstract too long: ${chunks[0].text.length}`);
        assert.match(chunks[0].text, /已截断/);
    }
});

await run('batchEmbed reports invalid embedding response shape', async () => {
    const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/v1/embeddings') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'input too long' } }));
            return;
        }
        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'test server should bind a port');

    const settingDir = path.join(os.tmpdir(), `filemgr-parser-setting-${Date.now()}`);
    fs.mkdirSync(settingDir, { recursive: true });

    try {
        setCustomOpendeskDirectory(settingDir);
        Setting.clearCache();
        Setting.updateInstanceData({
            default_embedding_model: 'test-embed',
            default_reranker_model: '',
            default_model: '',
            default_intent_parsing_model: '',
            default_vision_model: '',
            providers: [
                {
                    name: 'local',
                    base_url: `http://127.0.0.1:${port}/v1`,
                    api_key: 'test',
                    no_proxy: true
                }
            ],
            models: [
                {
                    alias: 'test-embed',
                    provider_name: 'local',
                    model_name: 'test-embedding-model'
                }
            ],
            applications: {}
        });

        await assert.rejects(
            () => LLM.batchEmbed(['oversized input'], 1),
            (err) => {
                assert.match(err.message, /invalid embedding response/i);
                assert.equal(err.status, 502);
                return true;
            }
        );
    } finally {
        Setting.clearCache();
        fs.rmSync(settingDir, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
