import type { Config } from 'jest';

const shared: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1'
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
            testPathIgnorePatterns: ['/node_modules/', '/dist/', '/src/tests/ut/search/']
        },
        {
            ...shared,
            displayName: 'search',
            roots: ['<rootDir>/src/tests/ut/search'],
            testMatch: ['<rootDir>/src/tests/ut/search/**/*.test.ts'],
            testPathIgnorePatterns: ['/node_modules/', '/dist/']
        }
    ]
};

export default config;
