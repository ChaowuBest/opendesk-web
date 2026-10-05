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

import path from 'node:path';

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

export function policyText(
    endpoint: string,
    token: string,
    rules?: PermissionRule[],
    home?: string,
    opendeskDataDir?: string
): string {
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
    // OpenDesk 框架自身数据目录（%APPDATA%\opendesk\logs、artifacts、tasks）写放行。
    // 沙箱内加载/运行业务源码（npm run test、脚本、任务紧凑化等）时 logger 与任务
    // 模块会持续写入这些目录，属框架自身的合法 IO，不应反复打扰用户；与 Linux/OHOS
    // 策略放行工作区同哲学。opendeskDataDir 为宿主 getOpendeskDirectory()；未显式
    // 传入时按默认布局（%APPDATA%\opendesk，即 home/AppData/Roaming/opendesk）推导。
    const opendeskRoot = opendeskDataDir
        ? opendeskDataDir.replace(/\\/g, '/')
        : home && home.length > 0
          ? `${home.replace(/\\/g, '/')}/AppData/Roaming/opendesk`
          : null;
    const opendeskWritePaths = opendeskRoot
        ? ['logs', 'artifacts', 'tasks']
              .map((sub) => hostPatternToVirtual(`${opendeskRoot}/${sub}/**`))
              .filter((p): p is string => p !== null)
        : [];
    // Windows 框架/PowerShell 启动时的静默写入路径（组件存储、缓存、Recent 跳转
    // 列表等）。这些路径在普通令牌下本就写不动（OS ACL 拒绝），放通只为免去每次
    // 触发 write ask 弹窗。顺序：用户 deny 规则仍在此之前（permissionRulesForSandbox
    // 按 deny > ask > allow 排序），系统放行不会覆盖用户显式拒绝。
    // 注意：$RECYCLE.BIN 不放通——回收站是误删数据的恢复区，agent 若可写就能清理
    // 整个回收站（数据风险）；而 --del-to-trash 写入回收站经 SHFileOperation 内部
    // 操作（hook 已用进程级 RecycleGuard 抑制，不做策略判定），本就无需放通。
    const systemWritePaths = [
        ...(home && home.length >= 2 ? [`/${home[0].toUpperCase()}/Windows/system32/catroot**`] : []),
        '/C/Windows/system32/catroot**', // Windows Update 组件存储（catroot/catroot2）
        // 系统 Temp（安装器/更新临时文件）：系统盘符随机器（泛化：从 home 盘符
        // 推导 %SystemRoot%，系统装在其他盘时 C: 版本可能不存在但不有害）
        ...(home && home.length >= 2 ? [`${home[0].toUpperCase()}:/Windows/Temp/**`] : []),
        '/C/Windows/Temp/**',
        '/C/ProgramData/Microsoft/Windows/Caches/**', // 系统级缓存
        '/C/Users/*/AppData/Local/Microsoft/Windows/Caches/**', // 用户级缓存
        '/C/Users/*/AppData/Roaming/Microsoft/Windows/Recent/**', // Recent/AutomaticDestinations
        // PowerShell 启动配置数据（框架静默写；家目录根/Roaming 根不放通——
        // 写探测由 hook 按"目录写探测"降级为 read，见 hooks_file.cpp）
        '/C/Users/*/AppData/Local/Microsoft/Windows/PowerShell/**',
        // Python 解释器字节码缓存：import 时原子写 __pycache__/*.pyc.<随机数> 临时
        // 文件再 rename（解释器在宿主 Python 安装目录下生成），内容仅为字节码缓存，
        // 放行写入免去每次 spawn python 子进程都触发 ask
        '/C/**/__pycache__/**',
        // Windows App Installer（winget 等组件）诊断日志目录：组件启动时静默写入，
        // 与 catroot/Caches 同类，放通不产生安全面（仅日志落盘）
        '/C/Users/*/AppData/Local/Packages/*/LocalState/DiagOutputDir/**'
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
        // OpenDesk 框架自身数据目录（日志/任务产物/任务数据）写放行。
        // readonly 模式（全盘 write deny 用户规则在位）跳过——most-specific 下
        // 这些更具体的 allow 会架空 readonly 的写保护（与 Linux/OH 同理）。
        ...(!isReadonlyModeRules(rules)
            ? opendeskWritePaths.map((path) => `[[rules]]\npath = ${quote(path)}\naccess = "write"\nperm = "allow"`)
            : []),
        // 系统维护路径写放通（见 systemWritePaths 注释；readonly 下保留——系统
        // 组件的自更新写入本就在 OS ACL 层被拒，deny 它们不增加保护只会制造
        // 噪声错误；readonly 的写保护针对用户数据区）
        ...systemWritePaths.map((path) => `[[rules]]\npath = ${quote(path)}\naccess = "write"\nperm = "allow"`),
        ...(isReadonlyModeRules(rules)
            ? [
                  // readonly：系统运行时 read allow（PATH 搜索的 stat 是 read，
                  // 全盘 read deny 会让 PowerShell 连 cmdlet 都加载不出来），然后
                  // 工作区外读写全拒（不弹 ask——readonly 无交互可用）。
                  // temp 读也要放行（PowerShell 管道临时文件写后需读回；tempRoot
                  // 的盘符/用户前缀已由 %TEMP% 展开泛化）。temp 的 write allow 在
                  // 前面已声明（tempRoot），most-specific 下胜过此处的全盘 deny。
                  ...(tempRoot ? [`[[rules]]\npath = ${quote(tempRoot)}\naccess = "read"\nperm = "allow"`] : []),
                  ...['/C/Windows/**', '/C/Program Files/**', '/C/Program Files (x86)/**', '/C/ProgramData/**'].flatMap(
                      (p) => [`[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`]
                  ),
                  '[[rules]]',
                  'path = "/**"',
                  'access = "read"',
                  'perm = "deny"',
                  '',
                  '[[rules]]',
                  'path = "/**"',
                  'access = "write"',
                  'perm = "deny"',
                  ''
              ]
            : [
                  // 非 readonly：工作区外读走 ask（standard"工作空间外需确认"）。
                  // 系统运行时读放行（windowsRuntimeReadPatterns：系统目录、PATH 上
                  // 的一切目录（命令 PATH 搜索=逐目录 stat，实测每目录一次读 ask，
                  // 生成时展开当前 PATH——任何机器的工具布局都覆盖）、CryptoAPI
                  // 证书链缓存、.NET 运行时缓存）。读兜底按用户规则取值：
                  // solo/unlimited（全盘 read allow）用 allow（同长平局 ask>allow，
                  // ask 会架空全放行）；standard 用 ask。
                  ...windowsRuntimeReadPatterns(home).map(
                      (p) => `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
                  ),
                  ...POSIX_TEMP_DIR_PATTERNS.map(
                      (p) => `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
                  ),
                  '[[rules]]',
                  'path = "/**"',
                  'access = "read"',
                  `perm = ${quote(readFallbackPerm(rules))}`,
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
              ])
    ].join('\n');
}

/**
 * Windows 运行时读放行路径清单（standard 外读 ask 兜底下的豁免集）。
 * 全部从当前环境推导（盘符/用户/工具布局随机器变化，不硬编码）：
 * - 系统目录（Windows/Program Files/ProgramData，盘符从 home 推导）
 * - PATH 上的一切目录（命令 PATH 搜索 = 逐目录 stat，实测每目录一次读 ask）
 * - CryptoAPI 证书链缓存（LocalLow/Microsoft/CryptnetUrlCache——签名校验必需）
 * - .NET/PowerShell 运行时缓存（AppData/Local/Microsoft）
 * 只放 read：这些目录的写仍由 ask/权限引擎管控（防运行时目录持久化攻击）。
 */
function windowsRuntimeReadPatterns(home?: string): string[] {
    const patterns: string[] = [];
    const virtualHome =
        home && home.length >= 2 ? `${home[0].toUpperCase()}:${home.slice(2).replace(/\\/g, '/')}` : null;
    if (virtualHome) {
        const sysDrive = `${virtualHome[0]}:`;
        patterns.push(
            `${sysDrive}/Windows/**`,
            `${sysDrive}/Program Files/**`,
            `${sysDrive}/Program Files (x86)/**`,
            `${sysDrive}/ProgramData/**`,
            `${virtualHome}/AppData/Local/Microsoft/**`,
            `${virtualHome}/AppData/LocalLow/Microsoft/**`
        );
    }
    // PATH 展开：命令的 PATH 搜索逐目录 stat（观测证实每目录一次读 ask），
    // 目录本身与子树都放行（stat 命中目录本身，读文件命中子树）。
    for (const dir of (process.env.PATH || '').split(';')) {
        if (!dir) continue;
        const virtual = hostPatternToVirtual(path.win32.normalize(dir.trim()));
        if (!virtual) continue;
        patterns.push(virtual, `${virtual}/**`);
    }
    return patterns;
}

/** Linux 版策略文本：LD_PRELOAD 身份命名空间（路径无映射），规则 path 为宿主真实路径。 */
export function permissionRulesForSandboxLinux(rules: PermissionRule[] | undefined): string[] {
    return rulesToLines(rules, hostPatternToVirtualLinux);
}

/** 默认读放行兜底下的显式收窄：家目录内不允许读取的敏感路径 */
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

/** 从 [ask] 到文件末尾的策略行（Linux / OpenHarmony 共用：两者都是 LD_PRELOAD
 * 身份命名空间，路径无映射，规则 path 直接用宿主真实路径）。区别仅在
 * `extraWritableDirs`（OH 版有应用沙箱 temp/cache 总是可写）。 */
function policyLinuxTail(
    quote: (value: string) => string,
    endpoint: string,
    token: string,
    workspaceRoot: string,
    rules?: PermissionRule[],
    home?: string,
    extraWritableDirs?: string[],
    opendeskDataDir?: string,
    readonlyMode?: boolean
): string[] {
    // 读兜底：readonly=deny（不弹窗）；solo/unlimited=allow（用户已全放行，
    // 同长平局下 ask 会架空）；standard=ask（"工作空间外需确认"）。
    const readAllowFallback = readFallbackPerm(rules);
    // 写兜底同理：solo/unlimited 的全盘 write allow 不能被兜底 ask 架空
    //（unlimited e2e U2 实测：工作区外写被 ask 拒）。readonly 不走这里（全盘
    // write deny 由用户规则+工作区重申承载）。
    const writeAllowFallback = hasGlobalWriteAllow(rules) ? 'allow' : 'ask';
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
        // 家目录敏感路径读 deny（默认读放行，须显式收窄私密文件）
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
        // 统一回收站目录写保护（对齐 Windows 不放行回收站、OH 原生 trash-protected
        // DENY 的姿态）：回收站是误删数据的恢复区，沙箱进程可写即可清空整个回收站。
        // --del-to-trash 的写入由 C 侧 internal 豁免（LD_PRELOAD 层自身写回收站
        // 目录不受策略判定），不经策略判定，不受此 deny 影响
        ...(opendeskDataDir
            ? [
                  `[[rules]]\npath = ${quote(`${opendeskDataDir.replace(/\/+$/, '')}/trash/**`)}\naccess = "write"\nperm = "deny"`
              ]
            : []),
        // OpenDesk 自身数据目录（logs/artifacts/tasks 等框架运行期写入）写放行避免
        // 误弹窗；未显式传入时按默认布局 ~/.opendesk 推导。
        // readonlyMode：跳过（readonly 下框架数据目录同样不可写——模式承诺"禁止
        // 任何写入"，most-specific 下这条规则会架空同区域的全盘 deny）。
        ...(home && !readonlyMode
            ? [
                  `[[rules]]\npath = ${quote(`${(opendeskDataDir ?? `${home}/.opendesk`).replace(/\/+$/, '')}/**`)}\naccess = "write"\nperm = "allow"`
              ]
            : []),
        // 任务工作区写入放行（早于兜底 write ask 命中）。
        // readonlyMode：用户规则含全盘 write deny（readonly 模式签名）时
        // 不追加——most-specific 下更具体的 workspace allow 会架空全盘 deny。
        ...(readonlyMode
            ? []
            : ['[[rules]]', `path = ${quote(`${workspaceRoot}/**`)}`, 'access = "write"', 'perm = "allow"', '']),
        // 额外可写目录（OpenHarmony 应用沙箱 temp/cache 等；须在兜底 write ask 之前）
        ...(extraWritableDirs ?? []),
        // 跨平台临时目录（shell 管道/heredoc/编译器落盘区；泛化清单见
        // POSIX_TEMP_DIR_PATTERNS）。readonly 模式下这些目录**读写 allow**：
        // 管道命令的临时文件必须可落盘（盘符/路径差异已由清单泛化，Windows 的
        // %TEMP% 由 policyText 的 tempRoot 覆盖）。
        ...POSIX_TEMP_DIR_PATTERNS.flatMap((p) => [
            `[[rules]]\npath = ${quote(p)}\naccess = "write"\nperm = "allow"`,
            `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
        ]),
        // readonly：工作区 write deny 重申（在 temp allow 之后）——工作区恰位于
        // 临时目录之下时（测试特例/用户把项目放进 /tmp），temp 的更宽 allow
        // 会顶掉全盘 deny；工作区前缀比 /tmp/** 更具体，写保护恢复。
        ...(readonlyMode
            ? ['[[rules]]', `path = ${quote(`${workspaceRoot}/**`)}`, 'access = "write"', 'perm = "deny"']
            : []),
        '',
        ...(readonlyMode
            ? [
                  // readonly 模式：工作区外读写一律拒绝（不弹 ask——readonly 无交互
                  // 可用，弹窗只会卡死无人值守会话；"工作区外需确认"的确认途径是
                  // 建议用户切换模式）。temp/工作区 read allow（更具体）已放行所需路径。
                  //
                  // 系统运行时路径 read allow：PATH 搜索（sh 找 cat/ls）是 read stat，
                  // 全盘 read deny 会连 /usr/bin/cat 都找不到（readonly 仍需基础工具
                  // "检查工作区内容"）。清单与 core 的 system_read 内建前缀一致。
                  ...['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/etc', '/dev'].flatMap((p) => [
                      `[[rules]]\npath = ${quote(`${p}/**`)}\naccess = "read"\nperm = "allow"`,
                      `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
                  ]),
                  // shell 启动文件（zsh/bash 的 rc 文件在家目录）：shell 起不来一切
                  // 免谈。macOS 上 zsh 读 ~/.zshenv 等，bash 读 ~/.profile 等。
                  ...(home
                      ? ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.profile', '.bash_profile', '.bashrc'].flatMap(
                            (rc) => [`[[rules]]\npath = ${quote(`${home}/${rc}`)}\naccess = "read"\nperm = "allow"`]
                        )
                      : []),
                  '[[rules]]',
                  'path = "/**"',
                  'access = "read"',
                  'perm = "deny"',
                  '',
                  '[[rules]]',
                  'path = "/**"',
                  'access = "write"',
                  'perm = "deny"',
                  ''
              ]
            : [
                  // 非 readonly：工作区外读走 ask（standard 模式"工作空间外需确认"
                  // 的落实——ask 经 decide 端点查权限引擎，未命中走用户审批）。
                  // 必须先放行的读（most-specific 下更具体，先于 ask 兜底声明即可，
                  // 顺序无关但集中声明便于阅读）：
                  //   1. 系统运行时路径（PATH 搜索的 stat 是 read——全盘 read ask
                  //      会让每个命令的 PATH 搜索都弹窗，shell 完全不可用）；
                  //   2. shell 启动文件（zsh/bash 的 rc 文件在家目录）；
                  //   3. 临时目录（管道/heredoc/编译器落盘区）。
                  //   工作区内读由用户规则（workspace read allow）覆盖。
                  // 这些清单对 solo/unlimited 同样无害（allow 幂等）。
                  ...['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/etc', '/dev'].flatMap((p) => [
                      `[[rules]]\npath = ${quote(`${p}/**`)}\naccess = "read"\nperm = "allow"`,
                      `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
                  ]),
                  ...(home
                      ? ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.profile', '.bash_profile', '.bashrc'].flatMap(
                            (rc) => [`[[rules]]\npath = ${quote(`${home}/${rc}`)}\naccess = "read"\nperm = "allow"`]
                        )
                      : []),
                  ...POSIX_TEMP_DIR_PATTERNS.map(
                      (p) => `[[rules]]\npath = ${quote(p)}\naccess = "read"\nperm = "allow"`
                  ),
                  '[[rules]]',
                  'path = "/**"',
                  'access = "read"',
                  // solo/unlimited 已有全盘 read allow：兜底用 allow（同长平局
                  // ask>allow，用 ask 会架空用户的全放行语义）。standard 用 ask
                  //（"工作空间外需确认"）。
                  `perm = ${quote(readAllowFallback)}`,
                  '',
                  '[[rules]]',
                  'path = "/**"',
                  'access = "write"',
                  `perm = ${quote(writeAllowFallback)}`,
                  ''
              ]),
        '[[rules]]',
        'path = "/**"',
        'access = "execute"',
        'perm = "allow"',
        ''
    ];
}

/**
 * Linux 版策略文本：LD_PRELOAD 拦截（与 OpenHarmony 版同构）。
 *
 * 路径语义：沙箱内路径与宿主完全一致（无 FUSE 根/局部视图概念），规则 path
 * 直接是宿主真实路径。系统运行时读/执行由内建 system_read 清单放行；写工作区
 * 放行、其余询问。
 *
 * `opendeskDataDir`：OpenDesk 数据目录（<opendesk>/），用于回收站写保护 deny。
 */
export function policyTextLinux(
    endpoint: string,
    token: string,
    workspace: string,
    rules?: PermissionRule[],
    home?: string,
    opendeskDataDir?: string
): string {
    const quote = (value: string) => JSON.stringify(value);
    const workspaceRoot = workspace.replace(/\/+$/, '') || '/';
    return [
        'version = 1',
        'default = "deny"',
        '',
        // LD_PRELOAD 身份命名空间：沙箱内路径与宿主完全一致，无需 roots 映射。
        ...policyLinuxTail(
            quote,
            endpoint,
            token,
            workspaceRoot,
            rules,
            home,
            undefined,
            opendeskDataDir,
            isReadonlyModeRules(rules)
        )
    ].join('\n');
}

/**
 * 用户规则是否对**所有路径**显式 read allow（solo/unlimited 模式的签名形态）。
 * 此时读兜底用 allow 而非 ask——most-specific 同长平局取 deny > ask > allow，
 * 兜底 ask 会把用户的全盘 read allow 顶成 ask（solo/unlimited 的"全放行"
 * 语义被架空，外读开始弹窗）。
 */
function hasGlobalReadAllow(rules?: PermissionRule[]): boolean {
    return (rules ?? []).some(
        (r) =>
            (r.resourceType === 'file' || r.resourceType === '*') &&
            (r.action === 'read' || r.action === '*') &&
            (r.pathPattern === '**' || r.pathPattern === '/**') &&
            r.effect === 'allow'
    );
}

/** 用户规则是否对**所有路径**显式 write allow（solo/unlimited 签名）。 */
function hasGlobalWriteAllow(rules?: PermissionRule[]): boolean {
    return (rules ?? []).some(
        (r) =>
            (r.resourceType === 'file' || r.resourceType === '*') &&
            (r.action === 'write' || r.action === '*') &&
            (r.pathPattern === '**' || r.pathPattern === '/**') &&
            r.effect === 'allow'
    );
}

/**
 * 读兜底规则取值：readonly=deny（不弹窗）；solo/unlimited（用户已全放行）=
 * allow（most-specific 同长平局取 deny > ask > allow，兜底 ask 会架空用户的
 * 全放行语义）；standard=ask（"工作空间外需确认"）。
 */
function readFallbackPerm(rules?: PermissionRule[]): 'allow' | 'ask' | 'deny' {
    return isReadonlyModeRules(rules) ? 'deny' : hasGlobalReadAllow(rules) ? 'allow' : 'ask';
}

/**
 * 用户规则是否呈 readonly 模式的签名形态（全盘 write deny **且** read 只允许
 * 工作区——即不存在全盘 read allow）。此时：
 * - 策略尾部的"工作区 write allow"不得追加（most-specific 下会架空全盘 deny）；
 * - `/** read allow` 兜底改为 `/** read deny`（readonly 不弹窗外读：模式语义
 *   是"工作空间外读写全部拒绝"，ask 即弹窗，readonly 无交互可用）；
 * - 临时目录读写 allow 保留（shell 管道/heredoc 仍需要）。
 *
 * 注意不能只看 write deny：审计类自定义模式（全盘 write deny + 全盘 read
 * allow）的读路径依赖外读放行，套用 readonly 的 read deny 会破坏其语义。
 */
function isReadonlyModeRules(rules?: PermissionRule[]): boolean {
    const list = rules ?? [];
    const has = (action: string, effect: 'allow' | 'deny', allPath: boolean) =>
        list.some(
            (r) =>
                (r.resourceType === 'file' || r.resourceType === '*') &&
                (r.action === action || r.action === '*') &&
                (allPath ? r.pathPattern === '**' || r.pathPattern === '/**' : false) &&
                r.effect === effect
        );
    return has('write', 'deny', true) && !has('read', 'allow', true);
}

/**
 * 跨平台临时目录模式清单（泛化形态）。
 *
 * 这些路径是 shell 管道/heredoc/编译器/包管理器的落盘工作区（bash here-doc 的
 * /tmp 临时文件、sort 的 /var/tmp 暂存、/dev/shm 共享内存段、macOS 的 Darwin
 * per-user 临时区），不放行则管道与自动工具在沙箱内卡死。
 *
 * 盘符/路径差异的泛化：
 * - Windows 由 policyText 的 tempRoot（%TEMP% 展开，盘符随机器）覆盖，不在本清单；
 * - macOS 的 /tmp 与 /private/tmp 是同一路径的别名（符号链接），/private/var/
 *   folders/** 是 Darwin 的 per-user 临时区（os.tmpdir() 的宿主）；
 * - Linux 的 /tmp 与 /dev/shm 由发行版普遍提供，/var/tmp 供大文件暂存。
 */
const POSIX_TEMP_DIR_PATTERNS: string[] = [
    '/tmp/**',
    '/var/tmp/**',
    '/private/var/tmp/**',
    '/private/var/folders/**',
    '/dev/shm/**'
];

/** OpenHarmony 版策略文本：LD_PRELOAD 身份命名空间（路径无映射），不含
 * `[[roots]]`（LD_PRELOAD 版 native 无路径映射，见 policy.c）。其余规则与
 * Linux 版一致——规则 path 均为宿主真实路径。
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
        ...policyLinuxTail(
            quote,
            endpoint,
            token,
            workspaceRoot,
            rules,
            home,
            writable,
            undefined,
            isReadonlyModeRules(rules)
        )
    ].join('\n');
}
