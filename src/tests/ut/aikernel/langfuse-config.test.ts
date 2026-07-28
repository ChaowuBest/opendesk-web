import { resolveLangfuseConfig } from '../../../main/telemetry/langfuse/config.js';
import { Setting, type LangfuseConfig } from '../../../main/utils/setting.js';

function defaultFileConfig(): LangfuseConfig {
    return Setting.getSettingSchema().parse({}).telemetry.langfuse;
}

function fileEndpoint(overrides: Partial<LangfuseConfig['endpoints'][number]> = {}) {
    return {
        name: 'file',
        protocol: 'langfuse' as const,
        enabled: true,
        base_url: 'https://file.langfuse.example.com',
        public_key: 'pk-file',
        secret_key: 'sk-file',
        export_mode: 'batched' as const,
        flush_at: 50,
        flush_interval_seconds: 5,
        ...overrides
    };
}

describe('Langfuse runtime config', () => {
    test('环境变量中的密钥不会在缺少显式启用开关时创建端点', () => {
        const config = resolveLangfuseConfig(defaultFileConfig(), {
            LANGFUSE_PUBLIC_KEY: 'pk-env',
            LANGFUSE_SECRET_KEY: 'sk-env'
        });

        expect(config).toBeUndefined();
    });

    test('LANGFUSE_ENABLED=true 创建独立环境变量端点', () => {
        const config = resolveLangfuseConfig(defaultFileConfig(), {
            LANGFUSE_ENABLED: 'true',
            LANGFUSE_PUBLIC_KEY: 'pk-env',
            LANGFUSE_SECRET_KEY: 'sk-env'
        });

        expect(config?.endpoints).toEqual([
            expect.objectContaining({
                source: 'environment',
                baseUrl: 'https://cloud.langfuse.com',
                publicKey: 'pk-env',
                secretKey: 'sk-env'
            })
        ]);
    });

    test('LANGFUSE_ENABLED=false 不会关闭已启用的配置文件端点', () => {
        const fileConfig = {
            ...defaultFileConfig(),
            endpoints: [fileEndpoint()]
        };

        expect(resolveLangfuseConfig(fileConfig, { LANGFUSE_ENABLED: 'false' })?.endpoints).toEqual([
            expect.objectContaining({
                source: 'file',
                publicKey: 'pk-file'
            })
        ]);
    });

    test('环境变量端点与多个配置文件端点同时生效且互不拼接字段', () => {
        const fileConfig = {
            ...defaultFileConfig(),
            environment: 'staging',
            endpoints: [
                fileEndpoint(),
                fileEndpoint({
                    name: 'second',
                    base_url: '',
                    public_key: 'pk-second',
                    secret_key: 'sk-second',
                    export_mode: 'immediate',
                    flush_at: 10,
                    flush_interval_seconds: 2
                })
            ]
        };
        const config = resolveLangfuseConfig(fileConfig, {
            LANGFUSE_ENABLED: 'true',
            LANGFUSE_PUBLIC_KEY: 'pk-env',
            LANGFUSE_SECRET_KEY: 'sk-env',
            LANGFUSE_BASE_URL: 'https://env.langfuse.example.com/',
            LANGFUSE_TRACING_ENVIRONMENT: 'production',
            LANGFUSE_MAX_PAYLOAD_CHARS: '10000',
            LANGFUSE_FLUSH_AT: '20',
            LANGFUSE_FLUSH_INTERVAL: '3',
            LANGFUSE_EXPORT_MODE: 'immediate'
        });

        expect(config).toEqual({
            enabled: true,
            environment: 'production',
            maxPayloadChars: 10_000,
            endpoints: [
                {
                    name: 'file',
                    source: 'file',
                    baseUrl: 'https://file.langfuse.example.com',
                    publicKey: 'pk-file',
                    secretKey: 'sk-file',
                    flushAt: 50,
                    flushInterval: 5,
                    exportMode: 'batched'
                },
                {
                    name: 'second',
                    source: 'file',
                    baseUrl: 'https://cloud.langfuse.com',
                    publicKey: 'pk-second',
                    secretKey: 'sk-second',
                    flushAt: 10,
                    flushInterval: 2,
                    exportMode: 'immediate'
                },
                {
                    name: 'environment',
                    source: 'environment',
                    baseUrl: 'https://env.langfuse.example.com',
                    publicKey: 'pk-env',
                    secretKey: 'sk-env',
                    flushAt: 20,
                    flushInterval: 3,
                    exportMode: 'immediate'
                }
            ]
        });
    });

    test('禁用或缺少密钥的配置文件端点不会初始化', () => {
        const fileConfig = {
            ...defaultFileConfig(),
            endpoints: [fileEndpoint({ enabled: false }), fileEndpoint({ name: 'missing-secret', secret_key: '' })]
        };

        expect(resolveLangfuseConfig(fileConfig, {})).toBeUndefined();
    });

    test('相同 Base URL 和 Public Key 的文件与环境变量端点只上报一次', () => {
        const fileConfig = {
            ...defaultFileConfig(),
            endpoints: [fileEndpoint()]
        };
        const config = resolveLangfuseConfig(fileConfig, {
            LANGFUSE_ENABLED: 'true',
            LANGFUSE_BASE_URL: 'https://file.langfuse.example.com/',
            LANGFUSE_PUBLIC_KEY: 'pk-file',
            LANGFUSE_SECRET_KEY: 'sk-env'
        });

        expect(config?.endpoints).toHaveLength(1);
        expect(config?.endpoints[0].source).toBe('file');
    });
});
