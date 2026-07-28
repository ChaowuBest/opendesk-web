import { jest } from '@jest/globals';
import { setRuntimeLocale } from '../../../../../locale/index.js';
import { TelemetryConfigPage } from '../../../../../main/tui/components/config/telemetryConfig.js';
import { Setting } from '../../../../../main/utils/setting.js';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

describe('TelemetryConfigPage', () => {
    beforeEach(() => {
        setRuntimeLocale('en-US');
        Setting.clearCache();
        Setting.updateInstanceData({
            telemetry: {
                opentelemetry: {
                    endpoints: [
                        {
                            name: 'local',
                            url: 'http://localhost:4318/v1/traces',
                            protocol: 'opentelemetry',
                            enabled: true
                        }
                    ]
                },
                langfuse: {
                    endpoints: [
                        {
                            name: 'cloud',
                            protocol: 'langfuse',
                            enabled: true,
                            base_url: 'https://langfuse.example.com',
                            public_key: 'pk-test',
                            secret_key: 'sk-test',
                            export_mode: 'batched',
                            flush_at: 50,
                            flush_interval_seconds: 5
                        }
                    ],
                    environment: 'test',
                    max_payload_chars: 20_000
                }
            }
        });
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
    });

    test('shows OpenTelemetry and Langfuse endpoints in one list', () => {
        const page = new TelemetryConfigPage(createTuiMock(), jest.fn());

        const text = page.render(100).join('\n');

        expect(text).toContain('OpenTelemetry');
        expect(text).toContain('Langfuse');
        expect(text).toContain('local');
        expect(text).toContain('cloud');
    });

    test('opens a Langfuse endpoint form with protocol-specific reporting settings', () => {
        const page = new TelemetryConfigPage(createTuiMock(), jest.fn()) as any;
        page.list.onSelect({ value: 'langfuse:0' });

        const text = page.render(100).join('\n');

        expect(text).toContain('Protocol');
        expect(text).toContain('Service URL');
        expect(text).toContain('Public Key');
        expect(text).toContain('Secret Key');
        expect(text).toContain('Export Mode');
        expect(text).toContain('Flush Interval');
    });

    test('new endpoint form switches visible fields when protocol changes', () => {
        const page = new TelemetryConfigPage(createTuiMock(), jest.fn()) as any;
        page.list.onSelect({ value: '__add__' });

        expect(page.render(100).join('\n')).toContain('Endpoint URL');
        page.updateProtocolFieldVisibility('langfuse');

        const text = page.render(100).join('\n');
        expect(text).not.toContain('Endpoint URL');
        expect(text).toContain('Public Key');
    });
});
