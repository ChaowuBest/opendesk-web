/**
 * AgentGate Hook — 将 OpenDesk 的工具调用发送到 AgentGate 进行安全分析。
 *
 * 工作原理:
 *   1. 注册全局 beforeToolCall hook
 *   2. 拦截 executeBash / executeZsh / executePowerShell 工具调用
 *   3. 将命令发送到 AgentGate POST /api/v1/analyze
 *   4. 根据返回的 decision 决定 Allow/Deny
 *
 * AgentGate 地址可通过环境变量 AGENT_GATE_URL 配置，默认 http://127.0.0.1:9100
 */

import { HookRegistry } from '../aikernel/hooks.js';
import type { TaskState } from '../aikernel/states/tasks.js';
import type { ToolCall } from '../aikernel/messages.js';

const GATE_URL = process.env.AGENT_GATE_URL || 'http://127.0.0.1:9100';
const AGENT_TYPE = 'opendes';
const AGENT_VERSION = '0.2.0';

/** 需要被拦截的 shell 工具名列表 */
const SHELL_TOOLS = new Set(['executeBash', 'executeZsh', 'executePowerShell']);

/** 是否已初始化 */
let initialized = false;

/**
 * 将命令发送到 AgentGate 做安全分析。
 * 返回 true 表示允许执行，false 表示应拦截。
 */
async function checkWithAgentGate(
    command: string,
    sessionId: string,
    toolName: string,
    cwd: string,
    userPrompt: string,
): Promise<{ allowed: boolean; reason: string; riskLevel: string }> {
    const payload: Record<string, unknown> = {
        agent_type: AGENT_TYPE,
        agent_version: AGENT_VERSION,
        session_id: sessionId,
        tool_name: toolName,
        command: command,
        cwd: cwd,
        description: `OpenDesk ${toolName}: ${command.slice(0, 200)}`,
        user_prompt: userPrompt,
        metadata: { source: 'opendes-hook' },
    };

    try {
        const response = await fetch(`${GATE_URL}/api/v1/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            // Fail-Closed: 网络错误时默认放行（避免阻断正常工作）
            console.error(`[AgentGate] HTTP ${response.status}: ${response.statusText}`);
            return { allowed: true, reason: 'Gate unreachable (fail-open)', riskLevel: '' };
        }

        const result = await response.json() as Record<string, unknown>;
        const decision = String(result.decision || 'Deny');
        const reason = String(result.reason || '');
        const riskLevel = String(result.risk_level || '');

        return {
            allowed: decision === 'Allow',
            reason,
            riskLevel,
        };
    } catch (err) {
        // Fail-Open: AgentGate 不可用时放行，避免阻断正常工作
        console.error(`[AgentGate] 请求失败: ${String(err)}`);
        return { allowed: true, reason: 'Gate unreachable (fail-open)', riskLevel: '' };
    }
}

/**
 * beforeToolCall 回调: 在工具执行前送往 AgentGate 审查。
 */
async function onBeforeToolCall(task: TaskState, toolCall: ToolCall): Promise<void> {
    // 只拦截 shell 工具
    if (!SHELL_TOOLS.has(toolCall.tool_name)) {
        return;
    }

    const command: string = toolCall.args_object?.['command'] || '';
    if (!command) return;

    const sessionId: string = task.task_id;
    const cwd: string =
        toolCall.args_object?.['workingDirectory'] ||
        task.getWorkspace?.() ||
        '';
    const userPrompt: string =
        task.chat_context?.lastUserMessage?.()?.getPlainText?.() ||
        task.task_name ||
        '';

    const { allowed, reason, riskLevel } = await checkWithAgentGate(
        command,
        sessionId,
        toolCall.tool_name,
        cwd,
        userPrompt,
    );

    if (!allowed) {
        // 拦截: 将工具状态设为 error，写入拒绝原因，阻止执行
        toolCall.status = 'error';
        toolCall.result = [
            `🚫 **AgentGate 安全拦截**`,
            ``,
            `- **风险等级**: ${riskLevel || 'unknown'}`,
            `- **原因**: ${reason || '未提供原因'}`,
            `- **命令**: \`${command.slice(0, 200)}\``,
            ``,
            `如需执行此命令，请确认操作安全性后重试。`,
        ].join('\n');
        toolCall.result_object = { blocked: true, reason, riskLevel };
    }
}

/**
 * 初始化 AgentGate Hook（幂等）。
 * 在 OpenDesk 启动时调用一次即可。
 */
export function initAgentGateHook(): void {
    if (initialized) return;
    initialized = true;

    HookRegistry.beforeToolCall(onBeforeToolCall);
    console.log(`[AgentGate] Hook 已注册 → ${GATE_URL}`);
}
