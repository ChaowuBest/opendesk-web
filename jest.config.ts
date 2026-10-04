/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import type { Config } from 'jest';

// jest 需要 Node 启动时携带 --experimental-vm-modules 才能执行 ESM（default-esm 预设
// 及 src/main 下的原生 .js ESM 源码都依赖它）。npm test 已显式携带该 flag；
// 为让 `npx jest` 等绕过 npm script 的直接调用也能工作，检测到 flag 缺失时
// 以相同参数重启一次 jest：透传 execArgv（保留 IDE 调试用的 --inspect 类 flag）、
// 原样透传命令行参数与退出码，guard 环境变量防止递归。
const vmModulesEnabled = typeof vm.SourceTextModule === 'function';
const invokedAsJestCli = process.argv[1]?.endsWith('jest.js') ?? false;
if (!vmModulesEnabled && invokedAsJestCli && !process.env.OPENDESK_JEST_ESM_REEXEC) {
    const result = spawnSync(
        process.execPath,
        [...process.execArgv, '--experimental-vm-modules', ...process.argv.slice(1)],
        {
            stdio: 'inherit',
            env: { ...process.env, OPENDESK_JEST_ESM_REEXEC: '1' }
        }
    );
    process.exit(result.status ?? 1);
}

const shared: Config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    // 每个测试文件加载前将 OpenDesk 数据目录重定向到一次性临时目录，
    // 防止测试把任务/设置/日志写进真实用户数据（详见 src/tests/test-env.ts）
    setupFiles: ['<rootDir>/src/tests/test-env.ts'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        // ?inline / ?raw 后缀（如 ace.css?inline）与裸 .css 一样映射为占位样式文本
        '^.+\\.css(?:\\?raw|\\?inline)?$': '<rootDir>/src/tests/ut/__mocks__/raw-style.ts',
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
