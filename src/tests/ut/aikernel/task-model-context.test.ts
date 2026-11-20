import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { resolveTaskModelContextSize } from '../../../main/aikernel/task/model.js';
import { Setting } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

class MetadataPlatform extends AbstractPlatform {
    getName() {
        return 'model-metadata-test';
    }

    getEffectiveWorkspace() {
        return process.cwd();
    }

    async initPlatformHarness() {}

    fetch = jest.fn(async (_input: string | URL): Promise<Response> => {
        return new Response(JSON.stringify({ context_length: 32000 }));
    });
}

function loadElectronHandler() {
    const source = ts.createSourceFile(
        'main.ts',
        readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true
    );
    let handler: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source) === 'ipcMain.handle' &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === 'taskManager:getModelContextSize'
        ) {
            handler = node.arguments[1];
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(handler).toBeDefined();
    return runInNewContext(
        ts.transpileModule(`(${handler!.getText(source)})`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 }
        }).outputText,
        { resolveTaskModelContextSize }
    ) as (_event: object, modelAlias?: string | null) => Promise<unknown>;
}

describe('task model context resolution shared by GUI hosts', () => {
    let platform: MetadataPlatform;

    beforeEach(() => {
        const environment = { ...process.env };
        delete environment.OPENDESK_MODEL_NAME;
        delete environment.OPENDESK_MODEL_CONTEXT_LENGTH;
        jest.replaceProperty(process, 'env', environment);
        platform = new MetadataPlatform();
        setPlatform(platform);
        Setting.updateInstanceData({
            default_model: 'known',
            providers: [{ name: 'metadata', base_url: 'https://metadata.test/v1', api_key: 'test', no_proxy: true }],
            models: [
                { alias: 'configured', model_name: 'gpt-4o', provider_name: 'metadata', context_length: 16000 },
                { alias: 'known', model_name: 'gpt-4o', provider_name: 'metadata' },
                { alias: 'custom', model_name: 'custom-context-model', provider_name: 'metadata' }
            ]
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('an explicit model uses its configured length before the known-model fallback', async () => {
        expect(await resolveTaskModelContextSize('configured')).toBe(16000);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test.each([undefined, null, ''])('an omitted/default selection %s uses the default known model', async (alias) => {
        expect(await resolveTaskModelContextSize(alias)).toBe(128000);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test('an explicit model uses known metadata without a network request', async () => {
        expect(await resolveTaskModelContextSize('known')).toBe(128000);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test('a custom model obtains context metadata from its provider', async () => {
        expect(await resolveTaskModelContextSize('custom')).toBe(32000);
        expect(platform.fetch.mock.calls[0][0]).toBe('https://metadata.test/v1/models/custom-context-model');
    });

    test('a custom model falls back to the model list when the single-model endpoint is unavailable', async () => {
        platform.fetch
            .mockResolvedValueOnce(new Response('{}', { status: 404 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ data: [{ id: 'custom-context-model', context_window: 64000 }] }))
            );

        expect(await resolveTaskModelContextSize('custom')).toBe(64000);
        expect(platform.fetch.mock.calls.map(([url]) => url)).toEqual([
            'https://metadata.test/v1/models/custom-context-model',
            'https://metadata.test/v1/models'
        ]);
    });

    test('failed metadata requests preserve the unknown-size result', async () => {
        platform.fetch.mockRejectedValue(new Error('provider unavailable'));

        expect(await resolveTaskModelContextSize('custom')).toBe(0);
        expect(platform.fetch).toHaveBeenCalledTimes(2);
    });

    test('missing aliases do not silently borrow the default model size', async () => {
        expect(await resolveTaskModelContextSize('missing')).toBe(0);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test('a missing default model returns unknown without metadata requests', async () => {
        Setting.updateInstanceData({ default_model: '' });

        expect(await resolveTaskModelContextSize()).toBe(0);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test('default selection preserves the existing environment model override', async () => {
        process.env.OPENDESK_MODEL_NAME = 'environment-custom-model';
        process.env.OPENDESK_MODEL_CONTEXT_LENGTH = '48000';

        expect(await resolveTaskModelContextSize(null)).toBe(48000);
        expect(await resolveTaskModelContextSize('known')).toBe(128000);
        expect(platform.fetch).not.toHaveBeenCalled();
    });

    test('Electron consumes the same resolver and wraps its numeric result', async () => {
        const handler = loadElectronHandler();

        expect(await handler({}, 'known')).toEqual({ status: 'ok', data: 128000 });
        expect(await handler({}, null)).toEqual({ status: 'ok', data: 128000 });
        expect(await handler({}, 'missing')).toEqual({ status: 'ok', data: 0 });
    });
});
