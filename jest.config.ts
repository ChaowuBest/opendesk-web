import type { Config } from 'jest';

const config: Config = {
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
    },
    testMatch: ['<rootDir>/src/tests/ut/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    roots: ['<rootDir>/src/tests']
};

export default config;
