import { describe, expect, test } from '@jest/globals';
import {
    DYNOBOX_POLICY_SERIALIZED_LIMIT,
    estimateDynoboxPolicySerializedSize,
    serializePolicyForSandbox
} from '../../../main/applications/terminal/sandboxes/policy-guard.js';
import { policyTextLinux } from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';
import { GlobPermissionEnforcer, createDefaultPermissionRules } from '../../../main/aikernel/security/enforcer';
import type { PermissionRule } from '../../../main/aikernel/security/permission';

/**
 * 复现 task_mv5ln9r2_4j1q 的"终端输出被异常内容干扰"：
 * dynobox 策略序列化后超过原生 64KB 上限时，launcher fail-closed 拒绝启动，
 * 命令完全不执行，模型只会看到一段 dynobox 报错。守卫必须在宿主侧把策略
 * 裁剪回上限内，而不是把命令送去失败。
 */

describe('estimateDynoboxPolicySerializedSize', () => {
    test('估算不小于明文字节数（安全系数保守取向）', () => {
        const text = 'version = 1\ndefault = "deny"\n';
        const size = estimateDynoboxPolicySerializedSize(text);
        expect(size).toBeGreaterThanOrEqual(text.length);
    });

    test('长路径（path 占比最高）时估算仍不低于 native 真实编码', () => {
        // 最坏膨胀情形：path 占明文绝大部分。native 对每条规则编码
        // `L <b64(path)> <acc> <perm>`，path 经两次 base64 ≈ 16/9 × len(path)；
        // "明文 × 固定系数"的估算会在此处偏小，逐段估算必须覆盖。
        const longPath = `/home/tester/${'d'.repeat(400)}`;
        const text = `version = 1\ndefault = "deny"\n[[rules]]\npath = "${longPath}"\naccess = "read"\nperm = "allow"\n`;
        const pathBytes = Buffer.byteLength(longPath, 'utf8');
        const nativeLowerBound = Math.floor(pathBytes * 1.7);
        expect(estimateDynoboxPolicySerializedSize(text)).toBeGreaterThan(nativeLowerBound);
    });
});

describe('serializePolicyForSandbox', () => {
    test('未超限的策略原样返回（不做任何修改）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(estimateDynoboxPolicySerializedSize(text)).toBeLessThan(DYNOBOX_POLICY_SERIALIZED_LIMIT);
        expect(serializePolicyForSandbox(text)).toBe(text);
    });

    test('超限时裁剪 read allow 规则块，保证序列化体积回到上限内', () => {
        // 构造大量用户目录读规则（模拟 PATH 工具链展开膨胀）
        const pathRules: string[] = [];
        for (let i = 0; i < 1200; i++) {
            pathRules.push(`[[rules]]\npath = "/home/tester/toolchain-${i}/bin"\naccess = "read"\nperm = "allow"`);
            pathRules.push(`[[rules]]\npath = "/home/tester/toolchain-${i}/bin/**"\naccess = "read"\nperm = "allow"`);
        }
        const oversized =
            policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work') + '\n' + pathRules.join('\n') + '\n';
        expect(estimateDynoboxPolicySerializedSize(oversized)).toBeGreaterThanOrEqual(DYNOBOX_POLICY_SERIALIZED_LIMIT);

        const guarded = serializePolicyForSandbox(oversized, { keepPrefixes: ['/home/tester/work'] });
        expect(estimateDynoboxPolicySerializedSize(guarded)).toBeLessThan(DYNOBOX_POLICY_SERIALIZED_LIMIT);
        // 工作区规则必须保留（keepPrefixes 优先级最高）
        expect(guarded).toContain('path = "/home/tester/work/**"\naccess = "write"\nperm = "allow"');
        // [ask] 段与 execute 放行不可被裁剪
        expect(guarded).toContain('[ask]');
        expect(guarded).toContain('access = "execute"\nperm = "allow"');
        // 保留的规则块结构完整（不留空 [[rules]] 残骸）
        expect(guarded).not.toContain('[[rules]]\n\n');
        expect(guarded).not.toContain('[[rules]]\naccess');
    });

    test('write/ask/deny 规则块永不裁剪', () => {
        // 只有不可裁剪块的策略：超限时必须抛错而不是静默破坏语义
        const text = [
            'version = 1',
            'default = "deny"',
            '',
            '[ask]',
            'endpoint = "http://127.0.0.1:1/decide"',
            'token = "t"',
            'timeout_ms = 330000',
            'cache_ttl_seconds = 0',
            'grant_ttl_seconds = 0',
            '',
            '[[rules]]',
            'path = "/**"',
            'access = "write"',
            'perm = "deny"',
            '',
            `[[rules]]\npath = "/filler/${'x'.repeat(80000)}"\naccess = "write"\nperm = "ask"`,
            ''
        ].join('\n');
        expect(() => serializePolicyForSandbox(text)).toThrow();
    });

    test('超限但去重后即可回到上限内：只去重、不裁剪', () => {
        const base = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        const block = '[[rules]]\npath = "/opt/toolchain/bin"\naccess = "read"\nperm = "allow"';
        // 重复同一规则块 2000 次把体积推过上限（逐段估算口径下该块的 native 编码
        // ≈ 35 字节，2000 次 ≈ 70KB > 64KB；旧的固定系数估算只需 800 次）
        const oversized = base + '\n' + Array(2000).fill(block).join('\n') + '\n';
        expect(estimateDynoboxPolicySerializedSize(oversized)).toBeGreaterThanOrEqual(DYNOBOX_POLICY_SERIALIZED_LIMIT);

        const guarded = serializePolicyForSandbox(oversized);
        expect(estimateDynoboxPolicySerializedSize(guarded)).toBeLessThan(DYNOBOX_POLICY_SERIALIZED_LIMIT);
        // 去重后每条块只剩一份
        expect(guarded.split(block).length - 1).toBe(1);
        // 且没有裁掉任何（去重后仍存在的）规则
        expect(guarded).toContain(block);
    });

    test('成对的 X 与 X/** 必须同删，不留"目录可读但内容不可读"的半截规则', () => {
        // 生成侧对 allow 的 X/** 会自动补一条 X（native 尾部 ** 不覆盖目录自身），
        // 两条一起才是完整语义；裁剪只删掉其中一条会让 readonly 模式下的子树
        // 读直接 deny（落到全盘 read deny），而不是"多一次 ask 往返"。
        const pathRules: string[] = [];
        for (let i = 0; i < 1200; i++) {
            pathRules.push(`[[rules]]\npath = "/home/tester/tool-${i}"\naccess = "read"\nperm = "allow"`);
            pathRules.push(`[[rules]]\npath = "/home/tester/tool-${i}/**"\naccess = "read"\nperm = "allow"`);
        }
        const oversized =
            policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work') + '\n' + pathRules.join('\n') + '\n';
        expect(estimateDynoboxPolicySerializedSize(oversized)).toBeGreaterThanOrEqual(DYNOBOX_POLICY_SERIALIZED_LIMIT);

        const guarded = serializePolicyForSandbox(oversized, { keepPrefixes: ['/home/tester/work'] });
        expect(estimateDynoboxPolicySerializedSize(guarded)).toBeLessThan(DYNOBOX_POLICY_SERIALIZED_LIMIT);
        for (let i = 0; i < 1200; i++) {
            const exact = guarded.includes(`path = "/home/tester/tool-${i}"\naccess = "read"\nperm = "allow"`);
            const deep = guarded.includes(`path = "/home/tester/tool-${i}/**"\naccess = "read"\nperm = "allow"`);
            expect(exact).toBe(deep);
        }
    });
});

describe('GlobPermissionEnforcer.addRule 幂等去重', () => {
    test('完全相同的规则重复添加只保留一份（运行期膨胀源头）', async () => {
        const enforcer = await GlobPermissionEnforcer.create([]);
        const rule: PermissionRule = {
            resourceType: 'file',
            action: 'read',
            pathPattern: '/opt/toolchain/**',
            effect: 'allow'
        };
        for (let i = 0; i < 50; i++) {
            await enforcer.addRule(rule);
        }
        expect(enforcer.getRules().length).toBe(1);
        // 语义不变：规则仍然生效
        const result = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/opt/toolchain/bin/node'
        });
        expect(result.effect).toBe('allow');
    });

    test('pathPattern 相同但 effect/action 不同的规则不误伤', async () => {
        const enforcer = await GlobPermissionEnforcer.create([]);
        const read: PermissionRule = {
            resourceType: 'file',
            action: 'read',
            pathPattern: '/data/**',
            effect: 'allow'
        };
        const write: PermissionRule = {
            resourceType: 'file',
            action: 'write',
            pathPattern: '/data/**',
            effect: 'allow'
        };
        const deny: PermissionRule = { resourceType: 'file', action: 'read', pathPattern: '/data/**', effect: 'deny' };
        await enforcer.addRule(read);
        await enforcer.addRule(write);
        await enforcer.addRule(deny);
        expect(enforcer.getRules().length).toBe(3);
        expect((await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/data/a' })).effect).toBe(
            'deny'
        );
        expect((await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/data/a' })).effect).toBe(
            'allow'
        );
    });
});

describe('真实规则集回归（默认策略 + 运行期规则积累）', () => {
    test('默认规则集 + 大量重复授权后策略仍可被守卫压回上限内', () => {
        const rules = createDefaultPermissionRules('/home/tester/work');
        // 模拟长任务运行期授权积累：大量同形前缀规则（含完全重复项）
        for (let i = 0; i < 400; i++) {
            rules.push({
                resourceType: 'file',
                action: 'read',
                pathPattern: `/home/tester/toolchain-${i % 40}/lib/**`,
                effect: 'allow'
            });
        }
        const policy = policyTextLinux(
            'http://127.0.0.1:1/decide',
            't',
            '/home/tester/work',
            rules,
            '/home/tester',
            '/home/tester/.opendesk'
        );
        // 守卫介入后必须可安全落盘（不抛错）
        const guarded = serializePolicyForSandbox(policy, { keepPrefixes: ['/home/tester/work'] });
        expect(estimateDynoboxPolicySerializedSize(guarded)).toBeLessThan(DYNOBOX_POLICY_SERIALIZED_LIMIT);
        expect(guarded).toContain('[ask]');
    });
});
