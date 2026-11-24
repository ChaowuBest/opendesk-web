import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { t } from '../../../../../locale/index.js';
import {
    OPENDESK_MODEL_EFFORT_CONFIG_ID,
    decodeModelEffortValue,
    encodeModelEffortValue,
    mapSessionModelConfigurationOptions
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';

const configuration = {
    current: { modelAlias: 'alpha', reasoningEffort: 'low' as const },
    candidates: [
        { modelAlias: 'alpha', reasoningEfforts: ['', 'low'] as const },
        { modelAlias: 'β', reasoningEfforts: ['', 'max'] as const }
    ]
};

async function withIsolatedOpenDeskConfig(run: () => void | Promise<void>) {
    const previous = process.env.OPENDESK_CONFIG_DIRECTORY;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesk-mobile-config-'));
    process.env.OPENDESK_CONFIG_DIRECTORY = directory;
    try {
        await run();
    } finally {
        if (previous === undefined) delete process.env.OPENDESK_CONFIG_DIRECTORY;
        else process.env.OPENDESK_CONFIG_DIRECTORY = previous;
        await fs.rm(directory, { recursive: true, force: true });
    }
}

test('maps one grouped model select with a canonical atomic value', async () => {
    await withIsolatedOpenDeskConfig(() => {
        const [option] = mapSessionModelConfigurationOptions(configuration);
        assert.equal(option?.id, OPENDESK_MODEL_EFFORT_CONFIG_ID);
        assert.equal(option?.type, 'select');
        assert.equal(option?.category, 'model');
        assert.equal(option?.name, `${t('model.provider_model')} / ${t('config.model.field.reasoning_effort')}`);
        assert.equal(option?.currentValue, '["alpha","low"]');
        assert.deepEqual(decodeModelEffortValue(option!.currentValue), configuration.current);
        assert.deepEqual(
            option?.options.map((group) => ('group' in group ? group.group : undefined)),
            ['alpha', 'β']
        );
    });
});

test('rejects malformed or noncanonical values', () => {
    for (const value of [
        '',
        '[]',
        '["alpha"]',
        '["alpha","low",""]',
        '["","low"]',
        '["alpha","LOW"]',
        '["alpha", "low"]',
        '{"model":"alpha","effort":"low"}'
    ]) {
        assert.throws(() => decodeModelEffortValue(value), value);
    }
});

test('encoder and decoder preserve exact aliases without normalization', () => {
    const value = encodeModelEffortValue({ modelAlias: ' 模型/A ', reasoningEffort: '' });
    assert.equal(value, '[" 模型/A ",""]');
    assert.equal(encodeModelEffortValue(decodeModelEffortValue(value)), value);
});
