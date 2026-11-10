/**
 * OpenDesk 框架数据目录（主实例 + 调试实例）沙箱策略回归测试。
 *
 * 主实例与调试实例（OPENDESK_DEBUG_MODE 的 <dir>-debug userData）的数据目录
 * 规则由 opendeskDataDirRules 单一来源构建，Windows policyText 与 Linux/OH
 * policyLinuxTail 共用。本测试固化：
 * - 构建器纯函数行为：trash 写 deny、凭据文件 read ask、整树读写 allow、
 *   主实例写放行粒度（Windows 子目录 / Linux 整树）、-debug 目录防重入；
 * - Windows 接入：虚拟路径映射、readonly 跳过、更具体规则（凭据/trash）排在整树通配之前导出；
 * - Linux 接入：宿主真实路径形态、readonly 跳过、主实例 trash deny。
 */

import picomatch from 'picomatch';
import {
    policyText,
    policyTextLinux,
    opendeskDataDirRules
} from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';
import type { PermissionRule } from '../../../main/aikernel/security/permission.js';

const HOME_WIN = 'C:\\Users\\tester';
const OPENDESK_WIN = 'C:\\Users\\tester\\AppData\\Roaming\\opendesk';
const VIRTUAL_OPENDESK = '/C/Users/tester/AppData/Roaming/opendesk';
const HOME_UNIX = '/home/tester';

function extractRules(text: string): Array<{ path: string; access: string; perm: string }> {
    return text
        .split('[[rules]]')
        .map((block) => block.trim().match(/^path = "([^"]+)"\naccess = "([^"]+)"\nperm = "([^"]+)"/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => ({ path: match[1], access: match[2], perm: match[3] }));
}

function rulesFor(text: string, path: string, access: string): { perm: string } | undefined {
    return extractRules(text).find((rule) => rule.path === path && rule.access === access);
}

describe('opendeskDataDirRules（单一来源构建器）', () => {
    test('主实例（Windows 粒度）：trash 写 deny + 调试实例全规则 + logs/artifacts/tasks 子目录写放行', () => {
        const rules = opendeskDataDirRules(OPENDESK_WIN.replace(/\\/g, '/'), { mainWriteGranularity: 'subdirs' });
        const at = (path: string, action: string) =>
            rules.find((rule) => rule.pathPattern === path && rule.action === action);

        // 更具体规则排在整树通配之前导出（判定按 spec 取优、与位置无关）
        const trashIndex = rules.findIndex(
            (rule) => rule.pathPattern === `${OPENDESK_WIN.replace(/\\/g, '/')}/trash/**`
        );
        const debugCredIndex = rules.findIndex(
            (rule) => rule.pathPattern === `${OPENDESK_WIN.replace(/\\/g, '/')}-debug/setting.json`
        );
        const debugTreeIndex = rules.findIndex(
            (rule) => rule.pathPattern === `${OPENDESK_WIN.replace(/\\/g, '/')}-debug/**`
        );
        expect(trashIndex).toBeGreaterThanOrEqual(0);
        expect(debugTreeIndex).toBeGreaterThanOrEqual(0);
        expect(debugCredIndex).toBeLessThan(debugTreeIndex);

        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}/trash/**`, 'write')?.effect).toBe('deny');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/trash/**`, 'write')?.effect).toBe('deny');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/setting.json`, 'read')?.effect).toBe('ask');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/*.enc`, 'read')?.effect).toBe('ask');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/**/*.enc`, 'read')?.effect).toBe('ask');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/**`, 'write')?.effect).toBe('allow');
        expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}-debug/**`, 'read')?.effect).toBe('allow');
        for (const sub of ['logs', 'artifacts', 'tasks']) {
            expect(at(`${OPENDESK_WIN.replace(/\\/g, '/')}/${sub}/**`, 'write')?.effect).toBe('allow');
        }
    });

    test('主实例（Linux 整树粒度）：整树写放行，不展开子目录', () => {
        const rules = opendeskDataDirRules('/home/tester/.opendesk', { mainWriteGranularity: 'tree' });
        expect(
            rules.find((rule) => rule.pathPattern === '/home/tester/.opendesk/**' && rule.action === 'write')?.effect
        ).toBe('allow');
        expect(rules.some((rule) => rule.pathPattern.includes('/logs/**'))).toBe(false);
    });

    test('dir 已是调试数据目录时跳过调试实例规则（防 -debug-debug 重入）', () => {
        const rules = opendeskDataDirRules('/home/tester/.opendesk-debug', { mainWriteGranularity: 'tree' });
        expect(rules.some((rule) => rule.pathPattern.includes('-debug-debug'))).toBe(false);
        expect(
            rules.find((rule) => rule.pathPattern === '/home/tester/.opendesk-debug/**' && rule.action === 'write')
        ).toBeDefined();
    });

    test('主实例 trash deny 早于主实例整树写 allow（Linux 粒度下顺序成立）', () => {
        const rules: PermissionRule[] = opendeskDataDirRules('/data/od', { mainWriteGranularity: 'tree' });
        const trashIndex = rules.findIndex((rule) => rule.pathPattern === '/data/od/trash/**');
        const treeWriteIndex = rules.findIndex((rule) => rule.pathPattern === '/data/od/**' && rule.action === 'write');
        expect(trashIndex).toBeGreaterThanOrEqual(0);
        expect(trashIndex).toBeLessThan(treeWriteIndex);
    });
});

describe('Windows policyText 接入框架数据目录规则', () => {
    test('standard 模式：调试实例整树读写放行、凭据 read ask、主实例子目录写放行', () => {
        const text = policyText('http://127.0.0.1:1/decide', 'token', undefined, HOME_WIN, OPENDESK_WIN);
        const extracted = extractRules(text);

        for (const sub of ['logs', 'artifacts', 'tasks']) {
            expect(rulesFor(text, `${VIRTUAL_OPENDESK}/${sub}/**`, 'write')?.perm).toBe('allow');
        }
        expect(rulesFor(text, `${VIRTUAL_OPENDESK}-debug/**`, 'write')?.perm).toBe('allow');
        expect(rulesFor(text, `${VIRTUAL_OPENDESK}-debug/**`, 'read')?.perm).toBe('allow');
        for (const pattern of ['setting.json', '*.enc', '**/*.enc']) {
            expect(rulesFor(text, `${VIRTUAL_OPENDESK}-debug/${pattern}`, 'read')?.perm).toBe('ask');
        }
        // 凭据 ask 与 trash deny 排在整树 allow 之前导出（判定按 spec 取优、
        // 与位置无关，这里只固化导出顺序）
        const credIndex = text.indexOf(`path = "${VIRTUAL_OPENDESK}-debug/setting.json"`);
        const trashIndex = text.indexOf(`path = "${VIRTUAL_OPENDESK}-debug/trash/**"`);
        const treeReadIndex = text.indexOf(`path = "${VIRTUAL_OPENDESK}-debug/**"\naccess = "read"`);
        expect(credIndex).toBeLessThan(treeReadIndex);
        expect(trashIndex).toBeLessThan(treeReadIndex);
        expect(extracted.length).toBeGreaterThan(0);
    });

    test('Windows 主实例 trash 写 deny（统一构建器带来的对齐：回收站不可写）', () => {
        const text = policyText('http://127.0.0.1:1/decide', 'token', undefined, HOME_WIN, OPENDESK_WIN);
        expect(rulesFor(text, `${VIRTUAL_OPENDESK}/trash/**`, 'write')?.perm).toBe('deny');
    });

    test('readonly 模式：框架数据目录规则整体跳过（含调试实例）', () => {
        const readonlyRules = [
            { resourceType: 'file' as const, action: 'write' as const, pathPattern: '**', effect: 'deny' as const },
            {
                resourceType: 'file' as const,
                action: 'read' as const,
                pathPattern: 'D:/work/**',
                effect: 'allow' as const
            }
        ];
        const text = policyText('http://127.0.0.1:1/decide', 'token', readonlyRules, HOME_WIN, OPENDESK_WIN);
        expect(text).not.toContain('-debug');
        expect(text).not.toContain(`${VIRTUAL_OPENDESK}/logs`);
    });

    test('Temp 读写对称放行（E2E 回归：node 编译缓存读逐次弹窗）', () => {
        const text = policyText('http://127.0.0.1:1/decide', 'token', undefined, HOME_WIN);
        expect(rulesFor(text, '/C/Users/tester/AppData/Local/Temp/**', 'write')?.perm).toBe('allow');
        expect(rulesFor(text, '/C/Users/tester/AppData/Local/Temp/**', 'read')?.perm).toBe('allow');
        const tempReadIndex = text.indexOf('path = "/C/Users/tester/AppData/Local/Temp/**"\naccess = "read"');
        const fallbackAskIndex = text.indexOf('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(tempReadIndex).toBeLessThan(fallbackAskIndex);
    });
});

describe('Linux policyTextLinux 接入框架数据目录规则', () => {
    test('standard 模式：调试实例整树读写放行、凭据 read ask、主实例整树写放行', () => {
        const text = policyTextLinux(
            'http://127.0.0.1:1/decide',
            't',
            '/home/tester/work',
            undefined,
            HOME_UNIX,
            '/home/tester/.opendesk'
        );
        expect(rulesFor(text, '/home/tester/.opendesk/**', 'write')?.perm).toBe('allow');
        expect(rulesFor(text, '/home/tester/.opendesk-debug/**', 'write')?.perm).toBe('allow');
        expect(rulesFor(text, '/home/tester/.opendesk-debug/**', 'read')?.perm).toBe('allow');
        for (const pattern of ['setting.json', '*.enc', '**/*.enc']) {
            expect(rulesFor(text, `/home/tester/.opendesk-debug/${pattern}`, 'read')?.perm).toBe('ask');
        }
        // 精确文件规则比整树通配更具体（most-specific 下由 spec 决定，与位置无关；
        // 此处只固化导出顺序）
        const credIndex = text.indexOf('path = "/home/tester/.opendesk-debug/setting.json"');
        const treeReadIndex = text.indexOf('path = "/home/tester/.opendesk-debug/**"\naccess = "read"');
        expect(credIndex).toBeLessThan(treeReadIndex);
    });

    test('主实例与调试实例 trash 写 deny', () => {
        const text = policyTextLinux(
            'http://127.0.0.1:1/decide',
            't',
            '/home/tester/work',
            undefined,
            HOME_UNIX,
            '/home/tester/.opendesk'
        );
        expect(rulesFor(text, '/home/tester/.opendesk/trash/**', 'write')?.perm).toBe('deny');
        expect(rulesFor(text, '/home/tester/.opendesk-debug/trash/**', 'write')?.perm).toBe('deny');
    });

    test('readonly 模式：框架数据目录规则整体跳过（不架空全盘写 deny）', () => {
        const readonlyRules = [
            {
                resourceType: 'file' as const,
                action: 'read' as const,
                pathPattern: '/home/tester/work/**',
                effect: 'allow' as const
            },
            { resourceType: 'file' as const, action: 'write' as const, pathPattern: '**', effect: 'deny' as const }
        ];
        const text = policyTextLinux(
            'http://127.0.0.1:1/decide',
            't',
            '/home/tester/work',
            readonlyRules,
            HOME_UNIX,
            '/home/tester/.opendesk'
        );
        expect(text).not.toContain('.opendesk-debug');
        expect(rulesFor(text, '/home/tester/.opendesk/**', 'write')).toBeUndefined();
    });

    test('未传 opendeskDataDir 时按默认布局 ~/.opendesk 推导（含调试实例）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, HOME_UNIX);
        expect(rulesFor(text, '/home/tester/.opendesk/**', 'write')?.perm).toBe('allow');
        expect(rulesFor(text, '/home/tester/.opendesk-debug/**', 'read')?.perm).toBe('allow');
    });
});

describe('凭据 read ask 覆盖数据目录下所有 .enc（通配而非文件名清单）', () => {
    /** 按沙箱的 most-specific 语义求值：spec 最大者胜，同 spec 取 deny > ask > allow
     * （与 native core 的 rule_specificity 一致：剥掉尾部 `/**` 后的前缀长度）。 */
    function bestMatch(rules: PermissionRule[], filePath: string, action: string): string {
        const rank = { deny: 0, ask: 1, allow: 2 } as const;
        const spec = (pattern: string) => (pattern.endsWith('/**') ? pattern.length - 3 : pattern.length);
        let best: { spec: number; effect: PermissionRule['effect'] } | undefined;
        for (const rule of rules) {
            if (rule.action !== action) continue;
            if (!picomatch(rule.pathPattern, { dot: true })(filePath)) continue;
            const current = spec(rule.pathPattern);
            if (!best || current > best.spec || (current === best.spec && rank[rule.effect] < rank[best.effect])) {
                best = { spec: current, effect: rule.effect };
            }
        }
        return best ? best.effect : 'ask';
    }

    // 覆盖根目录顶层与 apps/<bundle>/ 子目录两类落点：adminconsole 令牌已归入
    // apps/adminconsole/，browser 凭据仍在顶层，两者都必须被同一条通配拦住
    const CREDENTIAL_PATHS = [
        'admin-token.enc',
        'browser-credentials.enc',
        'apps/adminconsole/admin-token.enc',
        'apps/browser/browser-credentials.enc'
    ];

    test('调试实例：任意层级的 .enc 都命中 ask，不被整树 read allow 吞掉', () => {
        const rules = opendeskDataDirRules('/home/tester/.opendesk', { mainWriteGranularity: 'tree' });
        for (const rel of CREDENTIAL_PATHS) {
            expect(bestMatch(rules, `/home/tester/.opendesk-debug/${rel}`, 'read')).toBe('ask');
        }
    });

    test('主实例：任意层级的 .enc read 不放通为 allow', () => {
        const rules = opendeskDataDirRules('/home/tester/.opendesk', { mainWriteGranularity: 'tree' });
        for (const rel of CREDENTIAL_PATHS) {
            expect(bestMatch(rules, `/home/tester/.opendesk/${rel}`, 'read')).toBe('ask');
        }
    });

    test('非凭据文件仍由调试实例整树 read allow 放通（Electron 启动 IO 不受影响）', () => {
        const rules = opendeskDataDirRules('/home/tester/.opendesk', { mainWriteGranularity: 'tree' });
        expect(bestMatch(rules, '/home/tester/.opendesk-debug/Cache/index', 'read')).toBe('allow');
        expect(bestMatch(rules, '/home/tester/.opendesk-debug/logs/run.log', 'read')).toBe('allow');
    });
});
