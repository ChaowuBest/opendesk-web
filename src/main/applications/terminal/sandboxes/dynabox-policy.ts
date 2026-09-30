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
    // 宿主用户 Temp（%TEMP%）：AppContainer 强制把沙箱内 %TEMP% 私有化，dynobox 在
    // 镜像层把私有 AC\Temp 的落点改写为宿主 Temp（跨实例共享）。此处放行写，使
    // jest transform 缓存（os.tmpdir()/jest）与 node-compile-cache 与宿主共用。
    const tempRoot =
        home && home.length > 0 ? hostPatternToVirtual(`${home.replace(/\\/g, '/')}/AppData/Local/Temp/**`) : null;
    // Windows 框架/PowerShell 启动时的静默写入路径（组件存储、缓存、Recent 跳转
    // 列表等）。这些路径在普通令牌下本就写不动（OS ACL 拒绝），放通只为免去每次
    // 触发 write ask 弹窗。顺序：用户 deny 规则仍在此之前（permissionRulesForSandbox
    // 按 deny > ask > allow 排序），系统放行不会覆盖用户显式拒绝。
    // 注意：$RECYCLE.BIN 不放通——回收站是误删数据的恢复区，agent 若可写就能清理
    // 整个回收站（数据风险）；而 --del-to-trash 写入回收站经 SHFileOperation 内部
    // 操作（hook 已用进程级 RecycleGuard 抑制，不做策略判定），本就无需放通。
    const systemWritePaths = [
        '/C/Windows/system32/catroot**', // Windows Update 组件存储（catroot/catroot2）
        '/C/Windows/Temp/**', // 系统 Temp（安装器/更新临时文件）
        '/C/ProgramData/Microsoft/Windows/Caches/**', // 系统级缓存
        '/C/Users/*/AppData/Local/Microsoft/Windows/Caches/**', // 用户级缓存
        '/C/Users/*/AppData/Roaming/Microsoft/Windows/Recent/**' // Recent/AutomaticDestinations
    ];
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
        // 宿主用户 Temp 写入放行（镜像层共享 Temp 别名，见 dynobox Runner）
        ...(tempRoot ? [`[[rules]]\npath = ${quote(tempRoot)}\naccess = "write"\nperm = "allow"`] : []),
        // 系统维护路径写放通（见 systemWritePaths 注释）
        ...systemWritePaths.map((path) => `[[rules]]\npath = ${quote(path)}\naccess = "write"\nperm = "allow"`),
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

/** 从 [ask] 到文件末尾的策略行（Linux / OpenHarmony 共用）。两者的区别仅在
 * 头部：Linux(FUSE) 用 [[roots]] 整根映射，OpenHarmony(LD_PRELOAD 身份命名
 * 空间) 无路径映射、规则直接用真实路径。 */
function policyLinuxTail(
    quote: (value: string) => string,
    endpoint: string,
    token: string,
    workspaceRoot: string,
    rules?: PermissionRule[],
    home?: string,
    extraWritableDirs?: string[]
): string[] {
    return [
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
        // 工具链缓存目录写入放行（linux-sandbox/openHarmony-sandbox 的 env
        // 重定向：CARGO_HOME/npm_config_cache/GOCACHE 等指向
        // ~/.cache/opendesk-sandbox/...）
        ...(home
            ? [`[[rules]]\npath = ${quote(`${home}/.cache/opendesk-sandbox/**`)}\naccess = "write"\nperm = "allow"`]
            : []),
        // macOS 系统 Python 字节码缓存（com.apple.python）——不放行则每次 import
        // django 等大框架都重新编译字节码，migrate/runserver 会慢到卡死
        ...(home
            ? [
                  `[[rules]]\npath = ${quote(`${home}/Library/Caches/com.apple.python/**`)}\naccess = "write"\nperm = "allow"`
              ]
            : []),
        // OpenDesk 自身数据目录（回收站 ~/.opendesk/trash/<taskId>/ 由 C 侧 rename
        // 写入，不经弹窗；沙箱进程无感知）——放行避免误弹窗
        ...(home ? [`[[rules]]\npath = ${quote(`${home}/.opendesk/**`)}\naccess = "write"\nperm = "allow"`] : []),
        // 任务工作区写入放行（早于兜底 write ask 命中）
        '[[rules]]',
        `path = ${quote(`${workspaceRoot}/**`)}`,
        'access = "write"',
        'perm = "allow"',
        '',
        // 额外可写目录（OpenHarmony 应用沙箱 temp/cache 等；须在兜底 write ask 之前）
        ...(extraWritableDirs ?? []),
        // /var/tmp（bash here doc 临时文件、sort 临时文件等）——不放行则
        // configure/自动工具在沙箱内全部卡死
        '[[rules]]',
        'path = "/var/tmp/**"',
        'access = "write"',
        'perm = "allow"',
        '',
        '[[rules]]',
        'path = "/private/var/tmp/**"',
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
    ];
}

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
        ...policyLinuxTail(quote, endpoint, token, workspaceRoot, rules, home)
    ].join('\n');
}

/** OpenHarmony 版策略文本：LD_PRELOAD 身份命名空间（路径无映射），不含
 * `[[roots]]`（OH 版 native 会拒绝 `[[roots]]`，见 policy.c）。其余规则与
 * Linux(FUSE) 版一致——规则 path 均为宿主真实路径。
 * `writableDirs`：应用沙箱 temp/cache 等目录总是可读可写（无需 ask）。 */
export function policyTextOpenHarmony(
    endpoint: string,
    token: string,
    workspace: string,
    rules?: PermissionRule[],
    home?: string,
    writableDirs?: string[]
): string {
    const quote = (value: string) => JSON.stringify(value);
    const workspaceRoot = workspace.replace(/\/+$/, '') || '/';
    const writable =
        writableDirs && writableDirs.length > 0
            ? writableDirs
                  .filter((dir) => dir && dir.startsWith('/'))
                  .flatMap((dir) => [`[[rules]]\npath = ${quote(`${dir}/**`)}\naccess = "write"\nperm = "allow"`])
            : [];
    return [
        'version = 1',
        'default = "deny"',
        '',
        // LD_PRELOAD 身份命名空间：沙箱内路径与宿主完全一致，无需 roots 映射。
        // 系统运行时读/执行由内建 system_read 清单放行（与 Windows/Linux 对齐）。
        // 应用沙箱 temp/cache 总是可读可写（早于兜底 write ask）。
        ...policyLinuxTail(quote, endpoint, token, workspaceRoot, rules, home, writable)
    ].join('\n');
}
