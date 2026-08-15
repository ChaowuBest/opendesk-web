import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { ModelConfigPage } from '../../../../../main/tui/components/config/models.js';
import { setRuntimeLocale } from '../../../../../locale/index.js';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

function createOpenDeskTUI() {
    const tui = createTuiMock();
    return {
        tui,
        inputArea: { showPromptWidget: jest.fn() },
        hasOpenOverlay: false,
        deferInputPromptIfBlockedByMode: jest.fn(() => false)
    } as any;
}

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function getFormItems(page: ModelConfigPage): Array<Record<string, any>> {
    return (page as unknown as { form: { items: Array<Record<string, any>> } }).form.items;
}

describe('ModelConfigPage', () => {
    let tempRoot: string;
    let openDeskTUI: ReturnType<typeof createOpenDeskTUI>;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-model-config-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            models: [],
            providers: [{ name: 'provider-a' }]
        });
        openDeskTUI = createOpenDeskTUI();
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function openEditForm(model: Record<string, any>) {
        const page = new ModelConfigPage(openDeskTUI, jest.fn());
        (page as unknown as { editingIndex: number }).editingIndex = -1;
        (page as unknown as { showEditForm: (m: Record<string, any>) => void }).showEditForm(model);
        return page;
    }

    test('renders the max output tokens field for chat models', () => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        const items = getFormItems(page);
        const maxField = items.find((item) => item.key === 'max_output_tokens');

        expect(maxField).toBeDefined();
        expect(maxField.type).toBe('text');
        expect(stripAnsi(page.render(100).join('\n'))).toContain('Max Output Tokens (leave empty for auto)');
    });

    test('renders the vision support field for chat models with three options', () => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        const items = getFormItems(page);
        const visionField = items.find((item) => item.key === 'vision');

        expect(visionField).toBeDefined();
        expect(visionField.type).toBe('select');
        expect(visionField.options).toEqual(['', 'true', 'false']);
        expect(stripAnsi(page.render(100).join('\n'))).toContain('Vision Support');
    });

    test('hides context length, max output tokens, and vision fields for embedding models', () => {
        const page = openEditForm({
            alias: '',
            provider_name: 'provider-a',
            model_name: '',
            model_type: 'embedding'
        });

        const items = getFormItems(page);
        expect(items.find((item) => item.key === 'context_length')?.visible).toBe(false);
        expect(items.find((item) => item.key === 'max_output_tokens')?.visible).toBe(false);
        expect(items.find((item) => item.key === 'vision')?.visible).toBe(false);
    });

    test('saves max_output_tokens together with the model', () => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'my-model',
            provider_name: 'provider-a',
            model_name: 'gpt-4o',
            model_type: 'chat',
            reasoning_effort: '',
            context_length: '128000',
            max_output_tokens: '16384',
            auto_parse_think_tags: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.models).toHaveLength(1);
        expect(data.models[0]).toMatchObject({
            alias: 'my-model',
            model_name: 'gpt-4o',
            context_length: 128000,
            max_output_tokens: 16384
        });
    });

    test('does not save max_output_tokens for embedding models', () => {
        const page = openEditForm({
            alias: '',
            provider_name: 'provider-a',
            model_name: '',
            model_type: 'embedding'
        });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'embed',
            provider_name: 'provider-a',
            model_name: 'text-embedding-3-small',
            model_type: 'embedding',
            reasoning_effort: '',
            context_length: '128000',
            max_output_tokens: '16384',
            auto_parse_think_tags: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.models[0].context_length).toBeUndefined();
        expect(data.models[0].max_output_tokens).toBeUndefined();
    });

    test('rejects an invalid max_output_tokens and does not save', () => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'my-model',
            provider_name: 'provider-a',
            model_name: 'gpt-4o',
            model_type: 'chat',
            reasoning_effort: '',
            context_length: '',
            max_output_tokens: '-5',
            auto_parse_think_tags: false
        });

        expect(openDeskTUI.inputArea.showPromptWidget).toHaveBeenCalled();
        const data = Setting.getInstance().getData() as any;
        expect(data.models).toHaveLength(0);
    });

    test.each(['1.5', '16k', '9007199254740992'])('rejects non-integer max_output_tokens %s', (value) => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'my-model',
            provider_name: 'provider-a',
            model_name: 'gpt-4o',
            model_type: 'chat',
            reasoning_effort: '',
            context_length: '',
            max_output_tokens: value,
            auto_parse_think_tags: false
        });

        expect(openDeskTUI.inputArea.showPromptWidget).toHaveBeenCalled();
        expect((Setting.getInstance().getData() as any).models).toHaveLength(0);
    });

    test('leaves context length and max output tokens unset when saved empty', () => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'auto-model',
            provider_name: 'provider-a',
            model_name: 'gpt-4o',
            model_type: 'chat',
            reasoning_effort: '',
            context_length: '',
            max_output_tokens: '',
            auto_parse_think_tags: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.models[0].context_length).toBeUndefined();
        expect(data.models[0].max_output_tokens).toBeUndefined();
    });

    test.each([
        ['true', true],
        ['false', false],
        ['', undefined]
    ])('saves vision value "%s" as %s', (raw, expected) => {
        const page = openEditForm({ alias: '', provider_name: 'provider-a', model_name: '', model_type: 'chat' });

        (page as unknown as { saveModel: (values: Record<string, any>) => void }).saveModel({
            alias: 'vision-model',
            provider_name: 'provider-a',
            model_name: 'gpt-4o',
            model_type: 'chat',
            reasoning_effort: '',
            context_length: '',
            max_output_tokens: '',
            vision: raw,
            auto_parse_think_tags: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.models).toHaveLength(1);
        expect(data.models[0].vision).toBe(expected);
    });
});
