import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { DefaultModelConfigPage } from '../../../../../main/tui/components/config/defaultModels.js';
import { setRuntimeLocale } from '../../../../../locale/index.js';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('DefaultModelConfigPage', () => {
    let tempRoot: string;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-default-model-config-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            default_model: 'vision-model',
            default_embedding_model: 'embedding-model',
            default_reranker_model: 'text-model',
            default_vision_model: 'vision-model',
            models: [
                {
                    alias: 'vision-model',
                    model_name: 'gpt-4o',
                    model_type: 'chat'
                },
                {
                    alias: 'text-model',
                    model_name: 'gpt-4',
                    model_type: 'chat'
                },
                {
                    alias: 'embedding-model',
                    model_name: 'text-embedding-3-small',
                    model_type: 'embedding'
                }
            ]
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    test('renders the default vision model setting with only known vision-capable chat models', () => {
        const page = new DefaultModelConfigPage(createTuiMock(), jest.fn());
        const form = (page as unknown as { form: { items: Array<Record<string, unknown>> } }).form;
        const visionField = form.items.find((item) => item.key === 'default_vision_model');

        expect(stripAnsi(page.render(100).join('\n'))).toContain('Default Vision Model: vision-model');
        expect(visionField).toMatchObject({
            type: 'select',
            value: 'vision-model',
            options: ['', 'vision-model']
        });
    });

    test('keeps the default vision model as a select when no configured model supports vision', () => {
        Setting.updateInstanceData({
            ...Setting.getInstance().getData(),
            default_vision_model: '',
            models: [
                {
                    alias: 'text-model',
                    model_name: 'gpt-4',
                    model_type: 'chat'
                }
            ]
        });

        const page = new DefaultModelConfigPage(createTuiMock(), jest.fn());
        const form = (page as unknown as { form: { items: Array<Record<string, unknown>> } }).form;
        const visionField = form.items.find((item) => item.key === 'default_vision_model');

        expect(visionField).toMatchObject({
            type: 'select',
            value: '',
            options: ['']
        });
    });

    test('saves the default vision model together with the existing default model settings', () => {
        const onClose = jest.fn();
        const onConfigChange = jest.fn();
        const page = new DefaultModelConfigPage(createTuiMock(), onClose, onConfigChange);

        (page as unknown as { save: (values: Record<string, unknown>) => void }).save({
            default_model: 'text-model',
            default_embedding_model: 'embedding-model',
            default_reranker_model: 'vision-model',
            default_vision_model: 'vision-model'
        });

        const data = Setting.getInstance().getData();
        expect(data.default_model).toBe('text-model');
        expect(data.default_embedding_model).toBe('embedding-model');
        expect(data.default_reranker_model).toBe('vision-model');
        expect(data.default_vision_model).toBe('vision-model');
        expect(onConfigChange).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
