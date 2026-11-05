# dynobox —— 基于 Detours API 拦截的轻量级文件访问控制沙箱

## OpenDesk 集成

- 任务设置保存 `task_config.shell_path` 和 `task_config.shell_sandboxed`。终端初始化探测 shell 清单，路径不可用时选择第一个；仅 Windows pwsh 提供沙箱选项，每个任务只注册选中的执行工具及 `checkShellStatus`。
- 任务设置保存 `task_config.shell_sandbox_del_to_trash`；开启后 OpenDesk 在启动参数中追加 `--del-to-trash`。开启后沙箱内的删除经 SHFileOperation 送 Windows 回收站；**沙箱会话内创建的文件例外**——删除视为自发清理，不触发 ask、不进回收站、直接删除（见"已知限制"一节）；回收站不可用的位置（网络路径、无回收站介质）或移动失败时保留原文件并写诊断日志，绝不静默永久删除。
- 开发运行固定使用 `native/windows/sandbox/runtime/sandbox.exe`（与 `sandbox_hook.dll` 同目录）；安装包固定使用 `resources/sandbox/sandbox.exe`。
- OpenDesk 传入 `--log-file`，管理进程诊断信息写入 OpenDesk 日志目录的 `sandbox/dynamic-sandbox-<id>.log`。该文件是内部诊断日志，不进入终端结果；终端的 stdout、stderr、stdin 和退出码直接来自子进程。`--log-file` 路径同时经 `DYNOBOX_LOG_FILE` 注入 hook 子进程：整棵沙箱树的每次策略判定（`[POLICY] pid=N access vpath -> ALLOW|DENY (rule#N)`）都写回同一文件，事故后可归因"哪个进程、哪个路径、哪条规则、放行还是拒绝"。
- 授权端点随进程存活；终端工具超时转入后台不会关闭端点。用户确认最多等待五分钟（ask `timeout_ms=330000`）。
- 每次访问均查询 OpenDesk 当前权限规则，不下发原生 TTL 授权。同一命令的相同路径和操作复用单次确认结果；切换任务模式会清除此缓存。选择记住目录或操作类型时，写回任务权限引擎。
- 沙箱子进程以**普通用户令牌**运行（Detours 强制点在 API 层，无法与 AppContainer 的内核级路径控制共存——见"安全模型"）。不再需要 `network-ensure`/`pipes-ensure`（AppContainer 网络/命名管道限制消失，相关 CLI 子命令已移除）。
- 沙箱内进程树经 Job 对象治理：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（管理进程退出 → 整树终止），不授予 breakaway；后代进程经 `CreateProcessW` hook 递归注入 hook DLL，管控覆盖整棵进程树。
- 路径语义：**子进程直接使用宿主真实路径**（无虚拟卷）。策略按 `roots` 映射把真实路径换算成 `/C/...` 虚拟路径后判定（与 OpenDesk 的 `/C/X` 即宿主 `C:\X` 约定一致）；工作目录为宿主真实路径，经宿主 spawn 的 cwd 原样继承（不再注入 Set-Location）。
- **PowerShell 专用沙箱（Windows）**：**只有 PowerShell（powershell/pwsh）注册沙箱变体并进入动态沙箱**。Git Bash（MSYS2 bash.exe）等 cygwin shell 在 Windows 上不提供沙箱变体——cygwin 与 detours hook 原理上不兼容（注入后 fork 挂死且基本文件操作异常，见已知限制），需要管控的读写请用 PowerShell 或 node/python 等 Win32 工具。Unix 形态的路径（`/c/xxx`）在策略判定前由 hook 按 Win32 真实路径归一化。
- `--preserve-symlinks` 兼容措施不在沙箱侧：子进程 `%TEMP%` 即宿主 `%TEMP%`，无 junction 化的共享 Temp。

回归验证：`npx tsx --test native/windows/sandbox/tests/runtime.test.ts`（40 用例：stdout/stderr 转发、deny/allow、ask 决策与缓存、回收站、递归注入、NUL 设备、not-found 语义、并发管理进程、父进程退出后无孤儿泄漏、句柄级删除回收站、会话内创建直接删除等）、`npx tsx --test native/windows/sandbox/tests/cross-shell-runtime.test.ts`（9 用例：PowerShell/bash 双 shell 沙箱、cygwin bash 不注入（fork 正常）与 Win32 程序管控并存、node/cmd 递归注入 deny、Job 整树 kill、cmd ask、回收站、cygwin fork 修复验证）与 `npx tsx --test native/windows/sandbox/tests/sandbox-coverage.test.ts`（35 用例：策略语义 read/execute deny、grants 子树授权、ask TTL 过期、HTTP 非 200 fail-closed、命名管道 ask 端到端、同 key ask 合并、失败熔断、hook 日志 stdout 纯净、符号链接行为与宿主一致、多线程/多进程并发、2MB 哈希、Unicode/长路径、--src 单根、--env 透传、cwd 宿主路径、目录回收站/改名、尾斜杠归一化防逃逸、通配枚举 deny、回收站禁用保护、坏策略 fail-closed、ask 无端点 fail-closed、Job 心跳整树终止、git 工作流、大目录枚举、execute ask 授权、deny 优先级、junction 按名判定、hook 健壮性）。

---

## 一、快速开始

```bat
:: 决策端点（内置参考实现）
sandbox.exe endpoint --port 8080 --default deny

:: 全盘 automount 运行构建脚本
sandbox.exe run --automount --policy rules.toml ^
    --upstream http://127.0.0.1:8080/decide -- build.cmd
```

- `--automount` 由注入 DLL 在子进程内枚举宿主全部盘符（`/C ↔ C:\`、`/D ↔ D:\` …）。
- `--src DIR` 单根模式：把单个目录映射到沙箱根 `/`（与 `--automount` 互斥）。
- `--` 之后是真正要跑的命令；子进程直接使用宿主路径，无需卷路径换算。

### 1.1 端点与策略怎么配

`rules.toml` 写清"哪些路径允许什么"；决策端点回答 ask 问题。内置端点演示规则见 §3.2。

---

## 二、设计文档

### 2.1 核心思路：Detours API 拦截（进程内判定）

管理进程 `sandbox.exe`（C++，CLI/策略校验/Job/注入启动）启动子进程时注入
`sandbox_hook.dll`（Detours）。hook DLL 在子进程内对文件系统 API 做策略判定：

```
子进程 CreateFileW("C:\work\a.txt")
  → sandbox_hook.dll（进程内，~µs 级）
      → 路径归一化（.. / 8.3 短名 / 尾点 / \\?\ 前缀）
      → roots 映射 → 虚拟路径 /C/work/a.txt
      → Policy.Check(allow / ask / deny)
          ├─ allow  → 直通真实 API
          ├─ deny   → ERROR_ACCESS_DENIED
          ├─ ask    → Winsock HTTP POST 宿主 /decide（绝对超时 fail-closed）
          └─ 未映射路径 → ERROR_PATH_NOT_FOUND（not-found 语义）
```

被拦截的 API 面：`CreateFileW/A`、`GetFileAttributesW/A`、`FindFirstFileW/A`、
`CreateDirectoryW/A`、`DeleteFileW/A`、`RemoveDirectoryW/A`、`MoveFile(W/A/ExW/ExA)`、
`CopyFile(W/A/ExW)`、`SetFileAttributesW/A`、`SetFileInformationByHandle`
（句柄级删除/改名，覆盖 Node rmSync 与 .NET 路径）、`CreateSymbolicLinkW/A`
（符号链接创建：link 路径按 write、target 路径按 read 判定，防链接逃逸到沙箱外；
并校验产物真实存在——普通令牌下宿主行为是 `ERROR_PRIVILEGE_NOT_HELD`（1314）
失败，注入环境下 kernelbase 会"静默成功但无产物"，本实现按 1314 与宿主对齐）、
`CreateProcessW/A`（execute 判定 + 递归注入后代）；以及 **ntdll 层**：`NtCreateFile`、
`NtSetInformationFile`（句柄级删除/改名）、`NtDeleteFile`——覆盖**不经
kernel32 导出而直调 ntdll 的 Win32 原生 IO**（`\??\C:\foo` 路径转换后按同一
策略判定）。注意：cygwin 程序（Git Bash 等）不注入 hook（见已知限制），
ntdll 层 hook 对其不生效。

后代进程通过 hook `CreateProcessW` 以 `CREATE_SUSPENDED` 创建 → 注入同一
hook DLL（`CreateRemoteThread + LoadLibraryW` 完整路径）→ 加入继承的 Job →
resume。整棵进程树受控。

**判定位于 API 层必经路径**：Node / PowerShell / .NET / Python / cmd 等所有
Win32 程序的文件 IO 都经过 kernel32 导出。**direct syscall（NtCreateFile 等
直调 ntdll）会绕过拦截**——这是本方案的固有边界（强制点在用户态 API 层，
不在内核），详见"安全模型"。

### 2.2 决策引擎与求值顺序

与 Linux/OpenHarmony/macOS 一致：静态规则（`[[rules]]`，**most-specific 匹配**——
四平台统一，详见下方语义说明）、端点下发的**临时授权**（`grants`，带 TTL）、
决策缓存（`路径+访问类型` 键）。TOML 解析与路径 glob 匹配由共享 core
（`native/openharmony/sandbox/src` 的 mini_toml.c / policy.c）提供，经
`common/core_policy.cpp` 桥接（UTF-16↔UTF-8 + 大小写折叠）。

```
静态规则 most-specific 匹配（规则顺序无关）
  ├─ 命中多条取最具体模式（剥尾 /** 的前缀最长），同长 deny > ask > allow
  ├─ deny  → 拒绝（硬边界，授权无法覆盖）
  ├─ allow → 该类别通过（硬边界，无需问询）
  └─ ask   → 先查端点下发的子树授权（TTL 内命中 → 通过）
             └─ 未命中 → 同步调端点 → allow/deny（失败=deny，不进缓存）
无规则命中 → default（默认 deny）
```

#### 规则匹配语义（四平台统一：most-specific）

一条路径命中多条规则时，取**最具体**的模式（剥离尾部 `/**` 后的前缀最长）；
同长按 deny > ask > allow。**规则书写顺序无关**——"宽 allow 在前 + 精确 deny
在后"的防御写法总是生效（历史 first-match 语义下该写法是 fail-open 陷阱）。
同一策略在 Windows / Linux / OpenHarmony / macOS 上判定结果一致。

fail-closed：超时、连接失败、非 200、字段缺失 → 按 deny 且失败决策不进缓存。
策略判定发生在子进程内的 hook 中（无跨进程 IPC 往返，stat 单价 ~10µs）。

### 2.3 子树授权下发（协议 v2）

端点批准路径时可连带授权一个子树，后续同树操作零问询。授权默认
TTL 取 `grant_ttl_seconds`（300s），响应可覆盖，上限 1 小时，过期自动失效。

### 2.4 多根统一命名空间

`[[roots]]` 把多个宿主位置映射进同一命名空间：

| 沙箱内路径 | 宿主真实路径 |
|---|---|
| `/C/Windows/win.ini` | `C:\Windows\win.ini` |
| `/D/data/a.txt` | `D:\data\a.txt` |

子进程看到的都是宿主真实路径；判定时按 roots 最长前缀映射到虚拟路径。
未映射到任何 root 的路径按 not-found 语义返回（`ERROR_PATH_NOT_FOUND`），
让工具的 PATH/资源探测表现为正常未命中而非错误。

### 2.5 路径一致性

LLM 与脚本统一使用稳定形式：**`/C/X` 即宿主的 `C:\X`**（roots 映射决定）。
`--map 旧=新` 保留为兼容参数（Detours 实现子进程直接使用宿主路径，启动期
argv/env 翻译不再需要，传参会被记录为空操作）。

### 2.6 进程治理

- 子进程 `CreateProcessW(CREATE_SUSPENDED)` → 注入 hook DLL（等待 DllMain
  完成 Detours patch 后 resume，无加载竞态）→ 放入 Job；
- Job `KILL_ON_JOB_CLOSE` + 不授予 breakaway：管理进程退出 → 整树终止；
- **父进程监护**：Windows 上父进程退出不级联子进程（OpenDesk 退出/崩溃/被强杀
  时若不清理，sandbox 及其后代会成为孤儿继续运行）。sandbox 等待子进程的同时
  监护其直接父进程（`WaitForMultipleObjects` 同等子进程与父句柄），父先退出则
  终止子进程——Job 句柄随本进程关闭（`KILL_ON_JOB_CLOSE`）后整棵沙箱树被系统
  杀死，不留孤儿；
- 后代进程经 `CreateProcessW` hook 递归注入，管控覆盖整棵进程树；
- 注入失败（系统保护进程等）不终止后代（避免连坐父进程），记录诊断日志，
  后代不受管控为已知降级。

### 2.7 安全模型

文件访问强制点在用户态 API 层，**强制点不在内核**，能力与边界如下：

| 能力 | 当前实现（普通令牌 + API hook） |
|---|---|
| 文件访问强制点 | 用户态 API（kernel32 导出） |
| direct syscall（NtCreateFile 直调） | **可绕过**（已知限制） |
| 系统目录写 | 取决于策略（默认 OpenDesk 策略 write ask） |
| 网络 | 普通令牌（无限制，无需豁免） |
| 命名管道 | 天然可用 |
| 安装要求 | **无**（MSVC 静态链接 + Detours） |
| 判定开销 | 进程内判定 ~10µs（无内核往返） |

因此本实现**不需要任何管理员/UAC/驱动安装**，隔离力弱于内核级方案：沙箱内
进程以普通用户身份运行，策略是唯一的文件管控。对 LLM/构建脚本等"非对抗"场景
足够；对恶意代码对抗不足（恶意进程可用 direct syscall 绕过文件管控）。

---

## 三、使用说明

### 3.1 环境要求

- Windows 10/11 x64（arm64 构建支持，见 §六）；**无需驱动安装、无需管理员**；
- 决策端点：任何能实现 3.4 节协议的 HTTP/命名管道服务。

### 3.2 命令行参考

```text
run      --policy <rules.toml> [--src DIR] [--automount] [--del-to-trash] [--upstream URL] [--token TOKEN] [--mount X] [--log-file FILE] [--env NAME=VALUE] ... -- <子进程命令行>
         注入 hook DLL 运行子进程 → 等待退出 → 透传退出码。
mount    --policy <rules.toml> [--src DIR] [--automount]
         Detours 实现无需挂载：仅校验策略并输出映射信息（CLI 兼容保留）。
endpoint [--port 8080] [--pipe 管道名] [--default allow|deny]
         内置参考决策端点（HTTP / 命名管道二选一）。
debug-rules --policy <rules.toml> [--path P] [--access K]
         诊断工具：打印规则编译结果与指定路径的求值过程。
cleanup  Detours 实现无虚拟卷：兼容占位（输出无需清理）。
通用选项： -v 输出详细日志。
--src DIR：单根模式，把 DIR 映射到虚拟根 /；与 --automount 互斥。
--automount：hook 内枚举宿主全部盘符（/C ↔ C:\ …）。
--del-to-trash：删除送 Windows 回收站（SHFileOperation FOF_ALLOWUNDO）；
         沙箱会话内创建的文件直接删除、不进回收站；网络路径/无回收站介质
         拒绝删除并保留原文件；junction/符号链接只删链接本身、不穿透目标树。
--env NAME=VALUE：透传子进程环境变量（可重复，工具链缓存重定向等）。
--map 旧=新：兼容参数（Detours 实现为空操作，见 §2.5）。
--token TOKEN：覆盖策略 [ask].token（Bearer 认证）。
```

### 3.3 规则文件格式（TOML）

规则文件字段：`version`、`default`、`[ask]`（endpoint/token/timeout_ms/
cache_ttl_seconds/grant_ttl_seconds）、`[[roots]]`（virtual/real）、`[[rules]]`
（path glob / access read|write|execute|all / perm allow|ask|deny）。完整字段
语义见 §2.2-2.4 与 `tests/rules*.toml`。

### 3.4 ask 协议规范（v2）

请求 `{"path":"/staging/a.txt","access":"write"}` →
响应 `{"decision":"allow","grants":[{"path":"/staging/**","access":"write","ttl":120}]}`。
HTTP（Winsock 实现，绝对超时 fail-closed）或命名管道帧（4 字节小端长度 + JSON）。

### 3.5 沙箱内子进程可见的环境

| 变量 | 含义 |
|---|---|
| `DYNOBOX_SANDBOX` | `1`（供脚本识别身处沙箱） |
| `DYNOBOX_POLICY` | 策略文件路径（hook 加载用） |
| `DYNOBOX_AUTOMOUNT` / `DYNOBOX_SRC` | 盘符枚举 / 单根映射标记 |
| `DYNOBOX_DEL_TO_TRASH` | 删除送回收站标记 |

---

## 四、代码结构

```
src/
├── common/                  # 共享库（sandbox.exe 与 sandbox_hook.dll 各持一份）
│   ├── log.{h,cpp}          # 线程安全日志（UTF-8，stdout 保留给子进程）
│   ├── toml.{h,cpp}         # 极简 TOML 解析（策略文件）
│   ├── glob.{h,cpp}         # 策略 glob 匹配（** / * / ?，/dir/** 匹配 /dir 本身）
│   ├── paths.{h,cpp}        # 路径归一化（.. / 8.3 短名 / 尾点 / \\?\）+ roots 映射
│   ├── json.{h,cpp}         # 极简 JSON（ask 协议）
│   ├── ask.{h,cpp}          # ask 上游：Winsock HTTP（绝对超时）+ 命名管道
│   ├── policy.{h,cpp}       # 策略引擎：加载/顺序匹配/ask/grants/决策缓存
│   └── hook_scope.{h,cpp}   # TLS 线程级 hook 抑制（ask 传输内部不递归）
├── manager/                 # sandbox.exe
│   ├── main.cpp             # CLI 入口与子命令
│   ├── runner.{h,cpp}       # 策略校验 / Job / CreateProcess+注入 / 环境块
│   └── endpoint.{h,cpp}     # 内置参考决策端点（HTTP + 命名管道）
├── hook/                    # sandbox_hook.dll
│   ├── dllmain.cpp          # DllMain：加载策略 + DetourTransaction 安装 hook
│   ├── hooks_file.cpp       # 文件 API hook + 回收站
│   ├── hooks_nt.cpp         # ntdll 层 hook（NtCreateFile/NtSetInformationFile/NtDeleteFile）
│   ├── hooks_symlink.cpp    # CreateSymbolicLinkW/A（符号链接创建管控 + 假成功防护）
│   ├── hooks_proc.cpp       # CreateProcessW/A hook + 递归注入
│   ├── inject.{h,cpp}       # CreateRemoteThread + LoadLibraryW 注入
│   └── hook.h               # 判定入口与 hook 声明
├── detours-src/             # Detours v4.0.1 源码（vendor，构建时编译进产物）
├── Makefile                 # nmake 构建（ARCH=x64/x86/arm64）
└── build-native.cjs         # 定位 vcvars + 驱动 nmake
```

一次 ask 数据流：

```
子进程 CreateFileW("/C/...")（hook）
  → Policy.check → ask 规则命中
  → askUpstream：Winsock 直连 127.0.0.1 宿主端点（绝对超时）
  → {"decision":"allow","grants":[...]} → 安装 grants → 放行
```

关键设计：`Policy`（纯决策）与 hook（API 判定）分离；hook 内线程级抑制
（`HookScope`）防止 WinHTTP/Winsock 内部文件操作递归 ask；判定在进程内完成
（无跨进程 IPC 往返）。

---

## 五、测试

```bash
npm run build:sandbox          # MSVC 构建 runtime/sandbox.exe + sandbox_hook.dll
npx tsx --test native/windows/sandbox/tests/runtime.test.ts
# 真实运行集成（默认跳过）：
OPENDESK_SANDBOX_INTEGRATION=1 npx tsx --test native/windows/sandbox/tests/windows-sandbox-runtime.test.ts
```

runtime.test.ts 40 用例覆盖：stdout/stderr/stdin/退出码透传、管理进程退出不被
后代句柄阻塞、deny/allow 文件读写、ask 决策与 TTL 缓存、回收站（--del-to-trash）、
递归注入（孙进程管控）、未映射路径 not-found、NUL 设备语义、deny 别名（.. / 8.3
短名 / 尾点）归一化、并发管理进程、命名管道、35 秒授权等待等。

### 5a. 性能基线（2026-09-30 本机实测）

`tests/perf-probe.mjs`（2000 文件 stat 微基准）：

| 指标 | 本实现 | 宿主 |
|---|---|---|
| perStatColdUs（首次 stat 单价） | **10.5µs** | 15.6µs |
| perStatWarmUs | 7.4µs | 9.5µs |
| read200x50kMs | 131.8ms | 104.6ms |

本实现没有"每 IRP 一次内核↔用户态往返"（~140µs），stat 单价与宿主同量级。

---

## 六、构建与分发

```powershell
node scripts/build-windows-sandbox.cjs      # x64（默认）；OPENDESK_SANDBOX_RIDS=win-x64,win-x86
```

前置：Visual Studio（MSVC + Windows SDK，vswhere 定位）。构建用 `cl` + `nmake`
（`src/Makefile`，`/MT /O2 /std:c++17`）；Detours v4.0.1 源码 vendor 在
`src/detours-src/`（不依赖 NuGet/外部工具链）。

产物：`dist/<rid>/bin/sandbox.exe` + `sandbox_hook.dll`（x86 版为
`sandbox_hook32.dll`），复制到 `native/windows/sandbox/runtime/`（开发态）与
`resources/sandbox/`（安装包，forge `stageWindowsSandboxResource`）。

---

## 七、已知限制

**保证做到：**

- 经 kernel32 API 的每一次文件打开/删除/改名/枚举都按策略判定（API 层必经路径）；
- 后代进程全覆盖（CreateProcessW 递归注入 + Job，管理进程死亡整树终止）；
- 拉起 exe 受 execute 规则约束；句柄级删除/改名（SetFileInformationByHandle、
  NtSetInformationFile disposition、NtDeleteFile）受 write 规则约束；
- `--del-to-trash` 下所有删除路径（DeleteFileW/RemoveDirectoryW、以及句柄级
  NtDeleteFile/NtSetInformationFile/SetFileInformationByHandle——覆盖 Node
  rmSync/.NET/python os.remove）统一送回收站；
- 回收站整树复制/删除**不穿透 junction/符号链接**（reparse point）：递归
  复制遇到目录链接只建同名空目录、删除只摘链接本身，均绝不枚举进目标树
  （否则删除指向仓库 node_modules 的 junction 会连带清空主仓库文件，回归
  测试覆盖 junction root 与树内 child 双路径）；
- **沙箱会话内创建的文件**（创建时间 ≥ 会话开始时刻，`DYNOBOX_SESSION_START`）
  删除视为自发清理：不触发 ask、不进回收站、直接删除（跨进程可靠、零额外成本）；
  宿主预置文件删除仍走回收站；
- 全链路 fail-closed（ask 端点死、超时、坏策略 → 拒绝且不缓存）；
- 路径别名归一化（`..`、8.3 短名、尾点、`\\?\` 前缀）不能逃逸策略；
- 未映射路径按 not-found 语义返回（PATH 探测不报错）；
- **框架探测不打扰**：打开已存在目录（可写性检查）、"确保存在"的目录创建、属性/存在性查询（GetFileAttributes）等无副作用探测**不触发任何 ask**（连 read 也不触发），但 deny 规则仍拦截（防尾斜杠/别名逃逸）；沙箱会话内创建的文件删除同样不 ask、不进回收站；
- **通用读探测豁免（判定层）**：read 类访问且目标**当前是已存在目录**（目录句柄打开、目录枚举、路径链逐层校验——句柄读不到文件数据）、目标**当前不存在**（ENOENT 透传：真实 API 对宿主返回 not-found，与无沙箱行为完全一致，探测/容错逻辑依赖它）、或目标由**沙箱会话内进程创建**（进程读回自己的产物，如 PowerShell `__PSScriptPolicyTest_*.ps1`，与"会话内创建文件删除=自发清理"同哲学）→ 不触发 ask；deny 规则仍优先拦截（deny 区的存在性探测不泄露），存在文件的内容读取照常受策略管控；
- **写目标父链缺失透传（判定层，四平台统一）**：write 类访问且目标的**直接父目录当前不存在** → 该写注定失败（宿主返回 ERROR_PATH_NOT_FOUND / ENOENT），直接透传真实 API 结果，**不触发 ask**（deny 规则仍优先拦截）。典型噪音源：dbghelp/SymSrv 按模块内嵌的 CodeView 调试符号路径探测并写入符号缓存（如 node.exe 内嵌的 `c:\ws\out\Release\node.pdb`——官方构建机路径，在绝大多数机器上不存在），此前每次探测都会弹"编辑文件"授权框。父目录存在时的新建/写入不受影响，照常受策略管控（Windows：`sandboxCheckWriteParentMissing`，覆盖 CreateFileW/A 写模式、CreateDirectoryW/A、MoveFile/CopyFile 目标、NtCreateFile ntdll 层；Linux/OH：`write_parent_missing`，覆盖 open 系/mkdir/rename；macOS：`check_write_path` 统一接入）；
- **App 专属策略（策略层，security/policies）**：常用 CLI 工具的运行时读放行定义在 `src/main/aikernel/security/policies/`（git/python/node/uv，standard 模式注入权限引擎，读写文件工具与沙箱两端生效）——git 全局配置、Python 用户站点包与 pip 缓存、npm 缓存与全局前缀、uv 缓存与工具区；`~/.git-credentials`/`~/.netrc`/`~/.npmrc` 等凭据文件 read ask 保护（standard 确认一次即可记住），沙箱导出时按 most-specific 同长 deny > ask > allow 保序；
- 回收站不可用时保留原文件、绝不静默永久删除。

**已知限制（Detours 方案的固有边界）：**

- **direct syscall 可绕过文件管控**（`NtCreateFile` 等 ntdll 直调不经 kernel32）：
  恶意进程可自行绕过；cmd 的 `if exist`、Node 的 `fs.statSync` 等底层实现走
  ntdll 层，其**探测**不受策略约束（但 CreateFileW 层的打开/写入仍受控）；
  已通过 ntdll 层 hook（NtCreateFile/NtSetInformationFile/NtDeleteFile）覆盖
  **不经 kernel32 导出的 Win32 原生 IO**（cygwin 程序不注入，其 IO 不受管控，
  见下条）；
- **MSYS2/cygwin 程序不注入 hook（架构边界）**：cygwin fork 会复制被 detours
  patch 的内存导致子进程 wait 挂死。**实验确认 cygwin 与 detours 完全不兼容**：
  （a）任何 hook 集（哪怕只挂 5 个删除函数）都会破坏 fork（命令替换/管道/子
  shell 挂死）；（b）注入完整 hook 时连 `rm` 的基本文件操作都异常（stat 报
  No such file）。因此 **cygwin 目标（Git/MSYS2 目录的程序，如 bash/ls/rm/make）
  主进程不注入 hook**，fork 正常可用；代价是这些程序的**文件 IO 不受管控**（如
  `rm` 的删除**不进回收站**、`cat` 读取不受策略约束）——需要管控的读写请用
  Win32 等价物（node/python/cmd/PowerShell），Win32 程序仍完整管控（含递归注入）；
- **命名管道 ask（pipe://）**：曾误判为沙箱兼容限制（CreateFile 连接失败、
  .NET NamedPipeClientStream StackOverflow）——真实根因是 `pipeName()` 用
  `substr(8)` 丢掉名字首字符（"pipe://" 为 7 字符），连接错名必然
  ERROR_FILE_NOT_FOUND。修正为 `substr(7)` 后**宿主与沙箱内管道 ask 端到端
  均正常**，.NET NamedPipeClientStream 在沙箱内同样工作（见测试
  "named-pipe ask transport works end-to-end inside the sandbox"）；
- **安全上下文为普通用户令牌**：沙箱内进程能读宿主用户可读的一切（read 类
  策略默认放行），写由策略管控（OpenDesk 策略 write 一律 ask）——隔离力弱于
  AppContainer 的内核 ACL；
- 32 位子进程注入受限（x64 管理进程无法远程线程注入 x86 进程；hook DLL 按
  目标进程位数选择，`sandbox_hook32.dll` 构建后 32 位目标可用但跨架构注入
  未实现）；
- 策略判定基于**传入路径名**，不解析 junction/符号链接的**落点**（落点重解析
  校验不适用）；符号链接/junction 的**创建**受控——link 路径按
  write、target 路径按 read 判定（`fs.symlinkSync`、`mklink /J` 等均按名判定）；
- 已打开句柄不受后续策略变化影响（与 NTFS 语义一致）；
- 未拦截 `SetFileAttributesW` 之外的属性级 API（`SetFileTime` 等）与
  `LockFile`——打开时的 read/write 判定已覆盖主要语义。

---

## 八、目录结构

```
src/                        C++ 实现（common/manager/hook/detours-src，见"代码结构"）
tests/runtime.test.ts         原生回归测试（40 用例）
tests/windows-sandbox-runtime.test.ts  真实运行集成测试（OPENDESK_SANDBOX_INTEGRATION=1）
tests/perf-probe.mjs          stat/read 微基准
tests/rules*.toml             示例策略
runtime/                      开发态产物（sandbox.exe + sandbox_hook.dll）
```

## 九、许可

- 本仓库代码：Mulan PSL v2；
- Detours（Microsoft Research，`src/detours-src/`）：MIT 许可，见
  `LICENSE.md`（vendor 于 `_vendor/detours`）。
