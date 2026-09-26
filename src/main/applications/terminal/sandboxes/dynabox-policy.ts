/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { PermissionRule } from '../../../aikernel/security/permission.js';

export function expandPermissionPattern(pattern: string): string[] {
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized.endsWith('{,/**}')) {
        const base = normalized.slice(0, -'{,/**}'.length).replace(/\/$/, '');
        return [base || '/', `${base || ''}/**`];
    }
    return [normalized];
}

/** Windows：宿主盘符路径 → 沙箱根相对路径（/C/foo ↔ C:\foo）；非盘符路径返回 null。 */
export function hostPatternToVirtual(pattern: string): string | null {
    const normalized = pattern.replace(/\\/g, '/');
    const drive = /^([A-Za-z]):(?:\/(.*))?$/.exec(normalized);
    if (drive) return `/${drive[1].toUpperCase()}${drive[2] ? `/${drive[2]}` : ''}`;
    return null;
}

/**
 * Linux 透明路径：沙箱内路径即宿主路径（恒等）。返回 null 表示无法映射
 * （非绝对路径且非 `**`）：跳过该规则，避免导出非法 path 导致策略加载失败。
 */
export function hostPatternToVirtualLinux(pattern: string): string | null {
    if (pattern === '**') return '/**';
    const normalized = pattern.replace(/\\/g, '/');
    return normalized.startsWith('/') ? normalized : null;
}

function orderedRules(rules: PermissionRule[] | undefined): PermissionRule[] {
    // GlobPermissionEnforcer evaluates deny > ask > allow regardless of insertion
    // order. Keep the same precedence in Policy's first-match table.
    const rank = { deny: 0, ask: 1, allow: 2 } as const;
    return [...(rules || [])].sort((left, right) => rank[left.effect] - rank[right.effect]);
}

function rulesToLines(rules: PermissionRule[] | undefined, toVirtual: (expanded: string) => string | null): string[] {
    const lines: string[] = [];
    for (const rule of orderedRules(rules)) {
        if (rule.resourceType !== 'file' && rule.resourceType !== '*') continue;
        const access = rule.action === '*' ? 'all' : rule.action;
        if (!['read', 'write', 'execute', 'all'].includes(access)) continue;
        if (access === 'execute') continue;
        const exportedAccesses = access === 'all' ? ['read', 'write'] : [access];
        for (const expanded of expandPermissionPattern(rule.pathPattern)) {
            const virtual = toVirtual(expanded);
            if (!virtual) continue;
            for (const exportedAccess of exportedAccesses) {
                lines.push(
                    `[[rules]]\npath = ${JSON.stringify(virtual)}\naccess = ${JSON.stringify(exportedAccess)}\nperm = ${JSON.stringify(rule.effect)}`
                );
            }
        }
    }
    return lines;
}

/** Windows 版策略文本（/C/... 前缀语义）。 */
export function permissionRulesForSandbox(rules: PermissionRule[] | undefined): string[] {
    return rulesToLines(rules, (expanded) => (expanded === '**' ? '/**' : hostPatternToVirtual(expanded)));
}

export function policyText(endpoint: string, token: string, rules?: PermissionRule[], home?: string): string {
    const quote = (value: string) => JSON.stringify(value);
    // Windows 侧工具链缓存重定向（与 linux-sandbox.ts 的 ~/.cache/opendesk-sandbox
    // 同语义）：npm/jest 缓存写放行到宿主持久目录，跨沙箱实例复用（首次才下载）。
    // home 为宿主用户目录（如 C:\Users\liyif），经 hostPatternToVirtual 映射为
    // /C/Users/liyif/... 虚路径；写放行早于兜底 write ask 命中。
    const cacheRoot =
        home && home.length > 0 ? hostPatternToVirtual(`${home.replace(/\\/g, '/')}/.cache/opendesk-sandbox/**`) : null;
    return [
        'version = 1',
        'default = "deny"',
        '',
        '[ask]',
        `endpoint = ${quote(endpoint)}`,
        `token = ${quote(token)}`,
        // The UI allows five minutes, including queue time. Leave transport headroom.
        'timeout_ms = 330000',
        'cache_ttl_seconds = 0',
        'grant_ttl_seconds = 0',
        '',
        ...permissionRulesForSandbox(rules),
        // 工具链缓存目录写入放行（沙箱 env 重定向：npm_config_cache 等指向
        // ~/.cache/opendesk-sandbox/...，见 prepareDynamicSandbox）
        ...(cacheRoot ? [`[[rules]]\npath = ${quote(cacheRoot)}\naccess = "write"\nperm = "allow"`] : []),
        '[[rules]]',
        'path = "/**"',
        'access = "read"',
        'perm = "allow"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "write"',
        'perm = "ask"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "execute"',
        'perm = "allow"',
        ''
    ].join('\n');
}

/** Linux 版策略文本：透明路径（roots virtual=real=工作区），规则 path 为宿主真实路径。 */
export function permissionRulesForSandboxLinux(rules: PermissionRule[] | undefined): string[] {
    return rulesToLines(rules, hostPatternToVirtualLinux);
}

/** 整根读放行兜底下的显式收窄：家目录内不允许读取的敏感路径 */
const SENSITIVE_HOME_DIRS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.netrc',
    '.kube',
    '.config/gcloud',
    '.config/gh',
    '.git-credentials'
];

export function policyTextLinux(
    endpoint: string,
    token: string,
    workspace: string,
    rules?: PermissionRule[],
    home?: string
): string {
    const quote = (value: string) => JSON.stringify(value);
    const workspaceRoot = workspace.replace(/\/+$/, '') || '/';
    return [
        'version = 1',
        'default = "deny"',
        '',
        // 整根视图：FUSE 挂到沙箱根，沙箱内布局与宿主完全一致；系统目录在其上
        // 只读 bind 覆盖，其余路径读写经策略检查（写工作区放行，其余询问）
        '[[roots]]',
        'virtual = "/"',
        'real    = "/"',
        '',
        '[ask]',
        `endpoint = ${quote(endpoint)}`,
        `token = ${quote(token)}`,
        // The UI allows five minutes, including queue time. Leave transport headroom.
        'timeout_ms = 330000',
        'cache_ttl_seconds = 0',
        'grant_ttl_seconds = 0',
        '',
        ...permissionRulesForSandboxLinux(rules),
        // git 全局身份配置允许写（沙箱内 git commit 常用；凭据文件在敏感清单中已 deny）
        ...(home ? [`[[rules]]\npath = ${quote(`${home}/.gitconfig`)}\naccess = "write"\nperm = "allow"`] : []),
        // 家目录敏感路径读 deny（整根布局下默认读放行，须显式收窄私密文件）
        ...(home
            ? SENSITIVE_HOME_DIRS.map(
                  (dir) => `[[rules]]\npath = ${quote(`${home}/${dir}/**`)}\naccess = "read"\nperm = "deny"`
              )
            : []),
        // 工具链缓存目录写入放行（linux-sandbox 的 env 重定向：CARGO_HOME/
        // npm_config_cache/GOCACHE 等指向 ~/.cache/opendesk-sandbox/...）
        ...(home
            ? [`[[rules]]\npath = ${quote(`${home}/.cache/opendesk-sandbox/**`)}\naccess = "write"\nperm = "allow"`]
            : []),
        // 任务工作区写入放行（早于兜底 write ask 命中）
        '[[rules]]',
        `path = ${quote(`${workspaceRoot}/**`)}`,
        'access = "write"',
        'perm = "allow"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "read"',
        'perm = "allow"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "write"',
        'perm = "ask"',
        '',
        '[[rules]]',
        'path = "/**"',
        'access = "execute"',
        'perm = "allow"',
        ''
    ].join('\n');
}
