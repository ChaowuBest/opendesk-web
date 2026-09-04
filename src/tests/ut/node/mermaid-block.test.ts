import test from 'node:test';
import assert from 'node:assert/strict';
import { marked as messagesMarked } from '../../../main/aikernel/messages.js';

test('mermaid code block renders as placeholder with base64 source', () => {
    const src = 'flowchart TD\n  A --> B';
    const html = messagesMarked.parse('```mermaid\n' + src + '\n```') as string;
    assert.ok(html.includes('mermaid-block'), 'should emit mermaid placeholder');
    assert.ok(!html.includes('code-block-wrapper'), 'should not emit highlight wrapper');
    const m = html.match(/data-mermaid-code="([^"]+)"/);
    assert.ok(m, 'placeholder should carry data-mermaid-code');
    const decoded = Buffer.from(m![1], 'base64').toString('utf8');
    assert.equal(decoded, src);
});

test('mermaid language tag is case-insensitive', () => {
    const html = messagesMarked.parse('```Mermaid\ngraph TD\n  A --> B\n```') as string;
    assert.ok(html.includes('mermaid-block'), 'should recognize Mermaid casing');
});

test('non-mermaid code block still uses highlight wrapper', () => {
    const html = messagesMarked.parse('```js\nconsole.log(1);\n```') as string;
    assert.ok(html.includes('code-block-wrapper'), 'js block keeps highlight wrapper');
    assert.ok(!html.includes('mermaid-block'), 'js block must not be treated as mermaid');
});
