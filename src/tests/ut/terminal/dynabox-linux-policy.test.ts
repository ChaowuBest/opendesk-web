import { describe, expect, test } from '@jest/globals';
import {
    hostPatternToVirtualLinux,
    permissionRulesForSandboxLinux,
    policyTextLinux
} from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';

describe('hostPatternToVirtualLinux', () => {
    test('透明路径恒等（保留宿主真实路径）', () => {
        expect(hostPatternToVirtualLinux('/home/liyi/work')).toBe('/home/liyi/work');
        expect(hostPatternToVirtualLinux('**')).toBe('/**');
    });
    test('相对路径（无 / 前缀）返回 null：避免导出非法 path 导致策略加载失败', () => {
        expect(hostPatternToVirtualLinux('src/**')).toBeNull();
        expect(hostPatternToVirtualLinux('foo/bar')).toBeNull();
    });
    test('相对路径规则被跳过（不会出现在导出的策略中）', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: 'src/**', effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: '/home/liyi/work/**', effect: 'allow' }
        ] as any[];
        const lines = permissionRulesForSandboxLinux(rules).join('\n');
        expect(lines).toContain('/home/liyi/work/**');
        expect(lines).not.toContain('src/**');
    });
});

describe('policyTextLinux', () => {
    test('LD_PRELOAD 版不含 [[roots]]（身份命名空间，无路径映射）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        expect(text).not.toContain('[[roots]]');
        expect(text).not.toContain('virtual = "/"');
        // 规则 path 直接用宿主真实路径
        expect(text).toContain('path = "/home/liyi/work/**"\naccess = "write"\nperm = "allow"');
    });
    test('全盘 write deny（readonly 模式）：不追加工作区 write allow、外读兜底改为 deny、temp 读写放行', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/liyi/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', rules);
        // 全盘 write deny 规则在位（** 经 hostPatternToVirtualLinux 映射为 /**）
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "deny"');
        // 工作区 write allow 被跳过（否则 most-specific 下顶掉全盘 deny，readonly 写保护失效）
        expect(text).not.toContain('path = "/home/liyi/work/**"\naccess = "write"\nperm = "allow"');
        // 非 write 的用户规则仍导出
        expect(text).toContain('path = "/home/liyi/work/**"\naccess = "read"\nperm = "allow"');
        // 外读兜底改为 deny（readonly 不弹窗外读：工作区外读写全部拒绝）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "deny"');
        // 临时目录读写放行（shell 管道/heredoc 必需；泛化清单）
        expect(text).toContain('path = "/tmp/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/tmp/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/private/var/folders/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/dev/shm/**"\naccess = "write"\nperm = "allow"');
    });
    test('临时目录读写放行（非 readonly 也生效：管道/heredoc/编译器落盘区泛化清单）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        for (const p of ['/tmp/**', '/var/tmp/**', '/private/var/tmp/**', '/private/var/folders/**', '/dev/shm/**']) {
            expect(text).toContain(`path = "${p}"\naccess = "write"\nperm = "allow"`);
            expect(text).toContain(`path = "${p}"\naccess = "read"\nperm = "allow"`);
        }
    });
    test('standard（无全盘 read allow 规则）：外读兜底为 ask（"工作空间外需确认"）+ 系统路径/shell rc/temp 读放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', undefined, '/home/liyi');
        if (!text.includes('.zshenv')) {
            console.log(
                '[DUMP] zshenv missing; all paths:\n' +
                    text
                        .split('\n')
                        .filter((l) => l.startsWith('path = '))
                        .join('\n')
            );
        }
        // 兜底 ask（外读需确认的落实）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        // 系统运行时路径读放行（PATH 搜索的 stat 是 read，全盘 ask 会让 shell 不可用）
        expect(text).toContain('path = "/usr/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/bin/**"\naccess = "read"\nperm = "allow"');
        // shell rc 文件读放行
        expect(text).toContain('path = "/home/liyi/.zshenv"\naccess = "read"\nperm = "allow"');
        // temp 读放行
        expect(text).toContain('path = "/tmp/**"\naccess = "read"\nperm = "allow"');
        // git 凭据/配置规则已迁移至 security/policies/git.ts（app 策略注入引擎），
        // 沙箱文本由 enforcer.getRules() 导出（回归见 ut/aikernel/app-policies.test.ts）；
        // 无 home 传入时（本用例未传）不含 git 规则。
    });
    test('系统运行时读前缀补全：/system、/lib32、/sys、/proc、/data/service（回归：启动探测路径触发 ask 风暴）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        // 与 OH 版共用同一清单：进程启动时系统库必读这些路径；缺失则每次 spawn
        // 都对 /system 等触发一次 ask（兜底 ask 不缓存），命令异常缓慢
        for (const prefix of ['/system', '/sys', '/proc', '/data/service', '/lib32']) {
            expect(text).toContain(`path = "${prefix}/**"\naccess = "read"\nperm = "allow"`);
            expect(text).toContain(`path = "${prefix}"\naccess = "read"\nperm = "allow"`);
        }
    });

    test('solo/unlimited（用户含全盘 read allow）：读/写兜底均为 allow（同长平局 ask 会架空全放行语义）', () => {
        const soloRules = [
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' },
            { resourceType: 'file', action: 'execute', pathPattern: '**', effect: 'allow' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', soloRules);
        // 读/写兜底 allow（不是 ask）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "allow"');
        expect(text).not.toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "allow"');
        expect(text).not.toContain('path = "/**"\naccess = "write"\nperm = "ask"');
    });
    test('家目录敏感路径读 deny（默认读放行兜底下的收窄）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', undefined, '/home/liyi');
        expect(text).toContain('path = "/home/liyi/.ssh/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/home/liyi/.aws/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/home/liyi/.gnupg/**"\naccess = "read"\nperm = "deny"');
    });
    test('工具链缓存目录（~/.cache/opendesk-sandbox）写入放行（与 linux-sandbox env 重定向一致）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', undefined, '/home/liyi');
        expect(text).toContain('path = "/home/liyi/.cache/opendesk-sandbox/**"\naccess = "write"\nperm = "allow"');
    });
    test('.gitconfig 写放行规则完整（回归：曾含字面 ... 且缺 access/perm 导致策略解析失败）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work', undefined, '/home/liyi');
        expect(text).toContain('path = "/home/liyi/.gitconfig"\naccess = "write"\nperm = "allow"');
        expect(text).not.toContain('...');
        // 生成的策略不应出现"只有 path 无 access/perm"的残缺规则
        for (const line of text.split('\n').filter((l) => l.startsWith('path = '))) {
            const idx = text.indexOf(line);
            const block = text.slice(idx, idx + 200);
            expect(block).toMatch(/access = ".+"/);
            expect(block).toMatch(/perm = ".+"/);
        }
    });
    test('权限规则按真实路径导出、deny 优先、execute 不导出', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/liyi/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '/home/liyi/secret/**', effect: 'deny' },
            { resourceType: 'file', action: 'execute', pathPattern: '/home/liyi/tools/**', effect: 'deny' }
        ] as any[];
        const lines = permissionRulesForSandboxLinux(rules).join('\n');
        const denyIndex = lines.indexOf('path = "/home/liyi/secret/**"');
        const allowIndex = lines.indexOf('path = "/home/liyi/work/**"');
        expect(denyIndex).toBeGreaterThanOrEqual(0);
        expect(allowIndex).toBeGreaterThan(denyIndex);
        expect(lines).not.toContain('"execute"');
    });
    test('兜底规则：读询问（standard 外读确认）、写询问、执行放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
    });
});
