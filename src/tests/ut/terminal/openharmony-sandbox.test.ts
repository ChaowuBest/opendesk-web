import { describe, expect, test } from '@jest/globals';
import { policyTextOpenHarmony } from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';

describe('policyTextOpenHarmony', () => {
    test('不含 [[roots]]（OH 版 native 会拒绝 roots），含 [ask] 与 token', () => {
        const text = policyTextOpenHarmony('http://127.0.0.1:1/decide', 'secret-token', '/data/home/work');
        expect(text).not.toContain('[[roots]]');
        expect(text).toContain('[ask]');
        expect(text).toContain('endpoint = "http://127.0.0.1:1/decide"');
        expect(text).toContain('token = "secret-token"');
        expect(text).toContain('default = "deny"');
    });

    test('工作区写放行与兜底规则（真实路径语义；外读 ask 兜底 + 系统路径读放行）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work');
        expect(text).toContain('path = "/data/home/work/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
        // 系统运行时路径读放行（PATH 搜索的 stat 是 read）
        expect(text).toContain('path = "/usr/**"\naccess = "read"\nperm = "allow"');
    });

    test('家目录敏感路径 deny 与工具链缓存写放行（OH 上同样收窄）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home');
        expect(text).toContain('path = "/data/home/.ssh/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/data/home/.gnupg/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/data/home/.cache/opendesk-sandbox/**"\naccess = "write"\nperm = "allow"');
    });

    test('权限规则按真实路径导出、deny 优先于 allow', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/data/home/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '/data/home/secret/**', effect: 'deny' }
        ] as any[];
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', rules, '/data/home');
        const denyIndex = text.indexOf('path = "/data/home/secret/**"');
        const allowIndex = text.indexOf('path = "/data/home/work/**"');
        expect(denyIndex).toBeGreaterThanOrEqual(0);
        expect(allowIndex).toBeGreaterThan(denyIndex);
    });

    test('writableDirs（temp/cache）写放行规则位于兜底 write ask 之前', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home', [
            '/data/storage/el2/temp',
            '/data/storage/el2/cache'
        ]);
        const tempRule = 'path = "/data/storage/el2/temp/**"\naccess = "write"\nperm = "allow"';
        const cacheRule = 'path = "/data/storage/el2/cache/**"\naccess = "write"\nperm = "allow"';
        expect(text).toContain(tempRule);
        expect(text).toContain(cacheRule);
        // 顺序：可写目录规则必须早于兜底 /** write ask（first-match 才生效）
        const tempIdx = text.indexOf('path = "/data/storage/el2/temp/**"');
        const askIdx = text.indexOf('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(tempIdx).toBeGreaterThanOrEqual(0);
        expect(askIdx).toBeGreaterThan(tempIdx);
        expect(text).not.toContain('[[roots]]');
    });
});
