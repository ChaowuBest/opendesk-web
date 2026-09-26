import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectToolchainReadOnlyDirs } from '../../../main/applications/terminal/sandboxes/linux-sandbox.js';

describe('detectToolchainReadOnlyDirs', () => {
    test('从 PATH 解析已有工具二进制所在目录并去重', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-toolchain-test-'));
        try {
            const binA = path.join(tmp, 'binA');
            const binB = path.join(tmp, 'binB');
            fs.mkdirSync(binA, { recursive: true });
            fs.mkdirSync(binB, { recursive: true });
            // 假工具：PATH 里两个目录各自放一个，同一目录出现两次工具应去重
            fs.writeFileSync(path.join(binA, 'node'), '#!/bin/sh\n');
            fs.writeFileSync(path.join(binA, 'npm'), '#!/bin/sh\n');
            fs.writeFileSync(path.join(binB, 'cargo'), '#!/bin/sh\n');
            fs.chmodSync(path.join(binA, 'node'), 0o755);
            fs.chmodSync(path.join(binA, 'npm'), 0o755);
            fs.chmodSync(path.join(binB, 'cargo'), 0o755);
            const dirs = detectToolchainReadOnlyDirs({ PATH: `${binA}:${binB}:/nonexistent`, HOME: tmp });
            expect(dirs).toContain(path.resolve(binA));
            expect(dirs).toContain(path.resolve(binB));
            // 去重：binA 只出现一次
            expect(dirs.filter((d) => d === path.resolve(binA))).toHaveLength(1);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('不存在的工具目录被过滤', () => {
        const dirs = detectToolchainReadOnlyDirs({
            PATH: '/definitely-not-exist-xyz/usr/bin',
            HOME: '/definitely-not-exist-home'
        });
        expect(dirs).toEqual([]);
    });
});
