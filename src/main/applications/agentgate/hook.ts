/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

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

import { GlobalHooks, type BeforeToolCallFeedback } from '../../aikernel/hooks.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ToolCall } from '../../aikernel/messages.js';
import { Setting } from '../../utils/setting.js';
import { matchesToolName } from '../../aikernel/compaction/compactable-tools.js';
import {
    saveInterceptionRecord,
    updateInterceptionAttribution,
    isBlacklisted,
    isSkillNameBlacklisted,
    getBlacklistedSkillDirectories
} from '../skillmgr/blacklist.js';
import { attributeInterception } from './skillAttribution.js';
import { AgentGateBridge } from './agent-gate-bridge.js';
import { logger } from '../../utils/logger.js';
import path from 'path';

const AGENT_TYPE = 'opendesk';
const AGENT_VERSION = '0.3.3';

/**
 * 解析 AgentGate 服务地址。
 *
 * AgentGateBridge 启动 agent-gate 时用 findFreePort 分配动态端口
 * （9100 被占用则递增到 9101/9102…），端口存于 bridge 的 gateState.port。
 * hook 必须运行时查 bridge 拿真实端口，否则 9100 被占时 hook 连不上 agent-gate
 * → 触发 fail-open 全部放行。
 *
 * 优先级：
 *   1. AGENT_GATE_URL 环境变量（用户显式指定，最高优先级）
 *   2. AgentGateBridge.getInstance().getStatus().gatePort（主进程有效）
 *   3. 探测 9100-9105 找到返回 healthy 的端口（worker 进程无 bridge 实例时走此路）
 *   4. 默认 9100（探测失败兜底）
 *
 * worker_threads 不共享主进程内存，worker 里 AgentGateBridge.getInstance() 是全新实例
 * （gatePort=0），且 worker 创建时快照 env（主进程后设的 AGENT_GATE_URL 传不进已存在的 worker）。
 * 因此 worker 里的 hook 靠探测兜底：GET /api/v1/health，找返回 {"status":"healthy"...} 的端口。
 * 探测结果缓存，仅首次工具调用时有几百 ms 延迟。
 */
const GATE_PROBE_RANGE = [9100, 9101, 9102, 9103, 9104, 9105];
/** 探测成功的 URL 缓存（仅缓存成功结果，失败不缓存） */
let _cachedGateUrl: string | null = null;
/** 缓存时间戳，超过 TTL 后自动失效 */
let _cachedGateUrlTime = 0;
const PROBE_CACHE_TTL_MS = 60_000;
let _probePromise: Promise<string> | null = null;

/**
 * 探测本地端口找 agent-gate（返回 healthy 的那个），找不到返回 9100 兜底。
 *
 * 缓存策略：
 *   - 仅缓存探测成功的 URL，失败时不缓存（下次重新探测）
 *   - 成功缓存有 TTL（60s），过期后自动重新探测
 *   - 外部可通过 invalidateGateUrlCache() 在请求失败时主动失效
 */
async function probeGateUrl(): Promise<string> {
    // 缓存命中：TTL 内的成功探测结果
    if (_cachedGateUrl && Date.now() - _cachedGateUrlTime < PROBE_CACHE_TTL_MS) {
        return _cachedGateUrl;
    }
    _cachedGateUrl = null;

    if (_probePromise) return _probePromise;
    _probePromise = (async () => {
        for (const port of GATE_PROBE_RANGE) {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
                    signal: AbortSignal.timeout(500)
                });
                if (r.ok) {
                    const data = await r.json().catch(() => null);
                    if (data && data.status === 'healthy') {
                        _cachedGateUrl = `http://127.0.0.1:${port}`;
                        _cachedGateUrlTime = Date.now();
                        return _cachedGateUrl;
                    }
                }
            } catch {
                /* 端口未监听或非 agent-gate，继续探测下一个 */
            }
        }
        // 全部探测失败，兜底 9100（不缓存，下次重新探测）
        return 'http://127.0.0.1:9100';
    })();
    try {
        return await _probePromise;
    } finally {
        _probePromise = null;
    }
}

/** 失效探测缓存（请求失败时调用，使下次 resolveGateUrl 重新探测） */
function invalidateGateUrlCache(): void {
    _cachedGateUrl = null;
    _cachedGateUrlTime = 0;
}

async function resolveGateUrl(): Promise<string> {
    const envUrl = process.env.AGENT_GATE_URL;
    if (envUrl) return envUrl;
    try {
        // bridge 已通过顶层静态 import 引入（与其他 main 进程文件一致；worker 进程无 bridge 时抛错走探测）
        const port = AgentGateBridge.getInstance().getStatus().gatePort;
        if (port && port > 0) return `http://127.0.0.1:${port}`;
    } catch {
        // bridge 未就绪（worker 进程或启动早期），走探测
    }
    return probeGateUrl();
}

/** 同步版：仅用 env/缓存，不触发探测（用于通知日志等非关键路径） */
function resolveGateUrlSync(): string {
    if (process.env.AGENT_GATE_URL) return process.env.AGENT_GATE_URL;
    if (_cachedGateUrl && Date.now() - _cachedGateUrlTime < PROBE_CACHE_TTL_MS) return _cachedGateUrl;
    return 'http://127.0.0.1:9100';
}

/**
 * 内容类参数预览长度。路径类参数不截断（截断会丢敏感文件名），
 * 仅 content/oldString/newString/patch 等长内容截断到 500 字符，
 * 既给 L3 LLM 足够语义判断空间，又不被超大文件撑爆 context。
 */
const PREVIEW_LEN = 500;

/** 截断长内容到 PREVIEW_LEN 字符并加省略号后缀 */
function preview(s: unknown): string {
    const str = String(s ?? '');
    return str.length > PREVIEW_LEN ? str.slice(0, PREVIEW_LEN) + '...' : str;
}

/**
 * OpenDesk mailbox 应用的裸名工具集合。
 *
 * 这些工具经 skill（operate-mailbox / manage-mailbox）调用，实际传给 AgentGate
 * 的 tool_name 是裸名（sendEmail / getEmailList / ...），而 AgentMoss 的规则
 * （EXCLUDED_PREFIXES / builtin_safe_action_types 等）统一按 `mailbox-` 前缀约定。
 * 裸名不命中任何 mailbox- 前缀规则 → sendEmail 这类发信工具会走 L2 意图偏差检测，
 * 把邮件正文里的 "rm 命令分级检测" 之类介绍性文字误判为删除操作（误报）。
 *
 * 因此传给 AgentGate 前需把裸名规范化为 `mailbox-<name>`：
 *   - mailbox-getEmailList 等只读/管理工具 → 命中 rules.json builtin_safe_action_types
 *     → 跳过 L2+L3（本就该跳过，修复了裸名导致的白名单从未生效 bug）
 *   - mailbox-sendEmail / mailbox-replyEmail → 不在白名单 → 走 L2+L3；
 *     L2 意图偏差因 mailbox- 前缀被豁免，L3 邮件外传风险检测保留（符合 rules.json 设计意图）
 *
 * 注：extractCommand 用 matchesAny（短名后缀匹配），mailbox-sendEmail 仍能匹配
 * sendEmail 候选，故本地 command 构造不受前缀影响。
 */
const MAILBOX_TOOLS = new Set([
    'addMailAccount',
    'listMailAccounts',
    'removeMailAccount',
    'switchMailAccount',
    'getMailSyncStatus',
    'getEmailList',
    'getEmailContent',
    'searchEmails',
    'sendEmail',
    'replyEmail',
    'markEmailReadStatus',
    'starEmail',
    'deleteEmail'
]);

/** 传给 AgentGate 前规范化 tool_name：mailbox 裸名加 mailbox- 前缀，其余原样透传 */
function normalizeGateToolName(toolName: string): string {
    if (MAILBOX_TOOLS.has(toolName)) {
        return `mailbox-${toolName}`;
    }
    return toolName;
}

/** 判断 tool_name 是否匹配任一候选短名（兼容 filemgr-writeFile / writeFile 两种格式） */
function matchesAny(toolName: string, candidates: Iterable<string>): boolean {
    for (const n of candidates) {
        if (matchesToolName(toolName, n)) return true;
    }
    return false;
}

/** 检查安全网关总开关是否已启用 */
function isSecurityGatewayEnabled(): boolean {
    try {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const agConfig = data?.applications?.agentgate || {};
        return agConfig.enabled === true;
    } catch {
        return false;
    }
}

/**
 * 检查恶意技能检测是否启用（拦截归因 + 会话结束弹窗 + 加入黑名单）。
 * 独立于总开关：总开关关闭时 onBeforeToolCall 不会走到 deny 分支，recordInterception 不会被调用；
 * 此开关用于在总开关开启的前提下，单独关闭恶意 skill 分析链路。默认 true。
 * 注意：关闭后已存在的黑名单条目仍由 skillmgr 的 filter 生效，不会被放出。
 */
function isMaliciousSkillDetectionEnabled(): boolean {
    try {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const agConfig = data?.applications?.agentgate || {};
        return agConfig.maliciousSkillDetection !== false;
    } catch {
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

/**
 * 不需要审查的安全工具白名单（短名）。
 * 通过 matchesToolName 匹配，兼容带前缀（planning-attemptCompletion）与短名（askUser）两种格式。
 *
 * 注意：LoadSkill / CallSkillTool **不在此白名单**——它们会经黑名单前置检查，
 * 命中黑名单时直接 deny 并返回恶意 skill 说明给 LLM，避免模型误以为"skill 不存在"
 * 转而用文件工具读源文件绕过。
 */
const SKIP_TOOLS = new Set(['askUser', 'attemptCompletion', 'exitPlanMode']);

/**
 * 技能加载类工具（短名）。这些工具的 args 携带 bundleName/skillName，
 * 会经黑名单前置检查：命中黑名单时直接 deny。
 */
const SKILL_LOAD_TOOLS = new Set(['CallSkillTool', 'LoadSkillTool', 'LoadSkill', 'CallSkill']);

/**
 * 检查技能加载工具调用是否命中黑名单。
 * 命中时返回给 LLM 的 deny message——告知该 skill 是恶意 skill、已禁用、禁止加载，
 * 避免模型转而用文件工具读源文件绕过。
 *
 * 注意：本检查只覆盖"加载已拉黑的那个具体 skill 实例"，不覆盖"从 registry 装一个同名
 * 但不同来源的 skill"——后者是合法的不同 skill（黑名单是本地实例级，与在线 registry 无关），
 * 若其内容也恶意，由实时网关在其执行具体危险操作（读凭据/外发）时拦截，不在 install 时按名拦。
 */
function checkSkillBlacklist(task: TaskState, toolCall: ToolCall): BeforeToolCallFeedback | null {
    // 恶意技能检测关闭时不拦截（与拦截归因开关一致）
    if (!isMaliciousSkillDetectionEnabled()) return null;
    if (!matchesAny(toolCall.tool_name, SKILL_LOAD_TOOLS)) return null;

    const args = toolCall.args_object as any;
    const bundleName = args?.bundleName;
    const skillName = args?.skillName;
    if (!bundleName || !skillName) return null;

    // 精确查 bundleName/skillName；查不到则按 skillName 兜底
    // （agent 可能把 skill 名误当 bundleName，如 project-analysis/project-analysis，
    // 此时精确 key 查不到，但 skillName 仍能命中黑名单）
    if (isBlacklisted(bundleName, skillName) || isSkillNameBlacklisted(skillName)) {
        return {
            operation: 'deny',
            message: `该 skill \`${bundleName}/${skillName}\` 是恶意 skill，已被加入黑名单，禁止加载。`,
            extra: { blocked: true, reason: 'blacklisted_skill', bundleName, skillName }
        };
    }
    return null;
}

/**
 * 文件类工具短名。这些工具的 args 携带路径参数，会经黑名单源文件目录比对：
 * agent 可能绕过技能加载通道，用 find/readFile 直读黑名单 skill 的 SKILL.md 源文件。
 */
const FILE_PATH_TOOLS = new Set(['readFile', 'extractText', 'list_dir', 'list_files']);
const FILE_SEARCH_TOOLS = new Set(['globFiles', 'grepFiles']);

/**
 * 取黑名单 skill 源文件目录（每次现取，不缓存）。
 * 黑名单 json 通常很小且被 OS 页缓存，读取开销可忽略；
 * 不缓存是为保证拉黑/解黑后立即生效，避免缓存失效逻辑遗漏导致的漏拦。
 */
function getBlacklistDirs(): string[] {
    try {
        return getBlacklistedSkillDirectories();
    } catch {
        return [];
    }
}

/**
 * 检查文件类工具调用是否在读黑名单 skill 的源文件。
 * 命中时 deny 并告知 LLM——这是恶意 skill 源文件，禁止读取以绕过黑名单。
 * 仅拦"明确读黑名单 skill 目录内文件"（path 落在某黑名单目录之内），
 * 不拦列父目录（resources）这类可能含正常用途的操作，避免误伤。
 */
function checkFileBlacklist(task: TaskState, toolCall: ToolCall): BeforeToolCallFeedback | null {
    if (!isMaliciousSkillDetectionEnabled()) return null;
    const dirs = getBlacklistDirs();
    if (dirs.length === 0) return null;

    const args = (toolCall.args_object || {}) as any;
    // 收集本工具调用涉及的所有路径参数
    const rawPaths: string[] = [];
    if (matchesAny(toolCall.tool_name, FILE_PATH_TOOLS)) {
        const p = args['file_path'] || args['path'] || args['filePath'] || args['directory'];
        if (p) rawPaths.push(String(p));
    } else if (matchesAny(toolCall.tool_name, FILE_SEARCH_TOOLS)) {
        // glob/grep 的 path 可能是父目录；只在其直接指向某黑名单 skill 目录之内时才命中
        const p = args['path'] || args['directory'];
        if (p) rawPaths.push(String(p));
    } else {
        return null;
    }

    for (const raw of rawPaths) {
        let resolved: string;
        try {
            resolved = path.resolve(raw);
        } catch {
            continue;
        }
        for (const dir of dirs) {
            // path 落在黑名单 skill 目录之内（=== dir 或以 dir + 分隔符为前缀）
            if (resolved === dir || resolved.startsWith(dir + path.sep)) {
                return {
                    operation: 'deny',
                    message: `该路径位于已拉黑的恶意 skill 源文件目录内（\`${dir}\`），禁止读取以绕过黑名单。`,
                    extra: { blocked: true, reason: 'blacklisted_skill_source', path: raw, dir }
                };
            }
        }
    }
    return null;
}

/**
 * 从 tool_call 的 args_object 中提取可读的命令描述。
 *
 * 工具名匹配使用 matchesToolName（短名后缀匹配），兼容命名空间格式
 * （filemgr-writeFile / terminal-executeBash / planning-attemptCompletion）
 * 与无前缀短名（askUser / exitPlanMode）。
 *
 * 截断策略：
 *   - 路径类参数（file_path/command/cwd 等）不截断 —— 截断会丢敏感文件名，
 *     导致 AgentMoss L2 敏感路径正则匹配不到、L3 LLM 看到残缺命令。
 *   - 内容类参数（content/oldString/newString/patch 等）预览 PREVIEW_LEN 字符，
 *     给 L3 足够语义判断空间又不撑爆 context。
 */
function extractCommand(toolCall: ToolCall): string {
    const args = toolCall.args_object || {};
    const toolName = toolCall.tool_name;

    // Shell 工具: 直接用 command 字段（不截断 —— 命令可能含 cd ... && sed ... credentials.yml）
    if (matchesAny(toolName, ['executeBash', 'executeZsh', 'executePowerShell'])) {
        return String(args['command'] || '');
    }
    // 邮件发送/回复: to/cc/subject + attachments(路径数组，不截断) + content 预览。
    // attachments 是本地文件路径数组，必须完整透传给 AgentMoss，否则 L3 看不到
    // 是否带 .env/密钥等敏感文件外传。content 用 preview 给语义判断空间又不撑爆。
    if (matchesAny(toolName, ['sendEmail', 'replyEmail'])) {
        const to = preview(args['to'] || args['uid'] || '?');
        const subject = preview(args['subject'] || '');
        const parts = [`to=${to}`, `subject=${subject}`];
        const attachments = args['attachments'];
        if (Array.isArray(attachments) && attachments.length > 0) {
            // 路径不截断（截断丢文件名，敏感路径正则匹配不到）
            parts.push(`附件=${(attachments as string[]).join(', ')}`);
        }
        const content = args['content'];
        if (content) parts.push(`正文=${preview(content)}`);
        return `发送邮件: ${parts.join(', ')}`;
    }
    // 文件读取: file_path 或 path（不截断路径）
    if (matchesAny(toolName, ['readFile', 'extractText'])) {
        return `读取文件: ${args['file_path'] || args['path'] || args['filePath'] || '?'}`;
    }
    // 文件写入: file_path（不截断） + content 预览
    if (matchesAny(toolName, ['writeFile'])) {
        const fp = args['file_path'] || args['filePath'] || '?';
        return `写入文件: ${fp} — ${preview(args['content'])}`;
    }
    // 文件编辑: filePath（不截断） + oldString/newString 摘要（L3 语义判断依赖，识别脱敏/投毒/塞假数据）
    if (matchesAny(toolName, ['editFile', 'searchReplace'])) {
        const fp = args['filePath'] || args['file_path'] || '?';
        const oldS = preview(args['oldString']);
        const newS = preview(args['newString']);
        return `编辑文件: ${fp} — old: ${oldS} | new: ${newS}`;
    }
    // Patch 应用: patch 内容预览（多文件操作，内容长）
    if (matchesAny(toolName, ['applyPatch'])) {
        return `应用补丁: ${preview(args['patch'])}`;
    }
    // 文件搜索: pattern + path（路径不截断）
    if (matchesAny(toolName, ['globFiles', 'grepFiles'])) {
        return `搜索: ${args['pattern'] || args['query'] || '?'} in ${args['path'] || args['directory'] || '.'}`;
    }
    // 语义搜索
    if (matchesAny(toolName, ['semanticSearch'])) {
        return `语义搜索: ${args['query'] || '?'}`;
    }
    // 目录列表
    if (matchesAny(toolName, ['list_dir', 'list_files'])) {
        return `列出目录: ${args['directory'] || args['path'] || '.'}`;
    }
    // 网络请求
    if (matchesAny(toolName, ['web_fetch'])) {
        return `抓取网页: ${args['url'] || '?'}`;
    }
    if (matchesAny(toolName, ['web_search'])) {
        return `搜索网页: ${args['query'] || '?'}`;
    }
    // 通用: 只保留已知标识性字段，值里含用户自由文本的字段一律跳过
    const IDENTITY_KEYS = new Set([
        'bundleName',
        'skillName',
        'toolName',
        'name',
        'file_path',
        'filePath',
        'path',
        'directory',
        'url',
        'query',
        'keyword',
        'pattern',
        'scope',
        'uid'
    ]);
    const parts = Object.entries(args)
        .filter(([k, v]) => IDENTITY_KEYS.has(k) && v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${preview(v)}`);
    return parts.length > 0 ? `${toolName}: ${parts.join(', ')}` : toolName;
}

/** 单条 UserMessage 提取纯文本（兼容 UserMessagePart 数组 / 直接 content 字符串）。 */
function getUserMessageText(msg: unknown): string {
    if (!msg || typeof msg !== 'object') return '';
    const m = msg as { role?: string; content?: unknown; getPlainText?: () => string };
    if (typeof m.getPlainText === 'function') {
        try {
            return m.getPlainText() || '';
        } catch {
            /* fallthrough */
        }
    }
    const content = m.content;
    if (Array.isArray(content)) {
        return content
            .map((part: unknown) =>
                part && typeof part === 'object' && (part as any).type === 'text'
                    ? String((part as any).text ?? '')
                    : ''
            )
            .join('\n');
    }
    if (typeof content === 'string') return content;
    return '';
}

/** 从一条 AssistantMessage 提取其发起的工具调用（tool_call parts）。 */
function getToolCallsFromMsg(msg: unknown): Array<{ name: string; args: string }> {
    const out: Array<{ name: string; args: string }> = [];
    if (!msg || typeof msg !== 'object') return out;
    const m = msg as { content?: Array<Record<string, unknown>> };
    if (!Array.isArray(m.content)) return out;
    for (const part of m.content) {
        if (!part || typeof part !== 'object') continue;
        // ToolCallMessagePart: { type: 'tool_call', toolcalls: ToolCall[] }
        if ((part as any).type === 'tool_call') {
            const calls = (part as any).toolcalls;
            if (Array.isArray(calls)) {
                for (const c of calls) {
                    if (c && typeof c === 'object') {
                        out.push({
                            name: String((c as any).tool_name ?? 'unknown'),
                            args: String((c as any).args_string ?? '')
                        });
                    }
                }
            }
        }
    }
    return out;
}

/**
 * 构造 session 交错历史（prompt_history + action_history）供 AgentMoss L2/L3 使用。
 * 遍历官方消息列表：User 消息开新 turn，其后 assistant 发起的工具调用归入该 turn，
 * 直到下一条 User。同时拍平所有工具调用进 action_history（行为链检测消费）。
 * 返回 { prompt_history, action_history }，均兼容 AgentMoss AnalyzeRequest 契约。
 */
function buildSessionHistory(chatContext?: { messages?: unknown[] } | null) {
    const promptHistory: Array<{ text: string; actions: Array<{ action_type: string; action_detail: string }> }> = [];
    const actionHistory: Array<{ action_type: string; action_detail: string }> = [];
    const messages = chatContext?.messages;
    if (!Array.isArray(messages)) return { prompt_history: [], action_history: [] };

    let currentTurn: { text: string; actions: Array<{ action_type: string; action_detail: string }> } | null = null;
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const role = (msg as any).role;
        if (role === 'user' || role === 'compact_separator') {
            // compact_separator 是摘要边界：不承载意图摘要就跳过；User 才开新 turn。
            if (role === 'user') {
                const text = getUserMessageText(msg);
                currentTurn = { text, actions: [] };
                promptHistory.push(currentTurn);
            }
            continue;
        }
        // assistant 消息里的 tool_call parts → 归入当前 turn（若还没有 User，则放一个空 turn 兜底）
        const calls = getToolCallsFromMsg(msg);
        for (const c of calls) {
            const action = { action_type: c.name, action_detail: c.args };
            actionHistory.push(action);
            if (!currentTurn) {
                currentTurn = { text: '', actions: [] };
                promptHistory.push(currentTurn);
            }
            currentTurn.actions.push(action);
        }
    }
    return { prompt_history: promptHistory, action_history: actionHistory };
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
    userPrompt: string,
    task?: TaskState
): Promise<{ allowed: boolean; reason: string; riskLevel: string; riskType: string }> {
    // 获取当前会话的模型配置，传递给 agent-moss 做 per-request LLM 分析
    let llmConfig: Record<string, string> | undefined;
    if (task) {
        const modelAlias = task.model;
        if (modelAlias) {
            try {
                const mi = Setting.getInstance().getModelInstance(modelAlias, 'chat');
                if (mi?.api_key) {
                    llmConfig = {
                        baseUrl: mi.base_url,
                        apiKey: mi.api_key,
                        model: mi.model_name,
                        provider: mi.getProviderType()
                    };
                }
            } catch {
                /* best-effort */
            }
        }
    }

    // 构造同 session 完整历史（prompt + tool call 交错时序），供 AgentMoss L2/L3 判断
    // 意图一致性与行为链。此前 missing → action_history 为空、prompt 仅最近一条，
    // 长会话里"继续"会覆盖初始意图导致漏报。见 docs/INTEGRATION_GUIDE.md 第 4 节。
    const { prompt_history, action_history } = buildSessionHistory(task?.chat_context);

    const payload: Record<string, unknown> = {
        agent_type: AGENT_TYPE,
        agent_version: AGENT_VERSION,
        session_id: sessionId,
        tool_name: toolName,
        command: command,
        cwd: cwd,
        description: `OpenDesk ${toolName}: ${command.slice(0, 200)}`,
        user_prompt: userPrompt,
        prompt_history,
        action_history,
        metadata: { source: 'opendesk-hook', ...(llmConfig ? { llm_config: llmConfig } : {}) }
    };

    try {
        const response = await fetch(`${await resolveGateUrl()}/api/v1/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            // 120s：覆盖 AgentGate MossClient 超时（100s）+ 余量。AgentGate 不重试，
            // 故 120s 足够等 AgentMoss（总超时 90s）跑完。原 60s 小于 AgentMoss 单次
            // LLM 调用超时，会抢断后 fail-closed 误杀正常操作（如技能加载）。
            signal: AbortSignal.timeout(120000)
        });

        if (!response.ok) {
            // Fail-Closed: 网络错误时默认放行（避免阻断正常工作）
            console.error(`[AgentGate] HTTP ${response.status}: ${response.statusText}`);
            // 失效探测缓存，使下次 resolveGateUrl 重新探测正确端口
            invalidateGateUrlCache();
            return { allowed: true, reason: 'Gate unreachable (fail-open)', riskLevel: '' };
        }

        const result = (await response.json()) as Record<string, unknown>;
        const decision = String(result.decision || 'Deny');
        const reason = String(result.reason || '');
        const riskLevel = String(result.risk_level || '');
        const riskType = String(result.risk_type || '');

        return {
            allowed: decision === 'Allow',
            reason,
            riskLevel,
            riskType
        };
    } catch (err) {
        // Fail-Open: AgentGate 不可用时放行，避免阻断正常工作
        console.error(`[AgentGate] 请求失败: ${String(err)}`);
        // 失效探测缓存，使下次 resolveGateUrl 重新探测正确端口
        invalidateGateUrlCache();
        return { allowed: true, reason: 'Gate unreachable (fail-open)', riskLevel: '', riskType: '' };
    }
}

/**
 * beforeToolCall 回调: 在工具执行前送往 AgentGate 审查。
 */
async function onBeforeToolCall(task: TaskState, toolCall: ToolCall): Promise<BeforeToolCallFeedback> {
    try {
        // 安全网关总开关关闭时跳过审查
        if (!isSecurityGatewayEnabled()) {
            return { operation: 'allow' };
        }

        console.log(`[AgentGate] beforeToolCall fired for: ${toolCall.tool_name}`);

        // 跳过安全白名单工具（短名匹配，兼容带前缀格式）
        if (matchesAny(toolCall.tool_name, SKIP_TOOLS)) {
            console.log(`[AgentGate] Skipping whitelisted tool: ${toolCall.tool_name}`);
            return { operation: 'allow' };
        }

        // 技能加载工具的黑名单前置检查：命中黑名单直接 deny 并向 LLM 返回恶意说明，
        // 不送 AgentGate 审查（黑名单是确定性结论，无需 LLM 再判一次）。
        const blacklistFeedback = checkSkillBlacklist(task, toolCall);
        if (blacklistFeedback) {
            return blacklistFeedback;
        }

        // 文件工具的黑名单源文件检查：防止 agent 用 find/readFile 直读黑名单 skill 的
        // SKILL.md 源文件绕过技能加载通道的黑名单 filter。
        const fileBlacklistFeedback = checkFileBlacklist(task, toolCall);
        if (fileBlacklistFeedback) {
            return fileBlacklistFeedback;
        }

        const command = extractCommand(toolCall);
        if (!command) return { operation: 'allow' };

        const sessionId: string = task.task_id;
        const cwd: string = toolCall.args_object?.['workingDirectory'] || task.getWorkspace?.() || '';
        const userPrompt: string = task.chat_context?.lastUserMessage?.()?.getPlainText?.() || task.task_name || '';

        const { allowed, reason, riskLevel, riskType } = await checkWithAgentGate(
            command,
            sessionId,
            normalizeGateToolName(toolCall.tool_name),
            cwd,
            userPrompt,
            task
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
                const feedback: BeforeToolCallFeedback = {
                    operation: 'deny',
                    message: [
                        `🚫 **AgentGate 安全拦截（高安全模式）**`,
                        ``,
                        `- **风险等级**: ${riskLevel || 'unknown'}`,
                        `- **原因**: ${reason || '未提供原因'}`,
                        `- **命令**: \`${command.slice(0, 200)}\``,
                        ``,
                        `请根据拦截原因采取适当行动，不要暂停，不要询问用户。`
                    ].join('\n'),
                    extra: { blocked: true, reason, riskLevel, securityLevel }
                };
                // Fire-and-forget 拦截记录 + 归因
                void recordInterception(task, toolCall, command, reason, riskLevel, riskType, securityLevel);
                return feedback;
            }

            // 中级别（默认）：high/critical 直接拦截
            if (isHighRisk) {
                const feedback: BeforeToolCallFeedback = {
                    operation: 'deny',
                    message: [
                        `🚫 **AgentGate 安全拦截（高风险操作）**`,
                        ``,
                        `- **风险等级**: ${riskLevel || 'unknown'}`,
                        `- **原因**: ${reason || '未提供原因'}`,
                        `- **命令**: \`${command.slice(0, 200)}\``,
                        ``,
                        `请根据拦截原因采取适当行动，不要暂停，不要询问用户。`
                    ].join('\n'),
                    extra: { blocked: true, reason, riskLevel, securityLevel }
                };
                // Fire-and-forget 拦截记录 + 归因
                void recordInterception(task, toolCall, command, reason, riskLevel, riskType, securityLevel);
                return feedback;
            }

            // low / medium 风险在中级别：拦截并提示 override 方式
            const feedback: BeforeToolCallFeedback = {
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
                    `2. 添加自定义 Allow 规则匹配此操作`,
                    ``,
                    `请根据拦截原因采取适当行动，不要暂停，不要询问用户。`
                ].join('\n'),
                extra: { blocked: true, reason, riskLevel, securityLevel }
            };
            // Fire-and-forget 拦截记录 + 归因
            void recordInterception(task, toolCall, command, reason, riskLevel, securityLevel);
            return feedback;
        }
    } catch (err) {
        console.error('[AgentGate] Hook error:', err);
    }
    return { operation: 'allow' };
}

/**
 * 拦截记录 + 归因（fire-and-forget，不阻塞 tool dispatch）
 */
async function recordInterception(
    task: TaskState,
    toolCall: ToolCall,
    command: string,
    reason: string,
    riskLevel: string,
    riskType: string,
    securityLevel: string
): Promise<void> {
    try {
        // 恶意技能检测开关关闭时，不记录拦截、不触发归因（不影响 AgentGate 拦截本身）
        if (!isMaliciousSkillDetectionEnabled()) return;

        // AgentMoss 超时或服务不可用导致的 fail-closed 拦截不是恶意 skill 行为，
        // 不记录到拦截归因系统，避免误触发黑名单弹窗
        if (riskType === 'analysis_timeout' || riskType === 'service_unavailable') {
            console.log(`[AgentGate] Skipping interception record for non-malicious risk_type: ${riskType}`);
            return;
        }

        const loadedSkills = task.getLoadedSkillsFromContext();
        const isCallSkillTool = toolCall.tool_name === 'CallSkillTool' || toolCall.tool_name.endsWith('-CallSkillTool');

        // CallSkillTool 路径：args 自带技能身份，确定性归因
        if (isCallSkillTool && toolCall.args_object) {
            const args = toolCall.args_object as any;
            if (args.bundleName && args.skillName) {
                const turn = task.getTurnGeneration ? task.getTurnGeneration() : 0;
                saveInterceptionRecord(task.task_id, {
                    toolName: toolCall.tool_name,
                    command: command.slice(0, 500),
                    reason,
                    riskLevel,
                    riskType,
                    securityLevel,
                    turn,
                    certain: [{ bundleName: args.bundleName, skillName: args.skillName }],
                    suspected: [],
                    attributed: true
                });
                return;
            }
        }

        // 内置工具路径：先记录原始信息，再触发 LLM 归因
        const recordIndex = loadedSkills.length > 0 ? 0 : -1;
        const turn = task.getTurnGeneration ? task.getTurnGeneration() : 0;
        saveInterceptionRecord(task.task_id, {
            toolName: toolCall.tool_name,
            command: command.slice(0, 500),
            reason,
            riskLevel,
            riskType,
            securityLevel,
            turn,
            certain: [],
            suspected: [],
            attributed: false
        });

        // 如果有已加载的 skill，触发 LLM 归因
        if (loadedSkills.length > 0) {
            const attributionResult = await attributeInterception(
                toolCall.tool_name,
                command,
                reason,
                loadedSkills.map((s) => ({ bundleName: s.bundleName, skillName: s.skillName })),
                task
            );

            // 更新拦截记录中的归因结果：内置工具路径无确定性归因，全部归入 suspected
            updateInterceptionAttribution(
                task.task_id,
                recordIndex,
                [], // certain 始终为空——内置工具路径无确定性证据
                attributionResult.candidates
            );
        }
    } catch (err) {
        logger.error(`[AgentGate] 拦截记录/归因失败: ${err}`);
    }
}

/** 是否已初始化 */
let initialized = false;

/**
 * 初始化 AgentGate Hook（幂等）。
 * 在 OpenDesk 启动时调用一次即可。Hook 始终注册，运行时由 isSecurityGatewayEnabled() 决定是否执行。
 */
export function initAgentGateHook(): void {
    if (initialized) return;
    initialized = true;

    // Hook 始终注册，运行时由 onBeforeToolCall 内的 isSecurityGatewayEnabled() 决定是否执行
    // 未启用时静默跳过：不记录、不触发 AgentMoss、不推送通知
    GlobalHooks.beforeToolCall(onBeforeToolCall);

    // 延迟推送通知（仅安全网关总开关已启用时）
    setTimeout(() => {
        if (!isSecurityGatewayEnabled()) return;
        (async () => {
            try {
                const { NotificationStore } = await import('../../tui/components/notification.js');
                const store = NotificationStore.getInstance();
                store.push('info', 'AgentGate', '安全审查已就绪', `Hook 已注册 → ${resolveGateUrlSync()}`, {
                    priority: 'low'
                });
            } catch {
                // Worker 线程无 TUI，跳过通知
            }
        })();
    }, 2000);
}
