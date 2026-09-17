import fs from 'fs';
import { describe, expect, test } from '@jest/globals';
import { zhCn } from '../../../locale/zh-cn.js';
import { enUs } from '../../../locale/en-us.js';

/**
 * 守卫：renderer（entry.ts）引用的每个本地化键必须同时满足
 *  1) 出现在主进程 getLocalizedStrings 的白名单里（否则真实应用显示原始键名）；
 *  2) 在 zh-CN 与 en-US 文案表中都存在。
 * 背景：getLocalizedStrings 只回传白名单键，而视觉验收 harness 返回全量表，
 * 会掩盖白名单缺键的问题（第六轮 staffPanelTitle 等 10 键、第十一轮
 * deleteMessage 等 6 键均因此漏网，故设负向控制证明检测器有效）。
 */
describe('agentoffice renderer localization coverage', () => {
    const entrySource = fs
        .readFileSync(new URL('../../../main/applications/agentoffice/renderer/entry.ts', import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n');
    const appSource = fs.readFileSync(
        new URL('../../../main/applications/agentoffice/app.ts', import.meta.url),
        'utf8'
    );

    function referencedKeys(source: string): string[] {
        const keys = new Set<string>();
        for (const match of source.matchAll(/this\.tr\('([^']+)'\)/g)) keys.add(match[1]);
        for (const match of source.matchAll(/this\.formatText\('([^']+)'\)/g)) keys.add(match[1]);
        return [...keys];
    }

    function whitelistKeys(): string[] {
        const start = appSource.indexOf('getLocalizedStrings(): Record<string, string> {');
        const body = appSource.slice(start, start + 12000);
        return [...body.matchAll(/'(agentoffice\.[^']+)'/g)].map((match) => match[1]);
    }

    function dynamicPrefixes(): string[] {
        return (
            [...entrySource.matchAll(/this\.tr\(`([^`]+)`\)/g)]
                .map((match) => match[1].replace(/\$\{[^}]+\}/g, ''))
                // 退化为裸 "agentoffice." 的前缀会豁免一切缺失键，不参与判定
                .filter((prefix) => prefix !== 'agentoffice.')
        );
    }

    function whitelistHasPrefix(whitelist: Set<string>, prefix: string): boolean {
        for (const key of whitelist) if (key.startsWith(prefix)) return true;
        return false;
    }

    function uncoveredKeys(extra: string[] = []): string[] {
        const whitelist = new Set(whitelistKeys());
        const prefixes = dynamicPrefixes();
        return [...new Set([...referencedKeys(entrySource), ...extra])].filter((key) => {
            if (whitelist.has(key)) return false;
            return !prefixes.some(
                (staticPart) => key.startsWith(staticPart) && whitelistHasPrefix(whitelist, staticPart)
            );
        });
    }

    test('every statically referenced key is served by getLocalizedStrings', () => {
        // 负向控制：故意注入的缺失键必须被抓到，证明检测器本身有效
        const missing = uncoveredKeys(['agentoffice.__guard_negative_control__']);
        expect(missing).toContain('agentoffice.__guard_negative_control__');
        expect(missing.filter((key) => key !== 'agentoffice.__guard_negative_control__')).toEqual([]);
    });

    test('dynamic prefixes used by the renderer stay covered by the whitelist', () => {
        const whitelist = whitelistKeys();
        for (const prefix of ['agentoffice.triggerInterval.', 'agentoffice.taskStatus.', 'agentoffice.taskSource.']) {
            expect(whitelist.some((key) => key.startsWith(prefix))).toBe(true);
        }
    });

    test.each([
        ['zh-CN', zhCn as Record<string, string>],
        ['en-US', enUs as Record<string, string>]
    ])('referenced keys exist in the %s table', (_locale, table) => {
        const missing = referencedKeys(entrySource).filter((key) => !(key in table) || table[key].trim().length === 0);
        expect(missing).toEqual([]);
    });

    test('every whitelisted key exists in both locale tables', () => {
        const missing = whitelistKeys().filter((key) => !(key in zhCn) || !zhCn[key].trim());
        const missingEn = whitelistKeys().filter((key) => !(key in enUs) || !enUs[key].trim());
        expect(missing).toEqual([]);
        expect(missingEn).toEqual([]);
    });
});
