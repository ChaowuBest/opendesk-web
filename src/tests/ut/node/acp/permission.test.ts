import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpPermissionPromptProvider } from '../../../../main/server/acp/permission.js';

class FakePermissionConnection {
    requests: unknown[] = [];

    constructor(private readonly optionId: string | null) {}

    async requestPermission(params: unknown): Promise<any> {
        this.requests.push(params);
        if (this.optionId === null) {
            return { outcome: { outcome: 'cancelled' } };
        }
        return {
            outcome: {
                outcome: 'selected',
                optionId: this.optionId
            }
        };
    }
}

test('ACP permission provider maps allow once', async () => {
    const connection = new FakePermissionConnection('allow_once');
    const provider = new AcpPermissionPromptProvider(connection as any, 'session-1');

    const result = await provider.prompt(
        [{ resourceType: 'file', action: 'read', resourcePath: '/tmp/a.txt' }],
        'readFile',
        [{ label: '/tmp/a.txt', pattern: '/tmp/a.txt' }]
    );

    assert.deepEqual(result, { decision: 'allow', rememberScope: 'none' });
    assert.equal((connection.requests[0] as any).sessionId, 'session-1');
});

test('ACP permission provider maps allow always to prefix scope', async () => {
    const connection = new FakePermissionConnection('allow_always');
    const provider = new AcpPermissionPromptProvider(connection as any, 'session-1');

    const result = await provider.prompt(
        [{ resourceType: 'file', action: 'write', resourcePath: '/tmp/a.txt' }],
        'writeFile',
        [{ label: '/tmp/', pattern: '/tmp/**' }]
    );

    assert.deepEqual(result, {
        decision: 'allow',
        rememberScope: 'prefix',
        selectedPrefixPattern: '/tmp/**'
    });
});

test('ACP permission provider maps reject and cancel to deny', async () => {
    const rejected = new AcpPermissionPromptProvider(new FakePermissionConnection('reject_once') as any, 'session-1');
    assert.deepEqual(
        await rejected.prompt(
            [{ resourceType: 'network', action: 'access', resourcePath: 'https://example.com' }],
            'webFetch',
            []
        ),
        { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
    );

    const cancelled = new AcpPermissionPromptProvider(new FakePermissionConnection(null) as any, 'session-1');
    assert.deepEqual(
        await cancelled.prompt([{ resourceType: 'file', action: 'read', resourcePath: '/tmp/a.txt' }], 'readFile', []),
        { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
    );
});
