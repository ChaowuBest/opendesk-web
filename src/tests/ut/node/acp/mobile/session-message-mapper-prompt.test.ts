import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { parseMobilePromptText } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';
import { PUBLIC_TEXT_MAX_BYTES } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';

function expectInvalid(blocks: readonly acp.ContentBlock[]): void {
    assert.throws(
        () => parseMobilePromptText(blocks),
        (error) => error instanceof acp.RequestError && error.code === -32602
    );
}

test('parses ordered text and resource links without reading metadata', () => {
    assert.equal(parseMobilePromptText([{ type: 'text', text: '  a  ' }]), 'a');
    assert.equal(
        parseMobilePromptText([
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' }
        ]),
        'a\n\nb'
    );
    assert.equal(
        parseMobilePromptText([
            {
                type: 'resource_link',
                name: 'fallback',
                title: ' Title ',
                uri: 'https://example.com/a'
            },
            { type: 'text', text: 'tail' },
            {
                type: 'resource_link',
                name: 'Name',
                uri: 'https://example.com/b'
            },
            {
                type: 'resource_link',
                name: '',
                uri: 'https://example.com/c'
            }
        ]),
        [
            'Referenced resource: Title\nhttps://example.com/a',
            'tail',
            'Referenced resource: Name\nhttps://example.com/b',
            'Referenced resource: https://example.com/c\nhttps://example.com/c'
        ].join('\n\n')
    );
    const blocks = [{ type: 'text', text: 'hello', _meta: { private: 'ignored' } }] as acp.ContentBlock[];
    assert.equal(parseMobilePromptText(blocks), 'hello');
});

test('rejects empty unsupported and embedded content before RSS', () => {
    expectInvalid([]);
    expectInvalid([{ type: 'text', text: ' \n ' }]);
    for (const block of [
        { type: 'image', mimeType: 'image/png', data: 'AA==' },
        { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
        {
            type: 'resource',
            resource: { uri: 'file:///private', text: 'private' }
        },
        { type: 'future_block', value: 'private' }
    ]) {
        expectInvalid([block as acp.ContentBlock]);
    }
});

test('enforces the public 1 MiB limit by UTF-8 bytes', () => {
    const exact = 'x'.repeat(PUBLIC_TEXT_MAX_BYTES);
    assert.equal(parseMobilePromptText([{ type: 'text', text: exact }]).length, PUBLIC_TEXT_MAX_BYTES);
    expectInvalid([{ type: 'text', text: `${exact}x` }]);
    expectInvalid([{ type: 'text', text: '😀'.repeat(PUBLIC_TEXT_MAX_BYTES / 4 + 1) }]);
    expectInvalid([{ type: 'text', text: '中'.repeat(Math.floor(PUBLIC_TEXT_MAX_BYTES / 3) + 1) }]);
});
