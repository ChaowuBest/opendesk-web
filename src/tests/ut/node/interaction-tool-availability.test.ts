/**
 * 交互工具 isAvailable 语义：
 * - AskUserTool：无人值守模式（interactive === false）不可用，其余可用
 * - ExitPlanModeTool：仅主 agent（agentId === 'main'）且 plan 模式可用
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExitPlanModeProvider } from '../../../main/aikernel/interaction/contracts.js';

// 延迟加载，因为模块顶层有副作用
const { AskUserTool } = await import('../../../main/aikernel/interaction/tools.js');
const { ExitPlanModeTool } = await import('../../../main/aikernel/interaction/exitPlanMode.js');

describe('交互工具 isAvailable', () => {
    describe('AskUserTool', () => {
        it('interactive: false 的模式 → false', () => {
            const tool = new AskUserTool();
            assert.equal(tool.isAvailable({ getAgentMode: () => ({ interactive: false }) } as any), false);
        });

        it('interactive: true 的模式 → true', () => {
            const tool = new AskUserTool();
            assert.equal(tool.isAvailable({ getAgentMode: () => ({ interactive: true }) } as any), true);
        });

        it('未声明 interactive（默认）→ true', () => {
            const tool = new AskUserTool();
            assert.equal(tool.isAvailable({ getAgentMode: () => ({}) } as any), true);
        });

        it('无 taskState → true', () => {
            const tool = new AskUserTool();
            assert.equal(tool.isAvailable(undefined), true);
        });

        it('cancelCurrent 转发到 provider', () => {
            const tool = new AskUserTool();
            let cancelled = false;
            tool.setProvider({
                cancelCurrent: () => {
                    cancelled = true;
                }
            } as any);
            tool.cancelCurrent();
            assert.equal(cancelled, true);
        });

        it('cancelCurrent 无 provider 时安全 no-op', () => {
            const tool = new AskUserTool();
            tool.cancelCurrent();
        });
    });

    describe('ExitPlanModeTool', () => {
        it('exposes only the contained plan relative path to a remote provider', async (t) => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-exit-plan-'));
            t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
            fs.mkdirSync(path.join(workspace, '.plan', 'nested'), { recursive: true });
            fs.writeFileSync(path.join(workspace, '.plan', 'nested', 'ship.md'), '# Ship\nDo the work', 'utf8');
            const calls: Parameters<ExitPlanModeProvider['promptAndSwitch']>[] = [];
            const provider: ExitPlanModeProvider = {
                promptAndSwitch: async (...args) => {
                    calls.push(args);
                    return { action: 'continue-editing' };
                }
            };
            const tool = new ExitPlanModeTool();
            tool.setProvider(provider);
            const result = await tool.execute({ planFilePath: '.plan/nested/ship.md' }, undefined, {
                task_id: 'child',
                task_name: 'Task',
                harnessContext: { workspace }
            } as any);
            assert.equal(result.status, 'success');
            assert.deepEqual(calls[0]?.[4], { planRelativePath: '.plan/nested/ship.md' });
            assert.equal(JSON.stringify(calls[0]?.[4]).includes(workspace), false);
            assert.match(result.result ?? '', /continue-editing/);
        });

        it('preserves the existing rejection for an empty workspace or escaped plan', async (t) => {
            const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-exit-plan-'));
            t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
            let providerCalls = 0;
            const tool = new ExitPlanModeTool();
            tool.setProvider({
                async promptAndSwitch() {
                    providerCalls += 1;
                    return { action: 'continue-editing' };
                }
            });
            const empty = await tool.execute({ planFilePath: '.plan/a.md' }, undefined, {
                harnessContext: { workspace: '' }
            } as any);
            const escaped = await tool.execute({ planFilePath: '../secret.md' }, undefined, {
                harnessContext: { workspace }
            } as any);
            assert.equal(empty.status, 'error');
            assert.equal(escaped.status, 'error');
            assert.equal(providerCalls, 0);
        });

        it('主 agent + plan 模式 → true', () => {
            const tool = new ExitPlanModeTool();
            assert.equal(
                tool.isAvailable({
                    getAgent: () => ({ agentId: 'main' }),
                    getAgentMode: () => ({ id: 'plan' })
                } as any),
                true
            );
        });

        it('非主 agent → false', () => {
            const tool = new ExitPlanModeTool();
            assert.equal(
                tool.isAvailable({
                    getAgent: () => ({ agentId: 'explore' }),
                    getAgentMode: () => ({ id: 'plan' })
                } as any),
                false
            );
        });

        it('主 agent 但非 plan 模式 → false', () => {
            const tool = new ExitPlanModeTool();
            assert.equal(
                tool.isAvailable({
                    getAgent: () => ({ agentId: 'main' }),
                    getAgentMode: () => ({ id: 'standard' })
                } as any),
                false
            );
        });

        it('无 taskState → false', () => {
            const tool = new ExitPlanModeTool();
            assert.equal(tool.isAvailable(undefined), false);
        });

        it('cancelCurrent 转发到 provider', () => {
            const tool = new ExitPlanModeTool();
            let cancelled = false;
            tool.setProvider({
                cancelCurrent: () => {
                    cancelled = true;
                }
            } as any);
            tool.cancelCurrent();
            assert.equal(cancelled, true);
        });
    });
});
