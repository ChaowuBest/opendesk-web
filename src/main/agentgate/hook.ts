/**
 * AgentGate Hook — 将 OpenDesk 的工具调用发送到 AgentGate 进行安全分析。
 *
 * 工作原理:
 *   1. 注册全局 beforeToolCall hook
 *   2. 拦截所有工具调用（shell、文件读写、搜索、网络等）
 *   3. 将命令发送到 AgentGate POST /api/v1/analyze
 *   4. 根据返回的 decision 决定 Allow/Deny
 *
 * AgentGate 地址可通过环境变量 AGENT_GATE_URL 配置，默认 http://127.0.0.1:9100
 */

import { HookRegistry, type BeforeToolCallFeedback } from '../aikernel/hooks.js';
import type { TaskState } from '../aikernel/states/tasks.js';
import type { ToolCall } from '../aikernel/messages.js';
import { Setting } from '../utils/setting.js';

const GATE_URL = process.env.AGENT_GATE_URL || 'http://127.0.0.1:9100';
const AGENT_TYPE = 'opendesk';
const AGENT_VERSION = '0.2.0';

/** 检查试验性功能是否已启用 */
function isExperimentalFeatureEnabled(): boolean {
    try {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        return !!data?.debug?.experimental_feature;
    } catch {
        // Setting 不可用时回退为 false（不启用）
        return false;
    }
}

/** 读取当前安全拦截级别，默认 'medium' */
function getSecurityLevel(): 'low' | 'medium' | 'high' {
    try {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const apps = data?.applications || {};
        const ag = apps?.agentgate || {};
        const level = ag?.securityLevel;
        if (level === 'low' || level === 'medium' || level === 'high') return level;
    } catch {
        // Setting 不可用时回退为 medium
    }
    return 'medium';
}

/** 不需要审查的安全工具白名单 */
const SKIP_TOOLS = new Set(['ask_user_question', 'attempt_completion', 'exitPlanMode']);

/** 是否已初始化 */
let initialized = false;

/**
 * 从 tool_call 的 args_object 中提取可读的命令描述。
 */
function extractCommand(toolCall: ToolCall): string {
    const args = toolCall.args_object || {};
    const toolName = toolCall.tool_name;

    // Shell 工具: 直接用 command 字段
    if (['executeBash', 'executeZsh', 'executePowerShell'].includes(toolName)) {
        return String(args['command'] || '');
    }
    // 文件读取: file_path 或 path
    if (['read_file', 'file_read', 'read'].includes(toolName)) {
        return `读取文件: ${args['file_path'] || args['path'] || args['filePath'] || '?'}`;
    }
    // 文件写入: file_path + 内容摘要
    if (['write_to_file', 'file_write', 'write'].includes(toolName)) {
        const fp = args['file_path'] || args['filePath'] || '?';
        const content = String(args['content'] || '');
        const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
        return `写入文件: ${fp} — ${preview}`;
    }
    // 文件编辑
    if (['file_edit', 'edit'].includes(toolName)) {
        return `编辑文件: ${args['file_path'] || args['filePath'] || '?'}`;
    }
    // 搜索
    if (['search_content', 'grep'].includes(toolName)) {
        return `搜索: ${args['pattern'] || args['query'] || '?'} in ${args['directory'] || args['path'] || '.'}`;
    }
    // 目录列表
    if (['list_dir', 'list_files'].includes(toolName)) {
        return `列出目录: ${args['directory'] || args['path'] || '.'}`;
    }
    // 网络请求
    if (['web_fetch'].includes(toolName)) {
        return `抓取网页: ${args['url'] || '?'}`;
    }
    if (['web_search'].includes(toolName)) {
        return `搜索网页: ${args['query'] || '?'}`;
    }
    // 通用: 拼接所有 args
    const parts = Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${String(v).slice(0, 50)}`);
    return parts.length > 0 ? `${toolName}: ${parts.join(', ')}` : toolName;
}

/**
 * 将命令发送到 AgentGate 做安全分析。
 * 返回 true 表示允许执行，false 表示应拦截。
 */
async function checkWithAgentGate(
    command: string,
    sessionId: string,
    toolName: string,
    cwd: string,
    userPrompt: string
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
        metadata: { source: 'opendesk-hook' }
    };

    try {
        const response = await fetch(`${GATE_URL}/api/v1/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
            // Fail-Closed: 网络错误时默认放行（避免阻断正常工作）
            console.error(`[AgentGate] HTTP ${response.status}: ${response.statusText}`);
            return { allowed: true, reason: 'Gate unreachable (fail-open)', riskLevel: '' };
        }

        const result = (await response.json()) as Record<string, unknown>;
        const decision = String(result.decision || 'Deny');
        const reason = String(result.reason || '');
        const riskLevel = String(result.risk_level || '');

        return {
            allowed: decision === 'Allow',
            reason,
            riskLevel
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
async function onBeforeToolCall(task: TaskState, toolCall: ToolCall): Promise<BeforeToolCallFeedback> {
    try {
        // 试验性功能关闭时跳过所有审查
        if (!isExperimentalFeatureEnabled()) return { operation: 'allow' };

        console.log(`[AgentGate] beforeToolCall fired for: ${toolCall.tool_name}`);

        // 跳过安全白名单工具
        if (SKIP_TOOLS.has(toolCall.tool_name)) {
            console.log(`[AgentGate] Skipping whitelisted tool: ${toolCall.tool_name}`);
            return { operation: 'allow' };
        }

        const command = extractCommand(toolCall);
        if (!command) return { operation: 'allow' };

        const sessionId: string = task.task_id;
        const cwd: string = toolCall.args_object?.['workingDirectory'] || task.getWorkspace?.() || '';
        const userPrompt: string = task.chat_context?.lastUserMessage?.()?.getPlainText?.() || task.task_name || '';

        const { allowed, reason, riskLevel } = await checkWithAgentGate(
            command,
            sessionId,
            toolCall.tool_name,
            cwd,
            userPrompt
        );

        if (!allowed) {
            const securityLevel = getSecurityLevel();
            const isHighRisk = riskLevel === 'high' || riskLevel === 'critical';

            // 低级别：仅警告，不拦截
            if (securityLevel === 'low') {
                console.log(`[AgentGate] ⚠️ LOW security — 警告但放行: ${command.slice(0, 80)} (${riskLevel})`);
                return { operation: 'allow' };
            }

            // 高级别：任何 deny 一律拦截
            if (securityLevel === 'high') {
                return {
                    operation: 'deny',
                    message: [
                        `🚫 **AgentGate 安全拦截（高安全模式）**`,
                        ``,
                        `- **风险等级**: ${riskLevel || 'unknown'}`,
                        `- **原因**: ${reason || '未提供原因'}`,
                        `- **命令**: \`${command.slice(0, 200)}\``
                    ].join('\n'),
                    extra: { blocked: true, reason, riskLevel, securityLevel }
                };
            }

            // 中级别（默认）：high/critical 直接拦截
            if (isHighRisk) {
                return {
                    operation: 'deny',
                    message: [
                        `🚫 **AgentGate 安全拦截（高风险操作）**`,
                        ``,
                        `- **风险等级**: ${riskLevel || 'unknown'}`,
                        `- **原因**: ${reason || '未提供原因'}`,
                        `- **命令**: \`${command.slice(0, 200)}\``
                    ].join('\n'),
                    extra: { blocked: true, reason, riskLevel, securityLevel }
                };
            }

            // low / medium 风险在中级别：拦截并提示 override 方式
            return {
                operation: 'deny',
                message: [
                    `🚫 **AgentGate 安全拦截**`,
                    ``,
                    `- **风险等级**: ${riskLevel || 'unknown'}`,
                    `- **原因**: ${reason || '未提供原因'}`,
                    `- **命令**: \`${command.slice(0, 200)}\``,
                    ``,
                    `💡 **如需继续执行，可通过以下方式 override：**`,
                    `1. 在 AgentGate 配置中将「安全拦截程度」调为「低」`,
                    `2. 添加自定义 Allow 规则匹配此操作`
                ].join('\n'),
                extra: { blocked: true, reason, riskLevel, securityLevel }
            };
        }
    } catch (err) {
        console.error('[AgentGate] Hook error:', err);
    }
    return { operation: 'allow' };
}

/**
 * 初始化 AgentGate Hook（幂等）。
 * 在 OpenDesk 启动时调用一次即可。
 */
export function initAgentGateHook(): void {
    if (initialized) return;
    initialized = true;

    // Hook 始终注册，运行时由 onBeforeToolCall 内的 isExperimentalFeatureEnabled() 决定是否执行
    // 未启用时静默跳过：不记录、不触发 AgentMoss、不推送通知
    HookRegistry.beforeToolCall(onBeforeToolCall);

    // 延迟推送通知（仅试验性功能已启用且主进程有 TUI 时）
    setTimeout(() => {
        if (!isExperimentalFeatureEnabled()) return;
        try {
            const { NotificationStore } = require('../tui/components/notification.js');
            const store = NotificationStore.getInstance();
            store.push('info', 'AgentGate', '安全审查已就绪', `Hook 已注册 → ${GATE_URL}`, { priority: 'low' });
        } catch {
            // Worker 线程无 TUI，跳过通知
        }
    }, 2000);
}
