import type { Config } from 'jest';

const shared: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^.+\\.css(?:\\?raw)?$': '<rootDir>/src/tests/ut/__mocks__/raw-style.ts',
        // 内置插件源码按裸包名引入 SDK；测试环境直接解析到 SDK 源码，避免依赖构建产物
        '^@bitclub\\.ai/opendesk-plugin-sdk$': '<rootDir>/packages/plugin-sdk/src/index.ts',
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@earendil-works/pi-tui$': '<rootDir>/src/tests/ut/search/__mocks__/pi-tui-mock.ts'
    },
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                useESM: true,
                diagnostics: false,
                tsconfig: {
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    target: 'ES2022',
                    esModuleInterop: true,
                    isolatedModules: true,
                    allowImportingTsExtensions: true,
                    strict: false,
                    skipLibCheck: true,
                    noEmit: true,
                    resolveJsonModule: true,
                    declaration: false,
                    types: ['jest']
                }
            }
        ]
    }
};

const config: Config = {
    projects: [
        {
            ...shared,
            displayName: 'unit',
            roots: ['<rootDir>/src/tests'],
            testMatch: ['<rootDir>/src/tests/ut/**/*.test.ts'],
            testPathIgnorePatterns: [
                '/node_modules/',
                '/dist/',
                '/src/tests/ut/search/',
                '/src/tests/ut/node/',
                '/src/tests/ut/devicemgr/node-headless-e2e.test.ts'
            ]
        },
        {
            ...shared,
            displayName: 'search',
            roots: ['<rootDir>/src/tests/ut/search'],
            testMatch: ['<rootDir>/src/tests/ut/search/**/*.test.ts'],
            testPathIgnorePatterns: ['/node_modules/', '/dist/']
        },
        {
            ...shared,
            displayName: 'embedBrowserUse',
            roots: ['<rootDir>/src/common/embedBrowserUse'],
            testMatch: ['<rootDir>/src/common/embedBrowserUse/__tests__/**/*.test.ts'],
            testPathIgnorePatterns: ['/node_modules/', '/dist/']
        }
    ]
};

export default config;
