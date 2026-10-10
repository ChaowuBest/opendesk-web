import test from 'node:test';
import assert from 'node:assert/strict';
import { TextMessagePart } from '../../../main/aikernel/messages.js';
import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';

const renderers = [(text: string) => new TextMessagePart(text).render(), renderSafeMarkdown];

test('conversation rendering preserves home-directory paths', async () => {
    const text = 'npm 启动时探测 ~/.npmrc、~/.nvm';
    for (const render of renderers) {
        const html = await render(text);
        assert.ok(html.includes(text));
        assert.ok(!html.includes('<del>'));
    }
});

test('conversation rendering keeps double-tilde strikethrough', async () => {
    for (const render of renderers) {
        const html = await render('~~旧配置~~');
        assert.ok(html.includes('<del>旧配置</del>'));
    }
});
