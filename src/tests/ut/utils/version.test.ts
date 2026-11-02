import fs from 'node:fs';
import path from 'node:path';
import {
    OPENDESK_RUNTIME_VERSION,
    compareVersion,
    isNewerVersion,
    isValidVersion,
    normalizeVersion
} from '../../../main/utils/version';

describe('version utils', () => {
    test('宿主版本号与 package.json 保持同步', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')) as { version: string };
        expect(OPENDESK_RUNTIME_VERSION).toBe(packageJson.version);
    });

    test('只接受完整的三段式 SemVer', () => {
        expect(isValidVersion('1.0.0')).toBe(true);
        expect(isValidVersion('0.3.10')).toBe(true);
        expect(isValidVersion('1.2.3-beta.1')).toBe(true);
        // semver 默认放宽 `v` 前缀与首尾空白
        expect(isValidVersion('v1.2.3')).toBe(true);
        expect(isValidVersion(' 1.2.3 ')).toBe(true);

        expect(isValidVersion('1.0')).toBe(false);
        expect(isValidVersion('2024-09')).toBe(false);
        expect(isValidVersion('latest')).toBe(false);
        expect(isValidVersion('')).toBe(false);
        expect(isValidVersion(undefined)).toBe(false);
        expect(isValidVersion(null)).toBe(false);
    });

    test('normalizeVersion 归一化版本号，无法解析时返回 undefined', () => {
        expect(normalizeVersion('1.2.3')).toBe('1.2.3');
        // 历史数据里的两段式写法补齐 PATCH
        expect(normalizeVersion('0.2')).toBe('0.2.0');
        expect(normalizeVersion(' v1.2.3 ')).toBe('1.2.3');
        expect(normalizeVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
        expect(normalizeVersion('2024-09')).toBeUndefined();
        expect(normalizeVersion('')).toBeUndefined();
        expect(normalizeVersion(undefined)).toBeUndefined();
    });

    test('按 SemVer 优先级比较，预发布低于正式版', () => {
        expect(compareVersion('1.0.0', '1.0.0')).toBe(0);
        expect(compareVersion('1.0.0', '1.1.0')).toBe(-1);
        expect(compareVersion('1.10.0', '1.9.0')).toBe(1);
        expect(compareVersion('1.2.3-beta', '1.2.3')).toBe(-1);
        expect(compareVersion('1.2.3-alpha', '1.2.3-beta')).toBe(-1);
        // 构建元数据不参与优先级
        expect(compareVersion('1.2.3+build.5', '1.2.3')).toBe(0);
        // v 前缀归一化后相等
        expect(compareVersion('v1.2.3', '1.2.3')).toBe(0);
    });

    test('任一方不合法时比较返回 undefined', () => {
        expect(compareVersion('1.0', '1.0.0')).toBeUndefined();
        expect(compareVersion('1.0.0', '2024-09')).toBeUndefined();
        expect(compareVersion('', '1.0.0')).toBeUndefined();
    });

    test('isNewerVersion 只认严格更新，且容忍本地是预发布/开发版本', () => {
        expect(isNewerVersion('0.3.11', '0.3.10')).toBe(true);
        expect(isNewerVersion('0.3.10', '0.3.10')).toBe(false);
        // 远端落后于本地（回滚、手动装了更高版本）时不能提示升级：那实际上是一次降级
        expect(isNewerVersion('0.3.9', '0.3.10')).toBe(false);
        // 本地是预发布/开发构建时，同号正式版算更新（设置界面「检查更新」依赖这一点）
        expect(isNewerVersion('0.3.10', '0.3.10-beta.1')).toBe(true);
        expect(isNewerVersion('0.3.10', '0.0.0-dev')).toBe(true);
        // 构建元数据不参与优先级
        expect(isNewerVersion('0.3.10', '0.3.10+build.7')).toBe(false);
    });

    test('isNewerVersion 在版本号缺失或不可解析时不抛错', () => {
        expect(isNewerVersion(null, '0.3.10')).toBe(false);
        expect(isNewerVersion('0.3.11', null)).toBe(false);
        expect(isNewerVersion(undefined, undefined)).toBe(false);
        // 非 SemVer 的 dist-tag：退化为字符串比较，宁可多提示也不漏更新
        expect(isNewerVersion('latest', '0.3.10')).toBe(true);
        expect(isNewerVersion('latest', 'latest')).toBe(false);
    });
});
