import { Skill, SkillRegistry } from '../../../main/aikernel/skill';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool';
import { ToolCall } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';
import { z } from 'zod';

const TEST_BUNDLE = 'test-call-skill';
const TEST_SKILL = 'manage-skills';

function registerSkillWithTools(tools: BaseTool<any>[]): BaseTool<any> {
    const toolset = new BaseToolset('test-tools');
    for (const tool of tools) {
        toolset.addTool(tool);
    }

    const skill = new Skill(
        {
            name: TEST_SKILL,
            description: 'Test skill'
        },
        '',
        undefined,
        [toolset]
    );

    const registry = SkillRegistry.getInstance();
    registry.unregisterSkillProvider(TEST_BUNDLE);
    registry.registerSkillProvider(TEST_BUNDLE, {
        getSkills: async () => [skill]
    });
    // 直接预热缓存，模拟模型已 LoadSkill 后的状态（getCachedSkill 可命中）
    registry.cacheSkill(TEST_BUNDLE, skill);

    const callTool = registry.getToolset().getTool('CallSkillTool');
    if (!callTool) {
        throw new Error('CallSkillTool not found');
    }
    return callTool;
}

function registerSkillWithTool(tool: BaseTool<any>): BaseTool<any> {
    return registerSkillWithTools([tool]);
}

describe('CallSkillTool', () => {
    afterEach(() => {
        SkillRegistry.getInstance().unregisterSkillProvider(TEST_BUNDLE);
    });

    test('treats blank string toolArgs as an empty object', async () => {
        let receivedArgs: unknown;
        const refreshTool = new BaseTool('refreshSkills', 'Refresh skills', z.object({}));
        refreshTool.setExecutor(async (args) => {
            receivedArgs = args;
            return JSON.stringify({ count: 1, errors: [] });
        });

        const callTool = registerSkillWithTool(refreshTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'refreshSkills',
            toolArgs: ''
        });

        expect(result.status).toBe('success');
        expect(receivedArgs).toEqual({});
        expect(result.result).toBe(JSON.stringify({ count: 1, errors: [] }));
    });

    test('allows omitting toolArgs for no-argument inner tools', async () => {
        let receivedArgs: unknown;
        const refreshTool = new BaseTool('refreshSkills', 'Refresh skills', z.object({}));
        refreshTool.setExecutor(async (args) => {
            receivedArgs = args;
            return JSON.stringify({ count: 1, errors: [] });
        });

        const callTool = registerSkillWithTool(refreshTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'refreshSkills'
        });

        expect(result.status).toBe('success');
        expect(receivedArgs).toEqual({});
        expect(result.result).toBe(JSON.stringify({ count: 1, errors: [] }));
    });

    test('propagates inner tool failures as outer tool errors', async () => {
        const failingTool = new BaseTool('failingTool', 'Failing tool', z.object({}));
        failingTool.setExecutor(async () => {
            throw new Error('inner failure');
        });

        const callTool = registerSkillWithTool(failingTool);
        const result = await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'failingTool',
            toolArgs: {}
        });

        expect(result.status).toBe('error');
        expect(result.result).toContain('工具调用失败: inner failure');
    });

    // ─── 平铺参数自动修复（部分模型会丢失 toolName/toolArgs 包装） ───

    describe('flattened args repair', () => {
        function createBrowserLikeTools(): { evaluateTool: BaseTool<any>; snapshotTool: BaseTool<any> } {
            const evaluateTool = new BaseTool(
                'evaluate',
                '在当前页面执行任意 JavaScript',
                z.object({
                    expression: z.string().describe('要执行的 JS 表达式'),
                    snapshot: z.boolean().optional()
                })
            );
            const snapshotTool = new BaseTool(
                'snapshot',
                '获取页面快照',
                z.object({
                    mode: z.string(),
                    viewportOnly: z.boolean(),
                    ref: z.string().optional()
                })
            );
            return { evaluateTool, snapshotTool };
        }

        test('repairs flattened args by inferring toolName from schema', async () => {
            let receivedArgs: unknown;
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            evaluateTool.setExecutor(async (args) => {
                receivedArgs = args;
                return 'evaluated';
            });

            // 模拟真实失败案例：模型把 evaluate 的参数平铺到顶层
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                expression: 'document.body.innerText',
                snapshot: false
            } as any);

            expect(result.status).toBe('success');
            expect(receivedArgs).toEqual({ expression: 'document.body.innerText', snapshot: false });
        });

        test('repairs flattened args even when optional fields are missing', async () => {
            let receivedArgs: unknown;
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            evaluateTool.setExecutor(async (args) => {
                receivedArgs = args;
                return 'evaluated';
            });

            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                expression: '1 + 1'
            } as any);

            expect(result.status).toBe('success');
            expect(receivedArgs).toEqual({ expression: '1 + 1' });
        });

        test('repairs args when only toolArgs is provided without toolName', async () => {
            let receivedArgs: unknown;
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            evaluateTool.setExecutor(async (args) => {
                receivedArgs = args;
                return 'evaluated';
            });

            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolArgs: { expression: 'location.href' }
            } as any);

            expect(result.status).toBe('success');
            expect(receivedArgs).toEqual({ expression: 'location.href' });
        });

        test('repairs string toolArgs without toolName (real-world case task_mtvpprvf_91ts)', async () => {
            let receivedArgs: unknown;
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            evaluateTool.setExecutor(async (args) => {
                receivedArgs = args;
                return 'evaluated';
            });

            // 真实故障案例：模型漏传 toolName 且把 toolArgs 按 JSON 字符串嵌套传递，
            // 字符串形式的 toolArgs 同样应参与内部工具推断，而不是直接放弃修复
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolArgs: '{"expression": "document.title", "snapshot": false}'
            } as any);

            expect(result.status).toBe('success');
            expect(receivedArgs).toEqual({ expression: 'document.title', snapshot: false });
        });

        test('validation error echoes received top-level fields for self-correction', async () => {
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            // 修复失败（无内部工具能解释参数）时，错误信息应回显实际收到的顶层字段，
            // 让模型能对照发现缺漏（如漏传 toolName）并自我纠正
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolArgs: '{"unmatched": true}'
            } as any);

            expect(result.status).toBe('error');
            expect(result.result).toContain('bundleName, skillName, toolArgs');
        });

        test('keeps validation error when no inner tool matches flattened keys', async () => {
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                unknownField: 'whatever'
            } as any);

            expect(result.status).toBe('error');
            expect(result.result).toContain('toolName');
        });

        test('keeps locale-independent field path in validation error (CI en-US regression)', async () => {
            // CI 服务器为 POSIX locale，校验错误解析为 en-US 文案（Invalid tool arguments: ...），
            // 曾导致断言中文文案的用例挂掉。此用例强制 en-US 复现该场景：
            // 错误包装文案随 locale 变化，但 zod issue 的字段路径（toolName）始终是原始字段名，
            // 断言必须依赖后者而非任何一种语言的翻译文案
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);

            const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
            Object.defineProperty(globalThis, 'navigator', {
                value: { languages: ['en-US'] },
                configurable: true,
                writable: true
            });
            try {
                const result = await callTool.execute({
                    bundleName: TEST_BUNDLE,
                    skillName: TEST_SKILL,
                    unknownField: 'whatever'
                } as any);

                expect(result.status).toBe('error');
                // 证明 en-US stub 已生效：本地 OS 为 zh-CN 时，若 stub 失败这里会拿到中文文案
                expect(result.result).toMatch(/^Invalid tool arguments/);
                expect(result.result).toContain('toolName');
            } finally {
                if (originalNavigator) {
                    Object.defineProperty(globalThis, 'navigator', originalNavigator);
                } else {
                    delete (globalThis as { navigator?: unknown }).navigator;
                }
            }
        });

        test('keeps validation error when inner tool candidates are ambiguous', async () => {
            const toolA = new BaseTool('toolA', 'Tool A', z.object({ x: z.string() }));
            const toolB = new BaseTool('toolB', 'Tool B', z.object({ x: z.string() }));
            let executed = false;
            toolA.setExecutor(async () => {
                executed = true;
                return 'a';
            });
            toolB.setExecutor(async () => {
                executed = true;
                return 'b';
            });

            const callTool = registerSkillWithTools([toolA, toolB]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                x: 'value'
            } as any);

            expect(result.status).toBe('error');
            expect(result.result).toContain('toolName');
            expect(executed).toBe(false);
        });

        test('prefers the candidate with higher required coverage among multiple matches', async () => {
            let receivedArgs: unknown;
            // 模拟真实案例：tabs 与 trigger 都声明了 action 字段，
            // 但 tabs 的必填覆盖率更高（1/1 vs 1/3），应唯一选中 tabs
            const tabsTool = new BaseTool(
                'tabs',
                '管理浏览器标签页',
                z.object({ action: z.enum(['list', 'new', 'close', 'switch']) })
            );
            const triggerTool = new BaseTool(
                'trigger',
                '触发页面动作',
                z.object({ action: z.string(), args: z.record(z.string(), z.unknown()), snapshot: z.boolean() })
            );
            tabsTool.setExecutor(async (args) => {
                receivedArgs = args;
                return 'listed';
            });

            const callTool = registerSkillWithTools([tabsTool, triggerTool]);
            const result = await callTool.execute({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                action: 'list'
            } as any);

            expect(result.status).toBe('success');
            expect(receivedArgs).toEqual({ action: 'list' });
        });

        test('keeps validation error when skill is not cached', async () => {
            const registry = SkillRegistry.getInstance();
            registry.unregisterSkillProvider(TEST_BUNDLE);
            registry.registerSkillProvider(TEST_BUNDLE, {
                getSkills: async () => [
                    new Skill({ name: TEST_SKILL, description: 'Test skill' }, '', undefined, [
                        new BaseToolset('unused')
                    ])
                ]
            });
            // 不调用 cacheSkill 预热，模拟技能未加载
            const callTool = registry.getToolset().getTool('CallSkillTool');
            if (!callTool) throw new Error('CallSkillTool not found');

            try {
                const result = await callTool.execute({
                    bundleName: TEST_BUNDLE,
                    skillName: 'never-loaded-skill',
                    expression: '1'
                } as any);
                expect(result.status).toBe('error');
                expect(result.result).toContain('toolName');
            } finally {
                registry.unregisterSkillProvider(TEST_BUNDLE);
            }
        });

        test('declares inner tool permissions for repaired flattened args', async () => {
            class WriteFileLikeTool extends BaseTool<any> {
                constructor() {
                    super('writeFile', '写文件', z.object({ path: z.string(), content: z.string() }));
                }
                getDeclaredPermissions(args: z.output<any>): PermissionRequest[] {
                    return [{ resourceType: 'file', action: 'write', resourcePath: args.path }];
                }
            }

            const callTool = registerSkillWithTools([new WriteFileLikeTool()]);
            const permissions = callTool.getDeclaredPermissions({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                path: 'C:/tmp/out.txt',
                content: 'hello'
            } as any);

            expect(permissions).toEqual([{ resourceType: 'file', action: 'write', resourcePath: 'C:/tmp/out.txt' }]);
        });

        test('declares no permissions when args cannot be resolved to an inner tool', async () => {
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);
            const permissions = callTool.getDeclaredPermissions({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                unknownField: 'x'
            } as any);

            expect(permissions).toEqual([]);
        });

        test('marks flattened-args validation result as repaired', () => {
            const { evaluateTool, snapshotTool } = createBrowserLikeTools();
            const callTool = registerSkillWithTools([evaluateTool, snapshotTool]);

            const flattened = callTool.validateArgs({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                expression: 'document.title'
            } as any);
            expect(flattened.success).toBe(true);
            expect((flattened as { repaired?: boolean }).repaired).toBe(true);

            const canonical = callTool.validateArgs({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolName: 'evaluate',
                toolArgs: { expression: 'document.title' }
            });
            expect(canonical.success).toBe(true);
            expect((canonical as { repaired?: boolean }).repaired).toBeUndefined();
        });
    });

    // ─── 平铺参数修复后，args_string 修复即回写 ────────────────────────────────

    describe('processToolCall: sync repaired flattened args_string', () => {
        function createTaskWithCallSkillTool(): TaskState {
            const manager = new TaskManagerState();
            manager.save = (() => {}) as any;
            manager.publishTaskListUpdate = (() => {}) as any;
            manager.moveTaskToEnd = (() => {}) as any;
            const task = new TaskState(manager);
            task.task_status = 'running';

            const evaluateTool = new BaseTool('evaluate', '执行 JS', z.object({ expression: z.string() }));
            evaluateTool.setExecutor(async () => 'ok');
            task.chat_context.attachToolsets(SkillRegistry.getInstance().getToolset());
            return task;
        }

        test('平铺参数经 CallSkillTool 修复后 args_string 回写为规范化 JSON', async () => {
            const evaluateTool = new BaseTool('evaluate', '执行 JS', z.object({ expression: z.string() }));
            evaluateTool.setExecutor(async () => 'ok');
            registerSkillWithTools([evaluateTool]);

            const task = createTaskWithCallSkillTool();
            // 模拟模型把内部工具参数平铺到顶层且丢失 toolName/toolArgs 包装
            const toolCall = new ToolCall(
                0,
                'call-flat',
                'CallSkillTool',
                JSON.stringify({
                    bundleName: TEST_BUNDLE,
                    skillName: TEST_SKILL,
                    expression: 'document.title'
                })
            );

            await task.processToolCall(toolCall, true);

            expect(toolCall.status).toBe('success');
            expect(JSON.parse(toolCall.args_string)).toEqual({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolName: 'evaluate',
                toolArgs: { expression: 'document.title' }
            });
        });

        test('规范参数的 args_string 保持不变（不回写）', async () => {
            const evaluateTool = new BaseTool('evaluate', '执行 JS', z.object({ expression: z.string() }));
            evaluateTool.setExecutor(async () => 'ok');
            registerSkillWithTools([evaluateTool]);

            const task = createTaskWithCallSkillTool();
            const validArgs = JSON.stringify({
                bundleName: TEST_BUNDLE,
                skillName: TEST_SKILL,
                toolName: 'evaluate',
                toolArgs: { expression: 'document.title' }
            });
            const toolCall = new ToolCall(0, 'call-canonical', 'CallSkillTool', validArgs);

            await task.processToolCall(toolCall, true);

            expect(toolCall.status).toBe('success');
            expect(toolCall.args_string).toBe(validArgs);
        });
    });

    test('propagates user-attention state from an inner tool', async () => {
        const loginTool = new BaseTool('loginChannel', 'Login channel', z.object({}));
        loginTool.setExecutor(async () => 'ok');
        loginTool.requiresUserAttention = (toolcall) =>
            (toolcall.result_object as { phase?: string } | undefined)?.phase === 'polling';

        const callTool = registerSkillWithTool(loginTool);
        await callTool.execute({
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'loginChannel',
            toolArgs: {}
        });
        const outerCall = new ToolCall(0, 'call-login', 'CallSkillTool', '{}');
        outerCall.args_object = {
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'loginChannel',
            toolArgs: {}
        };
        outerCall.status = 'running';
        outerCall.result_object = { phase: 'polling' };

        expect(callTool.requiresUserAttention(outerCall)).toBe(true);
        outerCall.result_object = { phase: 'success' };
        expect(callTool.requiresUserAttention(outerCall)).toBe(false);
    });

    test('leaves an undeclared inner attention state available to outer fallback inference', () => {
        const legacyTool = new BaseTool('legacyAuthorize', 'Legacy authorization', z.object({}));
        const callTool = registerSkillWithTool(legacyTool);
        const outerCall = new ToolCall(0, 'call-legacy', 'CallSkillTool', '{}');
        outerCall.args_object = {
            bundleName: TEST_BUNDLE,
            skillName: TEST_SKILL,
            toolName: 'legacyAuthorize',
            toolArgs: {}
        };
        outerCall.status = 'running';
        outerCall.result_object = {
            phase: 'qr_code',
            verification_url: 'https://example.com/verify'
        };
        outerCall.setTool(callTool);

        expect(callTool.requiresUserAttention(outerCall)).toBeUndefined();
        expect(outerCall.requiresUserAttention()).toBe(true);
    });
});
