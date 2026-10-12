/**
 * 权限系统的单元测试。
 *
 * 覆盖范围：
 * - GlobPermissionEnforcer: 三态规则优先级、glob 匹配、动态规则增删
 * - createDefaultPermissionRules: Standard 模式默认策略
 * - createReadonlyModePermissionRules: Readonly 模式只读 + 执行放开
 * - createSoloModePermissionRules: Solo 模式全放通 + 敏感路径 deny
 * - createPlanModePermissionRules: Plan 模式只读 + .plan 可写
 * - createUnlimitedModePermissionRules: Unlimited 模式全放通（无限制）
 * - createSensitivePathRules / createCriticalPathRules: 敏感路径生成
 * - ResourcePath 前缀计算
 */

import os from 'os';
import path from 'path';
import { GlobPermissionEnforcer, createDefaultPermissionRules } from '../../../main/aikernel/security/enforcer';
import { createReadonlyModePermissionRules } from '../../../main/aikernel/agents/main/modes/readonly';
import { createSoloModePermissionRules } from '../../../main/aikernel/agents/main/modes/solo';
import { createPlanModePermissionRules } from '../../../main/aikernel/agents/main/modes/plan';
import { createUnlimitedModePermissionRules } from '../../../main/aikernel/agents/main/modes/unlimited';
import {
    createSensitivePathRules,
    createCriticalPathRules,
    createDeviceNodeRules,
    SENSITIVE_PATH_PATTERNS
} from '../../../main/utils/permissionRules';
import {
    FileResourcePath,
    NetworkResourcePath,
    PluginResourcePath,
    SkillResourcePath,
    createResourcePath,
    escapeGlobLiteralPath
} from '../../../main/aikernel/security/permission';
import type { PermissionRequest, PermissionRule } from '../../../main/aikernel/security/permission';

const HOME = os.homedir().replace(/\\/g, '/');

function normP(p: string): string {
    return p.replace(/\\/g, '/');
}

// ═══════════════════════════════════════════════════════════════
// GlobPermissionEnforcer 核心引擎测试
// ═══════════════════════════════════════════════════════════════

describe('GlobPermissionEnforcer', () => {
    describe('规则优先级: deny > ask > allow > 隐式 ask', () => {
        test('deny 优先于 allow', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/secret/**', effect: 'deny' },
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/secret/key.pem' });
            expect(r.effect).toBe('deny');
        });

        test('deny 优先于 ask', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/locked/**', effect: 'deny' },
                { resourceType: 'file', action: 'read', pathPattern: '/locked/**', effect: 'ask' }
            ]);
            const r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/locked/data.db' });
            expect(r.effect).toBe('deny');
        });

        test('显式 ask 优先于 allow', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**/.env', effect: 'ask' },
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/workspace/.env' });
            expect(r.effect).toBe('ask');
        });

        test('allow 匹配时不触发隐式 ask', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/src/index.ts'
            });
            expect(r.effect).toBe('allow');
        });

        test('精确路径规则不会把文件名中的 glob 字符解释为通配符', async () => {
            const exactFilePattern = new FileResourcePath('/tmp/report[1]?.pdf').getPrefixes()[0].pattern;
            const enforcer = await GlobPermissionEnforcer.create([
                {
                    resourceType: 'file',
                    action: 'read',
                    pathPattern: exactFilePattern,
                    effect: 'allow'
                },
                {
                    resourceType: 'file',
                    action: 'read',
                    pathPattern: escapeGlobLiteralPath('/tmp/report*.pdf'),
                    effect: 'allow'
                }
            ]);

            await expect(
                enforcer.check({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: '/tmp/report[1]?.pdf'
                })
            ).resolves.toMatchObject({ effect: 'allow' });
            await expect(
                enforcer.check({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: '/tmp/report*.pdf'
                })
            ).resolves.toMatchObject({ effect: 'allow' });
            await expect(
                enforcer.check({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: '/tmp/report1x.pdf'
                })
            ).resolves.toMatchObject({ effect: 'ask' });
            await expect(
                enforcer.check({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: '/tmp/report-private.pdf'
                })
            ).resolves.toMatchObject({ effect: 'ask' });
        });

        test('无规则匹配时返回隐式 ask', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/etc/passwd' });
            expect(r.effect).toBe('ask');
        });
    });

    describe('resourceType 和 action 通配符匹配', () => {
        test('resourceType=* 匹配所有资源类型', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: '*', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const fileR = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/a.txt' });
            const netR = await enforcer.check({
                resourceType: 'network',
                action: 'read',
                resourcePath: 'https://x.com'
            });
            const skillR = await enforcer.check({ resourceType: 'skill', action: 'read', resourcePath: 'my-skill' });
            expect(fileR.effect).toBe('allow');
            expect(netR.effect).toBe('allow');
            expect(skillR.effect).toBe('allow');
        });

        test('action=* 匹配所有操作类型', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: '*', pathPattern: '**', effect: 'allow' }
            ]);
            const readR = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/a.txt' });
            const writeR = await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/a.txt' });
            const execR = await enforcer.check({ resourceType: 'file', action: 'execute', resourcePath: '/a.txt' });
            expect(readR.effect).toBe('allow');
            expect(writeR.effect).toBe('allow');
            expect(execR.effect).toBe('allow');
        });

        test('resourceType=* + action=* 全通配匹配所有请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' }
            ]);
            const requests: PermissionRequest[] = [
                { resourceType: 'file', action: 'read', resourcePath: '/a.txt' },
                { resourceType: 'file', action: 'write', resourcePath: '/b.txt' },
                { resourceType: 'file', action: 'execute', resourcePath: '/c.sh' },
                { resourceType: 'network', action: 'access', resourcePath: 'https://x.com' },
                { resourceType: 'skill', action: 'read', resourcePath: 's1' },
                { resourceType: 'skill', action: 'write', resourcePath: 's2' },
                { resourceType: 'skill', action: 'execute', resourcePath: 's3' }
            ];
            for (const req of requests) {
                const r = await enforcer.check(req);
                expect(r.effect).toBe('allow');
            }
        });

        test('resourceType=* 不匹配 action 不同的请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: '*', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const readR = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/a.txt' });
            const writeR = await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/a.txt' });
            expect(readR.effect).toBe('allow');
            expect(writeR.effect).toBe('ask');
        });

        test('action=* 不匹配 resourceType 不同的请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: '*', pathPattern: '**', effect: 'allow' }
            ]);
            const fileR = await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/a.txt' });
            const netR = await enforcer.check({
                resourceType: 'network',
                action: 'access',
                resourcePath: 'https://x.com'
            });
            expect(fileR.effect).toBe('allow');
            expect(netR.effect).toBe('ask');
        });

        test('通配规则与 deny 规则优先级正常（deny 仍优先）', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' },
                { resourceType: 'file', action: 'read', pathPattern: '/secret/**', effect: 'deny' }
            ]);
            const normalR = await enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/tmp/a.txt' });
            const secretR = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/secret/key' });
            expect(normalR.effect).toBe('allow');
            expect(secretR.effect).toBe('deny');
        });

        test('通配规则与 ask 规则优先级正常（ask 仍优先于 allow）', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' },
                { resourceType: 'file', action: 'read', pathPattern: '**/.env', effect: 'ask' }
            ]);
            const normalR = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/a.txt'
            });
            const envR = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/.env'
            });
            expect(normalR.effect).toBe('allow');
            expect(envR.effect).toBe('ask');
        });
    });

    describe('resourceType 和 action 精确匹配', () => {
        test('file allow 规则不匹配 network 请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'network',
                action: 'access',
                resourcePath: 'https://api.example.com'
            });
            expect(r.effect).toBe('ask');
        });

        test('read allow 规则不匹配 write 请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: '/workspace/file.txt'
            });
            expect(r.effect).toBe('ask');
        });

        test('skill allow 规则正确匹配 skill 请求', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const r = await enforcer.check({ resourceType: 'skill', action: 'read', resourcePath: 'my-skill/handler' });
            expect(r.effect).toBe('allow');
        });
    });

    describe('glob 匹配行为', () => {
        test('** 匹配深层嵌套路径', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/a/b/c/d/e/file.ts'
            });
            expect(r.effect).toBe('allow');
        });

        test('dotfiles 匹配 (dot: true)', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/.gitignore'
            });
            expect(r.effect).toBe('allow');
        });

        test('dotfiles 嵌套目录匹配', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/.config/settings.json'
            });
            expect(r.effect).toBe('allow');
        });

        test('** 匹配绝对路径（Solo 模式关键场景）', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const paths = [
                '/storage/Users/currentUser/workspace/code/project/',
                '/home/user/documents/report.pdf',
                '/var/log/syslog',
                'C:/Users/test/Desktop/file.txt'
            ];
            for (const p of paths) {
                const r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: p });
                expect(r.effect).toBe('allow');
            }
        });

        test('目录路径（尾部 /）正确匹配 ** 规则', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/src/'
            });
            expect(r.effect).toBe('allow');
        });

        test('目录路径（尾部 /）去尾匹配', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/src/components/'
            });
            expect(r.effect).toBe('allow');
        });

        test('含换行符的路径被截断后仍能匹配 **', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            // \n 后的内容被截断，等价于 /workspace/src/index.ts
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/src/index.ts\n/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });

        test('含 \\r\\n 的路径被截断后仍能匹配 **', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/file.txt\r\n/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });

        test('含 Unicode 行分隔符 U+2028 的路径被截断后仍能匹配 **', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/file.txt\u2028/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });

        test('含 Unicode 段分隔符 U+2029 的路径被截断后仍能匹配 **', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/file.txt\u2029/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });

        test('含换行符的路径截断后不匹配 deny 规则', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' },
                { resourceType: 'file', action: 'read', pathPattern: '/secret/**', effect: 'deny' }
            ]);
            // 换行后的 /secret/key.pem 被截断，实际匹配 /workspace/file.txt
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '/workspace/file.txt\n/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });

        test('含特殊字符的路径能匹配 **', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const specialPaths = [
                '/workspace/file with spaces.txt',
                '/workspace/文件名.txt',
                '/workspace/emoji_😀_file.txt',
                '/workspace/path with (parens)/file.txt',
                '/workspace/path-with-dashes/file.txt',
                '/workspace/path_with_underscores/file.txt'
            ];
            for (const p of specialPaths) {
                const r = await enforcer.check({
                    resourceType: 'file',
                    action: 'read',
                    resourcePath: p
                });
                expect(r.effect).toBe('allow');
            }
        });

        test('仅换行符的路径被归一化为空字符串后直接 allow', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: '\n/secret/key.pem'
            });
            expect(r.effect).toBe('allow');
        });
    });

    describe('Windows 路径归一化', () => {
        test('反斜杠路径被归一化为正斜杠', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: 'C:/Projects/**', effect: 'allow' }
            ]);
            const r = await enforcer.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: 'C:\\Projects\\OpenDesk\\src\\main.ts'
            });
            expect(r.effect).toBe('allow');
        });
    });

    describe('动态规则管理', () => {
        test('addRule 添加 allow 规则后生效', async () => {
            const enforcer = await GlobPermissionEnforcer.create([]);
            let r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('ask');

            await enforcer.addRule({ resourceType: 'file', action: 'read', pathPattern: '/tmp/**', effect: 'allow' });
            r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('allow');
        });

        test('removeRule 移除规则后恢复到隐式 ask', async () => {
            const rule: PermissionRule = {
                resourceType: 'file',
                action: 'read',
                pathPattern: '/tmp/**',
                effect: 'allow'
            };
            const enforcer = await GlobPermissionEnforcer.create([rule]);
            let r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('allow');

            await enforcer.removeRule(rule);
            r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('ask');
        });

        test('addRule 添加 deny 规则覆盖已有 allow', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            let r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/secret/data' });
            expect(r.effect).toBe('allow');

            await enforcer.addRule({ resourceType: 'file', action: 'read', pathPattern: '/secret/**', effect: 'deny' });
            r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/secret/data' });
            expect(r.effect).toBe('deny');
        });

        test('removeRule 可移除通配规则 (*/*)', async () => {
            const wildcardRule: PermissionRule = {
                resourceType: '*',
                action: '*',
                pathPattern: '**',
                effect: 'allow'
            };
            const enforcer = await GlobPermissionEnforcer.create([wildcardRule]);
            let r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('allow');

            await enforcer.removeRule(wildcardRule);
            r = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath: '/tmp/test.txt' });
            expect(r.effect).toBe('ask');
        });
    });

    describe('共享基础规则与任务级 overlay', () => {
        test('共享基础编译规则，但隔离任务运行期授权', async () => {
            const base = GlobPermissionEnforcer.createSync([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);
            const firstTask = base.createOverlay();
            const secondTask = base.createOverlay();

            await firstTask.addRule({
                resourceType: 'network',
                action: 'read',
                pathPattern: 'https://api.example.com/**',
                effect: 'allow'
            });

            expect(
                (
                    await firstTask.check({
                        resourceType: 'file',
                        action: 'read',
                        resourcePath: '/workspace/src/main.ts'
                    })
                ).effect
            ).toBe('allow');
            expect(
                (
                    await secondTask.check({
                        resourceType: 'file',
                        action: 'read',
                        resourcePath: '/workspace/src/main.ts'
                    })
                ).effect
            ).toBe('allow');
            expect(
                (
                    await firstTask.check({
                        resourceType: 'network',
                        action: 'read',
                        resourcePath: 'https://api.example.com/v1'
                    })
                ).effect
            ).toBe('allow');
            expect(
                (
                    await secondTask.check({
                        resourceType: 'network',
                        action: 'read',
                        resourcePath: 'https://api.example.com/v1'
                    })
                ).effect
            ).toBe('ask');
        });

        test('基础保护规则仍优先于 overlay allow，基础后续规则对 overlay 可见', async () => {
            const base = GlobPermissionEnforcer.createSync([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/.env', effect: 'ask' }
            ]);
            const task = base.createOverlay([
                { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
            ]);

            expect(
                (
                    await task.check({
                        resourceType: 'file',
                        action: 'read',
                        resourcePath: '/workspace/.env'
                    })
                ).effect
            ).toBe('ask');

            await base.addRule({
                resourceType: 'file',
                action: 'read',
                pathPattern: '/shared-readable/**',
                effect: 'allow'
            });
            expect(
                (
                    await task.check({
                        resourceType: 'file',
                        action: 'read',
                        resourcePath: '/shared-readable/skill.md'
                    })
                ).effect
            ).toBe('allow');
        });
    });

    describe('批量检查', () => {
        test('checkAll 全部 allow 时返回 null', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
            ]);
            const result = await enforcer.checkAll([
                { resourceType: 'file', action: 'read', resourcePath: '/a.txt' },
                { resourceType: 'file', action: 'read', resourcePath: '/b.txt' }
            ]);
            expect(result).toBeNull();
        });

        test('checkAll 有非 allow 时返回第一条', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/allowed/**', effect: 'allow' }
            ]);
            const result = await enforcer.checkAll([
                { resourceType: 'file', action: 'read', resourcePath: '/allowed/a.txt' },
                { resourceType: 'file', action: 'read', resourcePath: '/forbidden/b.txt' }
            ]);
            expect(result).not.toBeNull();
            expect(result!.effect).toBe('ask');
            expect(result!.request.resourcePath).toBe('/forbidden/b.txt');
        });

        test('checkAllDetailed 返回所有非 allow 结果', async () => {
            const enforcer = await GlobPermissionEnforcer.create([
                { resourceType: 'file', action: 'read', pathPattern: '/allowed/**', effect: 'allow' },
                { resourceType: 'file', action: 'read', pathPattern: '/denied/**', effect: 'deny' }
            ]);
            const results = await enforcer.checkAllDetailed([
                { resourceType: 'file', action: 'read', resourcePath: '/allowed/a.txt' },
                { resourceType: 'file', action: 'read', resourcePath: '/denied/b.txt' },
                { resourceType: 'file', action: 'read', resourcePath: '/unknown/c.txt' }
            ]);
            expect(results.length).toBe(2);
            expect(results[0].effect).toBe('deny');
            expect(results[1].effect).toBe('ask');
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// Standard 模式 (createDefaultPermissionRules)
// ═══════════════════════════════════════════════════════════════

describe('Standard Mode 默认权限规则', () => {
    const WORKSPACE = '/home/user/project';
    const WORKSPACE_NORM = normP(path.resolve(WORKSPACE));

    let enforcer: GlobPermissionEnforcer;
    beforeAll(async () => {
        enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(WORKSPACE));
    });

    test('工作空间内文件读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间内文件写入 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间内文件执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: `${WORKSPACE_NORM}/scripts/build.sh`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间内 dotfile (.gitignore) → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/.gitignore`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间外文件 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/etc/passwd'
        });
        expect(r.effect).toBe('ask');
    });

    test('网络访问 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com/data'
        });
        expect(r.effect).toBe('ask');
    });

    test('技能读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'my-skill/handler'
        });
        expect(r.effect).toBe('allow');
    });

    test('技能写入 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'write',
            resourcePath: 'my-skill/handler'
        });
        expect(r.effect).toBe('ask');
    });

    test('工作空间内 .env 文件 → ask（敏感路径保护覆盖 allow）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/.env`
        });
        expect(r.effect).toBe('ask');
    });

    test('工作空间内 .env.local → ask（敏感路径保护）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/.env.local`
        });
        expect(r.effect).toBe('ask');
    });

    test('设备节点 /dev/null → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/dev/null'
        });
        expect(r.effect).toBe('allow');
    });

    test('设备节点 /dev/stdin → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/dev/stdin'
        });
        expect(r.effect).toBe('allow');
    });
});

// ═══════════════════════════════════════════════════════════════
// Readonly 模式
// ═══════════════════════════════════════════════════════════════

describe('Readonly Mode 权限规则', () => {
    const WORKSPACE = '/home/user/project';
    const WORKSPACE_NORM = normP(path.resolve(WORKSPACE));

    let enforcer: GlobPermissionEnforcer;
    beforeAll(async () => {
        enforcer = await GlobPermissionEnforcer.create(createReadonlyModePermissionRules(WORKSPACE));
    });

    test('工作空间内文件读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间内 .env 文件读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/.env`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间内文件写入 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('deny');
    });

    test('工作空间外文件写入 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: '/tmp/output.txt'
        });
        expect(r.effect).toBe('deny');
    });

    test('任意文件执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: `${WORKSPACE_NORM}/scripts/build.sh`
        });
        expect(r.effect).toBe('allow');
    });

    test('工作空间外文件读取 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/etc/passwd'
        });
        expect(r.effect).toBe('ask');
    });

    test('技能读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'my-skill/handler'
        });
        expect(r.effect).toBe('allow');
    });

    test('网络访问 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com/data'
        });
        expect(r.effect).toBe('ask');
    });
});

// ═══════════════════════════════════════════════════════════════
// Solo 模式
// ═══════════════════════════════════════════════════════════════

describe('Solo Mode 权限规则', () => {
    let enforcer: GlobPermissionEnforcer;
    beforeAll(async () => {
        enforcer = await GlobPermissionEnforcer.create(createSoloModePermissionRules());
    });

    test('普通文件读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/home/user/project/src/index.ts'
        });
        expect(r.effect).toBe('allow');
    });

    test('任意绝对路径文件写入 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: '/tmp/output.txt'
        });
        expect(r.effect).toBe('allow');
    });

    test('任意文件执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: '/usr/bin/python3'
        });
        expect(r.effect).toBe('allow');
    });

    test('网络访问 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com/data'
        });
        expect(r.effect).toBe('allow');
    });

    test('技能读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'any-skill'
        });
        expect(r.effect).toBe('allow');
    });

    test('Solo: ~/.ssh 目录 → deny（非 ask）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/.ssh/id_rsa`
        });
        expect(r.effect).toBe('deny');
    });

    test('Solo: ~/.gnupg 目录 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME}/.gnupg/trustdb.gpg`
        });
        expect(r.effect).toBe('deny');
    });

    test('Solo: ~/.aws 目录 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/.aws/credentials`
        });
        expect(r.effect).toBe('deny');
    });

    test('Solo: .env 文件 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/workspace/project/.env'
        });
        expect(r.effect).toBe('deny');
    });

    test('Solo: .env.production 文件 → deny', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/workspace/project/.env.production'
        });
        expect(r.effect).toBe('deny');
    });

    test('Solo 不应产生 ask 结果（关键安全属性）', async () => {
        const testPaths = [
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: '/home/user/anything.txt' },
            { resourceType: 'file' as const, action: 'write' as const, resourcePath: '/tmp/output' },
            { resourceType: 'file' as const, action: 'execute' as const, resourcePath: '/usr/bin/node' },
            { resourceType: 'network' as const, action: 'access' as const, resourcePath: 'https://example.com' },
            { resourceType: 'skill' as const, action: 'read' as const, resourcePath: 'test-skill' },
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: `${HOME}/.ssh/id_rsa` },
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: '/workspace/.env' }
        ];
        for (const req of testPaths) {
            const r = await enforcer.check(req);
            expect(r.effect).not.toBe('ask');
        }
    });

    test('Solo: 长路径目录（trailing /）→ allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/storage/Users/currentUser/workspace/code/nodejs_3rd_migration/'
        });
        expect(r.effect).toBe('allow');
    });

    test('Solo: 设备节点 /dev/null → allow（不被敏感路径 deny 覆盖）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/dev/null'
        });
        expect(r.effect).toBe('allow');
    });

    test('Solo: 设备节点 /dev/stdin → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: '/dev/stdin'
        });
        expect(r.effect).toBe('allow');
    });
});

// ═══════════════════════════════════════════════════════════════
// Unlimited 模式
// ═══════════════════════════════════════════════════════════════

describe('Unlimited Mode 权限规则', () => {
    let enforcer: GlobPermissionEnforcer;
    beforeAll(async () => {
        enforcer = await GlobPermissionEnforcer.create(createUnlimitedModePermissionRules());
    });

    test('普通文件读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/home/user/project/src/index.ts'
        });
        expect(r.effect).toBe('allow');
    });

    test('任意绝对路径文件写入 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: '/tmp/output.txt'
        });
        expect(r.effect).toBe('allow');
    });

    test('任意文件执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: '/usr/bin/python3'
        });
        expect(r.effect).toBe('allow');
    });

    test('网络访问 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com/data'
        });
        expect(r.effect).toBe('allow');
    });

    test('技能读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'any-skill'
        });
        expect(r.effect).toBe('allow');
    });

    test('技能执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'execute',
            resourcePath: 'any-skill'
        });
        expect(r.effect).toBe('allow');
    });

    test('技能写入 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'write',
            resourcePath: 'any-skill'
        });
        expect(r.effect).toBe('allow');
    });

    // Unlimited mode 关键特性：敏感路径也允许
    test('Unlimited: ~/.ssh 目录 → allow（无保护）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/.ssh/id_rsa`
        });
        expect(r.effect).toBe('allow');
    });

    test('Unlimited: ~/.gnupg 目录 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME}/.gnupg/trustdb.gpg`
        });
        expect(r.effect).toBe('allow');
    });

    test('Unlimited: ~/.aws 目录 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/.aws/credentials`
        });
        expect(r.effect).toBe('allow');
    });

    test('Unlimited: .env 文件 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/workspace/project/.env'
        });
        expect(r.effect).toBe('allow');
    });

    test('Unlimited: .env.production 文件 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/workspace/project/.env.production'
        });
        expect(r.effect).toBe('allow');
    });

    test('Unlimited 不应产生任何 ask 或 deny 结果', async () => {
        const testPaths = [
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: '/home/user/anything.txt' },
            { resourceType: 'file' as const, action: 'write' as const, resourcePath: '/tmp/output' },
            { resourceType: 'file' as const, action: 'execute' as const, resourcePath: '/usr/bin/node' },
            { resourceType: 'network' as const, action: 'access' as const, resourcePath: 'https://example.com' },
            { resourceType: 'skill' as const, action: 'read' as const, resourcePath: 'test-skill' },
            { resourceType: 'skill' as const, action: 'execute' as const, resourcePath: 'test-skill' },
            { resourceType: 'skill' as const, action: 'write' as const, resourcePath: 'test-skill' },
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: `${HOME}/.ssh/id_rsa` },
            { resourceType: 'file' as const, action: 'write' as const, resourcePath: `${HOME}/.ssh/config` },
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: '/workspace/.env' },
            { resourceType: 'file' as const, action: 'read' as const, resourcePath: `${HOME}/.aws/credentials` }
        ];
        for (const req of testPaths) {
            const r = await enforcer.check(req);
            expect(r.effect).toBe('allow');
        }
    });

    test('Unlimited: 设备节点 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/dev/null'
        });
        expect(r.effect).toBe('allow');
    });
});

// ═══════════════════════════════════════════════════════════════
// Plan 模式
// ═══════════════════════════════════════════════════════════════

describe('Plan Mode 权限规则', () => {
    const WORKSPACE = '/home/user/project';
    const WORKSPACE_NORM = normP(path.resolve(WORKSPACE));

    let enforcer: GlobPermissionEnforcer;
    beforeAll(async () => {
        enforcer = await GlobPermissionEnforcer.create(createPlanModePermissionRules(WORKSPACE));
    });

    test('Plan: 工作空间内读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('allow');
    });

    test('Plan: 工作空间内写入（.plan 外）→ ask（只读模式）', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${WORKSPACE_NORM}/src/index.ts`
        });
        expect(r.effect).toBe('ask');
    });

    test('Plan: .plan 目录写入 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${WORKSPACE_NORM}/.plan/plan.md`
        });
        expect(r.effect).toBe('allow');
    });

    test('Plan: .plan 目录读取 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${WORKSPACE_NORM}/.plan/analysis.json`
        });
        expect(r.effect).toBe('allow');
    });

    test('Plan: .plan 目录执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: `${WORKSPACE_NORM}/.plan/script.sh`
        });
        expect(r.effect).toBe('allow');
    });

    test('Plan: 工作空间内执行 → allow', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'execute',
            resourcePath: `${WORKSPACE_NORM}/scripts/build.sh`
        });
        expect(r.effect).toBe('allow');
    });

    test('Plan: 工作空间外读取 → 隐式 ask', async () => {
        const r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/etc/hosts'
        });
        expect(r.effect).toBe('ask');
    });

    test('Plan: 技能可读', async () => {
        const r = await enforcer.check({
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'any-skill'
        });
        expect(r.effect).toBe('allow');
    });
});

// ═══════════════════════════════════════════════════════════════
// 敏感路径规则生成
// ═══════════════════════════════════════════════════════════════

describe('敏感路径规则', () => {
    test('createSensitivePathRules: 当工作空间是 HOME 时生成所有 home 相关规则', () => {
        const rules = createSensitivePathRules(HOME);
        const sshRules = rules.filter((r) => r.pathPattern.includes('.ssh'));
        expect(sshRules.length).toBeGreaterThan(0);
        sshRules.forEach((r) => expect(r.effect).toBe('ask'));
    });

    test('createSensitivePathRules: **/.env 始终生成（不受工作空间限制）', () => {
        const rules = createSensitivePathRules('/some/unrelated/workspace');
        const envRules = rules.filter((r) => r.pathPattern === '**/.env');
        expect(envRules.length).toBeGreaterThan(0);
    });

    test('createSensitivePathRules: 工作空间不在 HOME 下时跳过 HOME 内敏感路径', () => {
        const rules = createSensitivePathRules('/opt/completely/different');
        const sshRules = rules.filter((r) => r.pathPattern.includes('.ssh'));
        expect(sshRules.length).toBe(0);
    });

    test('createSensitivePathRules: 工作区根目录和子目录的 .npmrc 读写均需确认', () => {
        const workspace = '/opt/completely/different';
        const rules = createSensitivePathRules(workspace);
        const npmrcRules = rules.filter((rule) => rule.pathPattern.endsWith('.npmrc'));

        expect(npmrcRules).toEqual(
            expect.arrayContaining([
                { resourceType: 'file', action: 'read', pathPattern: `${workspace}/.npmrc`, effect: 'ask' },
                { resourceType: 'file', action: 'write', pathPattern: `${workspace}/.npmrc`, effect: 'ask' },
                { resourceType: 'file', action: 'read', pathPattern: `${workspace}/**/.npmrc`, effect: 'ask' },
                { resourceType: 'file', action: 'write', pathPattern: `${workspace}/**/.npmrc`, effect: 'ask' }
            ])
        );
    });

    test('createCriticalPathRules: 始终包含所有敏感路径（不受工作空间限制）', () => {
        const rules = createCriticalPathRules();
        const sshRules = rules.filter((r) => r.pathPattern.includes('.ssh'));
        expect(sshRules.length).toBeGreaterThan(0);
        const envRules = rules.filter((r) => r.pathPattern.includes('.env'));
        expect(envRules.length).toBeGreaterThan(0);
    });

    test('createDeviceNodeRules: 覆盖 /dev/null, /dev/stdin 等', () => {
        const rules = createDeviceNodeRules();
        const devNull = rules.filter((r) => r.pathPattern === '/dev/null');
        expect(devNull.length).toBe(3); // read, write, execute
        devNull.forEach((r) => expect(r.effect).toBe('allow'));
    });

    test('SENSITIVE_PATH_PATTERNS 包含 .ssh 和 .env', () => {
        const patterns = SENSITIVE_PATH_PATTERNS.map((p) => p.pattern);
        expect(patterns).toContain('{home}/.ssh/**');
        expect(patterns).toContain('**/.env');
        expect(patterns).toContain('**/.env.*');
    });
});

// ═══════════════════════════════════════════════════════════════
// ResourcePath 前缀计算
// ═══════════════════════════════════════════════════════════════

describe('ResourcePath 前缀计算', () => {
    describe('FileResourcePath', () => {
        test('精确文件路径：首项为自身，后续为父目录', () => {
            const rp = new FileResourcePath('/home/user/project/src/index.ts');
            const prefixes = rp.getPrefixes();
            expect(prefixes[0]).toEqual({
                label: '/home/user/project/src/index.ts',
                pattern: '/home/user/project/src/index.ts'
            });
            expect(prefixes[1]).toEqual({
                label: '/home/user/project/src/',
                pattern: '/home/user/project/src/**'
            });
            expect(prefixes[2]).toEqual({
                label: '/home/user/project/',
                pattern: '/home/user/project/**'
            });
        });

        test('目录路径（trailing /）：首项为 dir/**', () => {
            const rp = new FileResourcePath('/workspace/src/');
            const prefixes = rp.getPrefixes();
            expect(prefixes[0]).toEqual({
                label: '/workspace/src/',
                pattern: '/workspace/src/**'
            });
            expect(prefixes[1]).toEqual({
                label: '/workspace/',
                pattern: '/workspace/**'
            });
        });

        test('Windows 盘符路径', () => {
            const rp = new FileResourcePath('C:/Users/test/file.txt');
            const prefixes = rp.getPrefixes();
            expect(prefixes[0].label).toBe('C:/Users/test/file.txt');
            expect(prefixes.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('NetworkResourcePath', () => {
        test('URL 按路径层级展开', () => {
            const rp = new NetworkResourcePath('https://api.example.com/v1/users');
            const prefixes = rp.getPrefixes();
            expect(prefixes[0]).toEqual({
                label: 'https://api.example.com/v1/users',
                pattern: 'https://api.example.com/v1/users'
            });
            expect(prefixes.some((p) => p.pattern === 'https://api.example.com/**')).toBe(true);
        });
    });

    describe('SkillResourcePath', () => {
        test('技能路径展开 bundleName/**', () => {
            const rp = new SkillResourcePath('my-bundle/my-skill');
            const prefixes = rp.getPrefixes();
            expect(prefixes[0]).toEqual({
                label: 'my-bundle/my-skill',
                pattern: 'my-bundle/my-skill'
            });
            expect(prefixes[1]).toEqual({
                label: 'my-bundle/',
                pattern: 'my-bundle/**'
            });
        });

        test('无 / 的技能名仅返回自身', () => {
            const rp = new SkillResourcePath('simple-skill');
            const prefixes = rp.getPrefixes();
            expect(prefixes.length).toBe(1);
            expect(prefixes[0].pattern).toBe('simple-skill');
        });
    });

    test('插件读取默认允许，修改和执行默认询问', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules('/workspace'));

        await expect(
            enforcer.check({ resourceType: 'plugin', action: 'read', resourcePath: 'review-helper' })
        ).resolves.toMatchObject({ effect: 'allow' });
        await expect(
            enforcer.check({ resourceType: 'plugin', action: 'write', resourcePath: 'review-helper' })
        ).resolves.toMatchObject({ effect: 'ask' });
        await expect(
            enforcer.check({ resourceType: 'plugin', action: 'execute', resourcePath: 'review-helper' })
        ).resolves.toMatchObject({ effect: 'ask' });
    });

    describe('PluginResourcePath', () => {
        test('插件 ID 作为独立权限资源', () => {
            const rp = new PluginResourcePath('review-helper');
            expect(rp.getPrefixes()).toEqual([
                {
                    label: 'review-helper',
                    pattern: 'review-helper'
                }
            ]);
        });
    });

    describe('createResourcePath 工厂函数', () => {
        test('file 类型 → FileResourcePath', () => {
            const rp = createResourcePath('file', '/workspace/file.txt');
            expect(rp).toBeInstanceOf(FileResourcePath);
        });

        test('network 类型 → NetworkResourcePath', () => {
            const rp = createResourcePath('network', 'https://example.com');
            expect(rp).toBeInstanceOf(NetworkResourcePath);
        });

        test('skill 类型 → SkillResourcePath', () => {
            const rp = createResourcePath('skill', 'my-skill');
            expect(rp).toBeInstanceOf(SkillResourcePath);
        });

        test('plugin 类型 → PluginResourcePath', () => {
            const rp = createResourcePath('plugin', 'review-helper');
            expect(rp).toBeInstanceOf(PluginResourcePath);
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 端到端场景测试
// ═══════════════════════════════════════════════════════════════

describe('端到端场景', () => {
    test('场景: 工作区内的项目级 .npmrc 覆盖工作区默认 allow', async () => {
        const workspace = '/workspace';
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(workspace, '/home/tester'));

        for (const resourcePath of [`${workspace}/.npmrc`, `${workspace}/packages/app/.npmrc`]) {
            const read = await enforcer.check({ resourceType: 'file', action: 'read', resourcePath });
            const write = await enforcer.check({ resourceType: 'file', action: 'write', resourcePath });
            expect(read.effect).toBe('ask');
            expect(write.effect).toBe('ask');
        }
    });

    test('场景: 工作空间设为 HOME 时，敏感路径仍被保护', async () => {
        const rules = createDefaultPermissionRules(HOME);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const normalFile = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/Documents/report.pdf`
        });
        expect(normalFile.effect).toBe('allow');

        const sshKey = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME}/.ssh/id_rsa`
        });
        expect(sshKey.effect).toBe('ask');
    });

    test('场景: Solo 模式下 checkAllDetailed 不包含 ask', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createSoloModePermissionRules());

        const requests: PermissionRequest[] = [
            { resourceType: 'file', action: 'read', resourcePath: '/home/user/anything.txt' },
            { resourceType: 'file', action: 'write', resourcePath: '/tmp/output.log' },
            { resourceType: 'file', action: 'execute', resourcePath: '/usr/bin/node' },
            { resourceType: 'network', action: 'access', resourcePath: 'https://api.example.com' }
        ];
        const results = await enforcer.checkAllDetailed(requests);
        expect(results.length).toBe(0);
    });

    test('场景: Solo 模式下敏感路径批量检查全部 deny', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createSoloModePermissionRules());

        const sensitiveRequests: PermissionRequest[] = [
            { resourceType: 'file', action: 'read', resourcePath: `${HOME}/.ssh/id_rsa` },
            { resourceType: 'file', action: 'read', resourcePath: `${HOME}/.aws/credentials` },
            { resourceType: 'file', action: 'read', resourcePath: '/workspace/.env' }
        ];
        const results = await enforcer.checkAllDetailed(sensitiveRequests);
        expect(results.length).toBe(3);
        results.forEach((r) => expect(r.effect).toBe('deny'));
    });

    test('场景: 动态添加 allow 规则后，之前 ask 的路径变为 allow', async () => {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: '/workspace/**', effect: 'allow' }
        ]);

        let r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/external/data.csv'
        });
        expect(r.effect).toBe('ask');

        await enforcer.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: '/external/**',
            effect: 'allow'
        });

        r = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: '/external/data.csv'
        });
        expect(r.effect).toBe('allow');
    });

    test('场景: Plan 模式下 .plan 外的写入需确认，但 .plan 内可以', async () => {
        const workspace = '/home/user/project';
        const wsNorm = normP(path.resolve(workspace));
        const enforcer = await GlobPermissionEnforcer.create(createPlanModePermissionRules(workspace));

        const writeOutside = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${wsNorm}/src/index.ts`
        });
        expect(writeOutside.effect).toBe('ask');

        const writePlan = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${wsNorm}/.plan/plan.md`
        });
        expect(writePlan.effect).toBe('allow');
    });
});
