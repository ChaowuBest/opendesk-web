import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { ProviderConfigPage } from '../../../../../main/tui/components/config/providers.js';
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

describe('ProviderConfigPage', () => {
    let tempRoot: string;
    let tui: ReturnType<typeof createTuiMock>;

    beforeEach(() => {
        setRuntimeLocale('en-US');
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-provider-config-'));
        setCustomOpendeskDirectory(tempRoot);
        Setting.clearCache();
        Setting.updateInstanceData({
            providers: [{ name: 'openai' }],
            models: [{ alias: 'gpt-4o', provider_name: 'openai', model_name: 'gpt-4o', model_type: 'chat' }]
        });
        tui = createTuiMock();
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    function openPage() {
        const page = new ProviderConfigPage(tui, jest.fn());
        (page as unknown as { showEditForm: (p: Record<string, any>) => void }).showEditForm({
            name: '',
            provider_type: 'openai',
            base_url: '',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });
        return page;
    }

    function saveProvider(page: ProviderConfigPage, values: Record<string, any>) {
        (page as unknown as { saveProvider: (v: Record<string, any>) => void }).saveProvider(values);
    }

    test('rejects a duplicate provider name without saving', () => {
        const page = openPage();

        saveProvider(page, {
            name: 'openai',
            provider_type: 'openai',
            base_url: 'https://example.com/v1',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.providers).toHaveLength(1);
        expect(tui.requestRender).toHaveBeenCalled();
        expect(stripAnsi(page.render(100).join('\n'))).toContain('Provider name already exists');
    });

    test('allows editing a provider keeping the same name', () => {
        const page = new ProviderConfigPage(tui, jest.fn());
        (page as unknown as { editingIndex: number }).editingIndex = 0;
        (page as unknown as { showEditForm: (p: Record<string, any>) => void }).showEditForm({
            name: 'openai',
            provider_type: 'openai',
            base_url: '',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });

        saveProvider(page, {
            name: 'openai',
            provider_type: 'openai',
            base_url: 'https://new.example.com/v1',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.providers).toHaveLength(1);
        expect(data.providers[0].base_url).toBe('https://new.example.com/v1');
    });

    test('renaming a provider updates provider_name in all associated models', () => {
        const page = new ProviderConfigPage(tui, jest.fn());
        (page as unknown as { editingIndex: number }).editingIndex = 0;
        (page as unknown as { showEditForm: (p: Record<string, any>) => void }).showEditForm({
            name: 'openai',
            provider_type: 'openai',
            base_url: '',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });

        saveProvider(page, {
            name: 'openai-pro',
            provider_type: 'openai',
            base_url: 'https://example.com/v1',
            api_key: '',
            no_proxy: false,
            no_ssl: false
        });

        const data = Setting.getInstance().getData() as any;
        expect(data.providers[0].name).toBe('openai-pro');
        expect(data.models[0].provider_name).toBe('openai-pro');
    });
});
