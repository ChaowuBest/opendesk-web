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
    test('roots 使用整根视图（virtual=real=/）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        expect(text).toContain('virtual = "/"');
        expect(text).toContain('real    = "/"');
        // 工作区写放行规则
        expect(text).toContain('path = "/home/liyi/work/**"\naccess = "write"\nperm = "allow"');
    });
    test('家目录敏感路径读 deny（整根读放行兜底下的收窄）', () => {
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
    test('兜底规则：读放行、写询问、执行放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/liyi/work');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
    });
});
