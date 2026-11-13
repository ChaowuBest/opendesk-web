import assert from 'node:assert/strict';
import test from 'node:test';
import { FileMgrApplication } from '../../../../main/applications/filemgr/app.js';
import { createIndexedSearchContext } from '../../../../main/applications/filemgr/search/indexed.js';

test('R12 actual Agent tool binding fixes three routes and preserves scope and the result limit', async (t) => {
    const app = new FileMgrApplication();
    const calls: Array<{ query: string; options: any }> = [];
    t.mock.method(app, 'searchIndexedFiles', async (query: string, options: any) => {
        calls.push({ query, options });
        return { query, results: [], totalHits: 0 };
    });
    const [toolset] = await app.getToolsets();
    const tool = toolset.getTool('semanticSearch')!;
    const scope = { type: 'path' as const, path: '/isolated/source' };
    await tool.executeCommand({ query: '  budget  ', maxResults: 999, scope });
    assert.deepEqual(calls, [
        {
            query: 'budget',
            options: { topK: 30, scope, routes: ['keyword', 'name_semantic', 'content_semantic'] }
        }
    ]);
    await tool.executeCommand({ query: 'empty', maxResults: 1 });
    assert.equal(calls[1].options.topK, 1);
    assert.deepEqual(calls[1].options.routes, ['keyword', 'name_semantic', 'content_semantic']);
});

test('R12 default homepage context retains all four routes', () => {
    assert.deepEqual(createIndexedSearchContext('budget').routes, {
        keyword: true,
        bm25: true,
        nameSemantic: true,
        contentSemantic: true,
        needsSemantic: true
    });
});
