# dynobox —— 基于 Dokany 的轻量级文件访问控制沙箱

## OpenDesk 集成

- 任务设置保存 `task_config.shell_path` 和 `task_config.shell_sandboxed`。终端初始化探测 shell 清单，路径不可用时选择第一个；仅 Windows pwsh 提供沙箱选项，每个任务只注册选中的执行工具及 `checkShellStatus`。
- 任务设置保存 `task_config.shell_sandbox_del_to_trash`；开启后 OpenDesk 在启动参数中追加 `--del-to-trash`，GUI/TUI 中该开关仅在选中沙箱化 PowerShell 时显示。该选项只改写 Cleanup 阶段的最终删除：目标经 SHFileOperation 送入 Windows 回收站而不是永久抹除，覆盖写、截断与 `mv`/`File.Replace` 等改写语义不受影响。回收站不可用的位置（网络路径、无回收站介质）或移动失败时保留原文件并写诊断日志，绝不静默永久删除；回收站操作由管理进程（普通用户令牌）执行，不受 AppContainer 限制。删除分流同时依据沙箱实例自身的创建跟踪：本次运行期间经镜像文件系统新建的文件/目录（改名跟随，含目录整体改名）在同一实例内删除时直接清除，不进回收站，避免任务期间的临时文件把回收站灌满；跟踪表随实例结束丢弃，跨实例（跨命令）的删除一律送回收站。CLI 模式不安装沙箱二进制与 Dokan 驱动，`scanSupportedShells` 在 CLI 平台不注册沙箱化 shell 变体，沙箱选项随之不生效。
- 开发运行固定使用 `native/windows/sandbox/runtime/sandbox.exe`；安装包固定使用 `resources/sandbox/sandbox.exe`。
- OpenDesk 传入 `--log-file`，管理进程诊断信息写入 OpenDesk 日志目录的 `sandbox/dynamic-sandbox-<id>.log`。该文件是内部诊断日志，不进入终端结果；终端的 stdout、stderr、stdin 和退出码直接来自子进程。
- `/` 等多根装配目录只有虚拟目录元数据，允许遍历、禁止修改，不发起用户授权。真实路径 `/D/work/a.txt` 在授权界面显示为 `D:/work/a.txt`。
- 授权端点随进程存活；终端工具超时转入后台不会关闭端点。用户确认最多等待五分钟，HTTP 预留 30 秒余量，Dokan 在等待期间续期当前 I/O 请求。
- 每次访问均查询 OpenDesk 当前权限规则，不下发原生 TTL 授权。同一命令的相同路径和操作复用单次确认结果；切换任务模式会清除此缓存。选择记住目录或操作类型时，写回任务权限引擎。
- Windows 的 `SystemDrive`、`SystemRoot`、`windir` 保留原值供系统运行时使用；子进程仍在 AppContainer 内运行，系统原生 ACL 继续生效。
- 沙箱子进程及后代带有 `internetClient`、`privateNetworkClientServer` 网络能力。Windows 对 AppContainer 的回环隔离独立于外网权限；使用 `127.0.0.1` / `localhost` 本机代理还需要回环豁免。
- OpenDesk 在启动沙箱前调用 `network-ensure`。首次使用会弹出 Windows UAC，只提升一次性的回环初始化子命令；初始化完成后，OpenDesk、沙箱管理器和 shell 均以普通权限运行。拒绝或初始化失败会返回本地化错误，重试可再次初始化。后续启动重新检查 Windows 配置，配置仍有效时不会弹出 UAC。
- 回环初始化为当前 Windows 用户预留 A–Z 共 26 个稳定的 AppContainer 包 SID，并保留其他应用已有的豁免。身份按“用户 SID + 挂载盘符”确定，同一用户跨登录会话持有独占盘符租约，并发实例不会共享身份；每次运行前重新创建私有 profile，避免残留任务数据。豁免允许这些身份访问本机服务，不限于某个代理端口；文件访问仍受 AppContainer 和 Dokan 策略约束。
- 启用动态沙箱的 shell 通过 `BaseTool.serialExecution` 在同一任务、同一批调用内串行调度；普通 PowerShell、Bash、Zsh 保持并行。不同任务和转入后台的沙箱进程仍可能重叠：原生管理器从选盘到卸载持有跨进程盘符占用，自动挂载时排除其他实例的虚拟卷。
- 强制沙箱工具不再静态分析虚拟路径的文件权限，实际 I/O 经授权端点转换成 `C:/...`、`D:/...` 后审批。模型和脚本统一使用稳定的根相对路径：`/C/...` 对应宿主 `C:/...`，`/D/...` 对应宿主 `D:/...`；工作目录会映射到相同位置，相对路径从任务工作空间解析。
- Windows PowerShell 自带模块在 `PSModulePath` 中保留系统原生路径，避免虚拟路径触发 AppContainer 无权执行的注册表授权检查。其他模块目录继续映射。无需可执行文件兼容补丁的程序保留安装目录的映射，以便读取相邻 DLL。
- 部分 Windows launcher 会把宿主绝对路径或命名对象格式嵌入 PE 文件。镜像文件系统按可执行文件内容识别这些兼容性特征，在私有 `/dynobox` overlay 中生成一次性副本，并把已声明的宿主路径映射到沙箱视图；不会按 `python`、`pip` 等工具名生成专用 shim。通过 PATH 启动的 launcher 与命令行直接启动的程序共享同一套处理。relay 只移除严格匹配当前虚拟盘符的运行时自定位诊断，其他 stderr 和退出码原样保留。
- `ConstrainedLanguage` 是 PowerShell 的语言限制，限制任意 .NET 调用、非核心类型属性赋值及 COM 等能力，并不等同于沙箱文件权限。挂载丢失会使 PowerShell 启动检查失败；本集成不强制切换语言模式，也不覆盖宿主的 AppLocker/WDAC 策略。

回归验证：`npm test -- --runInBand --runTestsByPath src/tests/ut/terminal/powershell-sandbox.test.ts src/tests/ut/terminal/background.test.ts src/tests/ut/aikernel/tool-serial-execution.test.ts`，以及 `npx tsx --test native/windows/sandbox/tests/runtime.test.ts`。原生集成用例需要 Windows、.NET SDK、已安装的 Dokany 驱动和 `npm run build:sandbox` 产物，覆盖子进程流、虚拟根和 35 秒授权等待。

网络初始化单元测试：`npm test -- --runInBand --runTestsByPath src/tests/ut/terminal/sandbox-loopback.test.ts`。真实运行测试已随沙箱实现放在 `native/windows/sandbox/tests/windows-sandbox-runtime.test.ts`，默认跳过，可在 PowerShell 中显式开启：

```powershell
npm run build:sandbox
native/windows/sandbox/runtime/sandbox.exe network-ensure
$env:OPENDESK_SANDBOX_INTEGRATION = '1'
$env:OPENDESK_SANDBOX_LOOPBACK_TEST = '1'
npx tsx --test native/windows/sandbox/tests/windows-sandbox-runtime.test.ts
```

这些用例验证发布产物重复启动、后代进程的网络能力和文件拒绝、并发身份隔离、私有数据清理，以及两次全新运行经宿主回环 HTTP 代理收发请求。并发用例直接启动原生管理器，验证跨任务或后台进程重叠时的身份防护；OpenDesk 仅串行调度带沙箱的 PowerShell 工具，普通 PowerShell、Bash 和 Zsh 可以并发执行。测试本身不请求提权；回环测试需先完成 `network-ensure`。

把宿主任意目录（乃至整个磁盘、网络共享）镜像成一个虚拟盘，**被拉起的子进程及其
全部后代**对这个卷的每一次文件操作——读、写、执行、删除、改名、枚举——都先经过
策略判定：

- `allow` —— 直接放行
- `ask`   —— 同步询问上游决策端点（HTTP 或命名管道），按响应放行或拒绝，
             并可接受端点**连带下发的子树授权**
- `deny`  —— 直接拒绝
- 未命中任何规则 —— 按 `default`（默认 `deny`，fail-closed）
- ask 超时 / 端点不可达 / 响应不合法 —— 一律拒绝（fail-closed）

```
                          allow（或 grants 授权命中）──┐
子进程(Z:\...) ──> dokan2.sys ──> 管理进程(策略引擎)  ├─> 转发到真实路径（镜像源）
                          deny  ──> 拒绝              │
                          ask   ──> HTTP/命名管道 ──> 上游决策端点
```

管控对后代进程自动传递：子进程使用当前运行独占的 Windows AppContainer
安全上下文，并继承 Job 容器，禁止 breakaway；管理进程退出或被杀，整棵进程树
随之终止。AppContainer 默认没有普通用户文件权限，Dokan 卷的安全描述符只授予
当前运行实例的包 SID，因此子进程不能把 `C:\`、用户目录或其他原生路径当作普通
文件系统访问。运行时依赖应放入沙箱卷或使用 Windows 系统目录中的程序。

典型用途：让 LLM agent / 构建脚本 / 第三方工具在受控的文件视图里工作——
读你允许它读的，写你批准它写的，其余一律碰不到。

---

## 一、快速开始

### 1. 发行包（推荐）

从 `dist\` 取对应架构的 zip（x86 / x64 / arm64），目标机**无需安装 .NET**：

1. 解压到任意目录；
2. 双击 **`install.cmd`**——自动检测 Dokan 驱动，缺失则静默安装内置的
   `DokanSetup.msi`（弹一次 UAC，这是唯一需要管理员的步骤），随后挂载沙箱卷
   并运行 24 项访问控制自检；
3. 自检退出码 0 即就绪。之后每次运行零特权。

日常使用（以把 `C:\work` 交给沙箱里的构建脚本为例）：

```bat
cd /d 解压目录
start /min dynobox.exe endpoint --port 8080 --default deny   :: 决策端点
dynobox.exe run --automount --policy rules.toml ^
    --upstream http://127.0.0.1:8080/decide -- build.cmd
```

`--automount` 把宿主全部盘符自动挂进动态分配的沙箱卷。agent 与脚本使用不含
动态盘符的稳定路径：`/C/...` ↔ `C:\...`、`/D/...` ↔ `D:\...`，其他盘符以此类推。

`--` 之后是真正要跑的命令：原生管理器默认以沙箱卷根启动。OpenDesk 会先进入
映射后的任务工作空间（例如宿主 `C:\foo` 对应 `/C/foo`），因此后代脚本的相对路径
也从该目录解析。兼容环境变量仍由原生管理器提供，但不作为 agent 的路径接口。

### 2. 端点与策略怎么配

`rules.toml` 写清"哪些路径允许什么"；决策端点回答 ask 问题。仓库自带的参考
端点（exe 内置 `endpoint` 子命令）内置一套演示规则：

| 沙箱内路径 | 端点行为 |
|---|---|
| `/notes/**` | 读 allow，并下发 `/notes/**` read 子树授权 |
| `/scratch/**` | allow，并下发 `/scratch/**` all 子树授权 |
| `/staging/**` 写 | allow + 下发 `/staging/**` 写子树授权 |
| `/reject/**` | 恒 deny（演示 ask 被拒） |
| `/guarded/**` | allow 但不下发授权（每次新路径重新问询） |
| `/slow/**` | 挂起 8 秒（演示超时 → fail-closed 拒绝） |
| 其余 | `--default` |

---

## 二、设计文档

### 2.1 核心思路：镜像卷 + 内核访问检查

不自写拦截驱动，而是复用 Dokan（用户态文件系统框架）：

1. 管理进程把真实目录挂载为一个 Dokan 卷（如 `Z:`）；
2. 沙箱子进程对 `Z:` 的每一个 IRP（创建/读/写/…）由驱动转发到管理进程回调；
3. 回调里先跑**策略引擎**（allow/ask/deny），再转发到真实路径；
4. **判定位于驱动应答的必经之路**——子进程只能通过文件系统 API 访问卷内文件，
   因此无法绕过；即便改用 direct syscall，到达的仍是同一条内核检查路径。

相比替代方案的优势：minifilter 自研驱动需要签名与内核开发；纯 token 缩权
（AppContainer/低完整性）无法表达"路径级 allow/ask/deny"策略；HTTP 代理重定向
需要改造每个程序。镜像卷方案零内核开发、无特权运行、对子进程完全透明。

### 2.2 决策引擎与求值顺序

策略由三部分组成：静态规则（`[[rules]]`，顺序匹配）、端点下发的**临时授权**
（`grants`，带 TTL）、决策缓存（`路径+访问类型` 键）。一次打开可能涉及多个
访问类别（读+写），每个类别独立求值，全部通过才放行：

```
静态规则按声明顺序匹配
  ├─ deny  → 拒绝（硬边界，授权无法覆盖）
  ├─ allow → 该类别通过（硬边界，无需问询）
  └─ ask   → 先查端点下发的子树授权（TTL 内命中 → 通过）
             └─ 未命中 → 同步调端点 → allow/deny（失败=deny，不进缓存）
无规则命中 → default（默认 deny）
```

设计要点：

- **fail-closed**：超时、连接失败、非 200、字段缺失 → 按 deny，且失败决策
  **不进缓存**（否则瞬时故障会污染整个 TTL 周期）；
- 临时授权只细化 ask 的结果，永远无法越过静态 deny/allow/default——
  端点批复是"常设的 ask 答案"，不是策略之上的特权；
- 已打开的句柄不受后续策略变化影响（与 NTFS 语义一致）。

### 2.3 子树授权下发（协议 v2）

端点批准某个路径时可以连带授权一个子树：

```json
{ "decision": "allow",
  "grants": [ { "path": "/staging/**", "access": "write", "ttl": 120 } ] }
```

效果：批准 `/staging/a.txt` 的同时放行整个 `/staging/**` 写操作，后续同树操作
零问询（可靠性 R7：5 个新文件仅 1 次 ask）。授权默认 TTL 取 `grant_ttl_seconds`
（300s），响应可覆盖，上限 1 小时，过期自动失效。

### 2.4 多根统一命名空间（多盘 + 网络位置）

策略里用 `[[roots]]` 把多个宿主位置映射进同一个卷：

| 沙箱内路径 | 宿主真实路径 |
|---|---|
| `/C/Windows/win.ini` | `C:\Windows\win.ini` |
| `/D/data/a.txt` | `D:\data\a.txt` |
| `/NET/filesrv/share/x` | `\\filesrv\share\x` |

动态沙箱卷根只列出已声明的映射（未声明的位置在沙箱内"不存在"）；子进程启动期
自动把命令行/环境变量里的已声明前缀翻译成沙箱路径（`C:\work\build.cmd` →
`<动态盘符>:\C\work\build.cmd`）。脚本应直接使用稳定形式 `/C/work/build.cmd`。
网络位置（UNC）需预先建立连接与认证（`net use` 或
资源管理器访问一次），沙箱只透传 IO。

### 2.5 路径一致性（agent / LLM 场景）

LLM 会在工具调用与生成的脚本里写路径，两套命名空间会让模型混乱。推荐
**整盘镜像 + 根相对映射**：在策略里用 `[[roots]]` 声明各盘（`/C` → `C:\`），
沙箱内 `/C/...` 与宿主 `C:\...` 的目录树完全一致（读全放行、写按策略），且不依赖
本次运行实际获得的盘符。给 agent 的系统提示词使用统一规则：
**`/C/X` 即宿主的 `C:\X`**。需要精细控制时用 `--map "旧前缀=新前缀"` 在启动期
翻译 argv/环境变量（仅覆盖这两处，程序内部硬编码路径不经过此处）。

### 2.6 进程治理与原生路径隔离

- 子进程以 `CreateProcessAsUserW` 启动，并通过
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 进入当前运行独占的 AppContainer；
- 挂载卷使用包含 `SYSTEM`、卷所有者和当前 AppContainer 包 SID 的安全描述符，
  其他卷访问者没有权限；
- 随后立即放入 Job 对象：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（管理进程退出
  → 整树终止），不授予 breakaway（子进程无法脱离 Job）；
- 后代进程继承 AppContainer 与 Job，管控自动覆盖整棵进程树；
- 非系统目录中的启动程序会先复制到卷内 `/dynobox/bin`，避免为启动程序开放
  宿主原生目录。
- 卷挂载使用 `MountManager | CurrentSession`：只在本登录会话可见，卸载即消失。

这套隔离会阻断普通用户目录、工作区和其他宿主数据路径（例如 `C:\Users\...`）。
Windows 对 AppContainer 保留的系统运行时目录（例如 `C:\Windows`）仍可能允许读取，
以便 `cmd.exe` 等系统程序启动；若要求连系统目录也逐进程完全拒绝，需要额外的
内核文件系统 minifilter 或系统级 ACL 改造，Dokan 用户态卷本身无法提供该保证。

---

## 三、使用说明

### 3.1 环境要求

- Windows 10/11（x86 / x64 / ARM64）；
- Dokan Library v2.x 驱动（按架构装一次，需管理员；发行包内置 MSI）；
- 决策端点：任何能实现 3.4 节协议的 HTTP/命名管道服务；发行包与仓库自带的
  参考实现开箱即用。

### 3.2 命令行参考

```text
run      --policy <rules.toml> [--src DIR] [--automount] [--del-to-trash] [--upstream URL|pipe://名]
         [--mount 盘符] [--map 旧前缀=新前缀 ...] -- <子进程命令行>
         挂载沙箱卷 → 以卷根为 cwd 拉起子进程 → 等待退出 → 自动卸载。
mount    同上（无 -- 子命令部分），只挂载不拉起，Ctrl+C 退出。
endpoint [--port 8080] [--pipe 管道名] [--default allow|deny]
         内置参考决策端点（HTTP / 命名管道二选一）。
debug-rules --policy <rules.toml> [--path P] [--access K]
         诊断工具：打印规则编译结果与指定路径的求值过程。
network-status
         只读检查当前用户的回环豁免，输出 JSON configured/userSid。
network-ensure
         检查并按需请求 UAC 初始化；成功输出 configured=true，失败输出 errorCode。
network-setup --user-sid SID
         内部管理员初始化入口，仅添加指定用户的沙箱回环豁免。
通用选项： -v 输出每个文件操作的调试日志。
--src DIR：兼容模式，把单个真实目录映射到虚拟根 /；也可在策略文件中使用
         [[roots]] 声明映射。两者不能同时使用。
--automount：把宿主全部盘符（含映射的网络驱动器）自动挂进卷根（C:\ → /C）；
         与 [[roots]] 手动映射可共存，手动声明优先；与映射到 / 的 [[roots]] 冲突。
--del-to-trash：Cleanup 阶段的最终删除改送 Windows 回收站；覆盖/截断/move 不受
         影响。网络路径与无回收站介质上不执行删除（保留原文件并记日志），
         移动失败同样保留原文件——启用后绝不静默永久删除。本实例运行期间
         经镜像文件系统新建的文件/目录（含改名跟随）按"实例内新建"处理，
         删除时直接清除而不送回收站，跟踪表随实例结束丢弃；/dynobox 引导区
         是每次运行重建的沙箱内部副本，不受此选项影响，保持直接清除；
         卷的回收站被禁用（NukeOnDelete=1 / MaxCapacity=0）时同样拒绝删除
         并保留原文件，避免 FOF_ALLOWUNDO 退化为永久删除。
```

示例：

```bat
:: 整盘镜像（agent 场景，路径一致性最好）：/C/X 即宿主 C:\X
dynobox.exe run --policy rules_drive.toml ^
    --upstream http://127.0.0.1:8080/decide -- python agent_task.py

:: 多盘 + 网络位置：/C、/D、/NET/... 统一视图
dynobox.exe run --policy rules_multi.toml --mount Y: ^
    --upstream pipe://dynobox-decide -- cmd /c build.cmd

:: 启动期路径翻译：把旧工具写死的 D:\data 前缀改写到沙箱内
dynobox.exe run --policy rules_multi.toml --mount Y: ^
    --map "D:\data=Y:\M2" -- legacy_tool.exe
```

### 3.3 规则文件格式（TOML）

```toml
version  = 1
default  = "deny"        # 未命中任何规则时的兜底: allow | deny

[ask]
endpoint          = "http://127.0.0.1:8080/decide"  # 或 "pipe://名字"
timeout_ms        = 2000     # ask 超时/不可达 => deny（fail-closed）
cache_ttl_seconds = 60       # ask 决策缓存（按 路径+访问类型 键），0 = 不缓存
grant_ttl_seconds = 300      # 端点下发子树授权的默认有效期（响应可覆盖，上限 1h）

# 多根模式（可选）：把多个宿主位置映射进同一个卷
[[roots]]
virtual = "/C"               # 沙箱内前缀
real    = "C:\\"             # 宿主盘符 / 目录 / UNC

# 规则按声明顺序匹配，第一条命中的生效 —— 更具体的规则放前面！
[[rules]]
path   = "/docs/secret.txt"  # 先声明具体的拒绝
access = "all"
perm   = "deny"

[[rules]]
path   = "/docs/**"          # 再声明宽泛的允许
access = "read"
perm   = "allow"
```

字段语义：

| 字段 | 取值 | 含义 |
|---|---|---|
| `path` | `/docs/**` 之类 | 虚拟路径 glob：`**` 跨层级、`*` 单层级、`?` 单字符；`/dir/**` 同时匹配 `/dir` 本身；`/**` 匹配整卷 |
| `access` | `read` | 读内容、列目录、读属性/EA |
| | `write` | 写内容、创建、删除、改名、改属性（删除/改名视为对相关路径的 write） |
| | `execute` | 以可执行方式打开 —— 拉起进程、加载 DLL |
| | `all` | 以上全部 |
| `perm` | `allow` / `ask` / `deny` | 放行 / 问上游 / 拒绝 |
| `virtual`（roots） | `/C`、`/NET/srv/sh` | 沙箱内前缀 |
| `real`（roots） | `C:\`、`D:\`、`\\srv\share` | 宿主真实根 |

完整示例：`tests\\rules.toml`（单目录）、`tests\\rules_drive.toml`（整盘）、
`tests\\rules_multi.toml`（多盘 + UNC）。

### 3.4 ask 协议规范（v2）

请求载荷（HTTP POST body 或管道帧，两者字段一致）：

```json
{ "path": "/staging/a.txt", "access": "write" }
```

响应：

```json
{ "decision": "allow",
  "grants": [ { "path": "/staging/**", "access": "write", "ttl": 120 } ] }
```

- `path`：沙箱内相对路径，`/` 开头，正斜杠；
- `grants` 可选；`ttl` 可选（秒，缺省 `grant_ttl_seconds`，上限 3600）；
- **fail-closed**：超时、连接失败、非 200、字段缺失 → 按 deny 且不进缓存；
- 命名管道帧：4 字节小端长度 + JSON，持久连接，`pipe://名字` 对应
  `\\.\pipe\名字`，稳态延迟比 HTTP 低约一个数量级。

### 3.5 沙箱内子进程可见的环境

| 变量 | 含义 |
|---|---|
| `SBX_ROOT` | 沙箱卷根（如 `Z:\`） |
| `SBX_REAL_SRC` | 镜像源真实路径（单源模式；多根模式下为空） |
| `DYNOBOX_SANDBOX` | `1`（供脚本识别身处沙箱） |

---

## 四、代码结构

```
  src\Dynobox\
  Program.cs        CLI 入口：run / mount / endpoint / debug-rules 子命令，
                    参数解析、日志初始化、fail-closed 顶层异常处理
  Policy.cs         策略引擎：MiniToml 规则加载、glob 编译（** / * / ?）与
                    顺序匹配、访问类别分解（read/write/execute）、ask 决策
                    （HTTP 与命名管道双传输、决策缓存、失败不缓存）、
                    子树授权（grants）的安装/匹配/过期、静态规则硬边界
  MirrorFs.cs       镜像文件系统（IDokanOperations 全部回调）：多根路径解析
                    （最长前缀匹配 + 逐根越界守卫 + 虚拟容器合成）、
                    策略强制点、转发真实 FS、句柄级锁 + 生命周期全局锁、
                    任何回调异常一律 ACCESS_DENIED（fail-closed）
  Runner.cs         运行器：DokanInstanceBuilder 挂载（MountManager +
                    CurrentSession）、就绪轮询、Job 容器（KILL_ON_JOB_CLOSE、
                    禁 breakaway）、AppContainer + CreateProcessAsUserW 启动（命令行原样传递）、
                    多根/显式路径映射的启动期翻译、卸载清理
  SandboxSecurity.cs AppContainer profile/SID 与 Dokan 卷安全描述符，盘符隐藏和清理
  DecisionEndpoint.cs  参考决策端点：HTTP（HttpListener）与命名管道两种监听、
                    内置演示规则、/log 决策审计
  MiniToml.cs       极简 TOML 子集解析器（本工具规则文件所需构造，零依赖）
  Log.cs            带时间戳/级别的线程安全控制台日志
```

数据流（一次读请求）：

```
子进程 ReadFile(Z:\docs\a.txt)
  → dokan2.sys（内核）→ 管理进程 ReadFile 回调
  → Policy.Check("/docs/a.txt", read)         [静态规则 → 授权 → 缓存/ask]
  → FileStream.Seek+Read（真实文件）→ 内核缓冲
  → 子进程收到数据
```

一次 ask 请求：

```
Policy.Check 命中 ask 规则 → 命名管道/HTTP → 决策端点
  → {"decision":"allow","grants":[...]} → 安装 grants（TTL）→ 放行
```

关键设计：`Policy`（纯决策，无 IO 副作用）与 `MirrorFs`（文件系统语义）严格
分离；`Runner.Sandbox` 编排挂载与进程生命周期；`NamedPipeAskTransport` 封装
管道帧协议（持久连接、事务串行化、超时弃连）。

---

## 五、测试

三套测试，全部针对发行 exe 验证：

```bat
:: 基础功能 24 项（挂载后在沙箱内运行）
dynobox.exe run --src tests\\src --policy tests\\rules.toml ^
    --upstream http://127.0.0.1:8080/decide -- cmd /c tests\run_tests.bat

:: 高级场景 21 项
dynobox.exe run --src tests\\src --policy tests\\rules.toml ^
    --upstream http://127.0.0.1:8082/decide -- cmd /c tests2\adv_tests.bat

:: 可靠性编排 7 项（沙箱外驱动发行 exe）
python tests\reliability.py
```

- **基础**：读/写/删/改/枚举 allow-deny、执行管控（白/黑/ask）、ask HTTP 决策、
  超时 fail-closed、决策缓存；
- **高级**：2MB 大文件分段往返+hash、随机偏移写、追加、截断、EOF、创建冲突、
  深嵌套、空格/Unicode/长文件名、大小写、`..` 穿越拦截、目录语义、只读删除、
  60 项枚举、孙进程治理链（bat→cmd→cmd）、3 进程并发、4 线程并发+共享追加；
- **可靠性**：R1 挂载/卸载循环 ×5；R2 双沙箱并行；R3 杀管理进程 → 整树陪葬；
  R4 端点中途死亡 → fail-closed 且缓存不丢；R5 非法策略拒绝启动；R6 压力 IO；
  R7 子树授权推权（5 文件 1 次 ask）。

（`tests\` 与 `tests2\` 中的 python 用例需要目标机有 python；缺失时自动跳过，
bat 用例照常执行。`tests\reliability.py` 是开发机上的编排工具，驱动发行 exe。）

## 五b、性能目标与架构边界

**目标（2026-09 定稿，双驱动实测校准）**：

| 场景 | 目标退化 | 实测 | 说明 |
|---|---|---|---|
| 缓存友好工具（npm/cargo/jest 等重复 I/O 负载） | ≤2x | 接近 | 用户态 stat 缓存（88% 命中）+ 集成层持久缓存吸收重复 I/O |
| 冷缓存 / 首次构建（模块解析 stat 风暴） | ≤8x | 7.5x | pass-through 用户态文件系统 IRP 往返地板 |
| 普通命令（ls/cp/git 等少量 I/O） | ≤2x | ✅ | 启动开销 ~ms 级 |

**架构地板**：Dokan 与 WinFsp 实测同量级（镜像卷首次按路径 stat 5.5-5.9K IOPS，
不随线程扩展）。瓶颈是"每 IRP 一次内核↔用户态往返"（~140µs），是用户态文件
系统（Dokan/WinFsp/FUSE 的 Windows 对等）的物理约束，非实现缺陷。

**已排除的优化路径**：
- **WinFsp 迁移**：实测首次按路径 stat 与 Dokan 同量级；FileInfoTimeout 内核缓存
  仅覆盖已打开句柄的查询（fstat 222K ops/s = 宿主水平），无法缓解 Node statSync
  的"open→query→close 每此新句柄"模式。投入产出为负，不迁移。
- **Dokan 驱动参数**：AllowIpcBatching 实测并发下死锁（900s 无响应），禁启用。

**已实施的用户态优化**（详见 commit `24c64ea3`）：GetFileInformation TTL 缓存、
CreateFile 探测缓存、ENOENT 负缓存、FindFiles 预填充（.exe 除外）、无锁 Ctx
登记表、集成层持久缓存目录（npm_config_cache 重定向宿主持久路径）。

### 共享宿主 Temp（AppContainer 私有 Temp → junction）

AppContainer 在 `CreateProcess` 时**强制**把子进程 `%TEMP%/%TMP` 改写为包私有目录
`%LOCALAPPDATA%\Packages\<profile>\AC\Temp`（env 注入无效，Runner 的路径翻译只能改写
进程继承的环境变量值，改不掉 Windows 自身的重定向），且每次运行重建 profile。
后果：jest transform 缓存（`os.tmpdir()/jest`）、node-compile-cache 等工具缓存既
无法跨沙箱实例复用，也无法与宿主复用——每次沙箱运行都重付全量编译成本。

`Runner.LinkSharedTemp` 在每次运行（profile 创建后、子进程启动前）把本实例的
`AC\Temp` 空目录替换为指向宿主用户 `%TEMP%` 的 **junction**（`mklink /J`，NTFS
重解析点，无需管理员）：所有沙箱实例与宿主进程共享同一临时目录，且子进程看到的
路径形态不变（`Z:\C\...\AC\Temp\...`）。junction 创建失败时 fail-open 保持私有
Temp（不影响隔离与功能）。`OPENDESK_SANDBOX_DISABLE_SHARED_TEMP=1` 可全局关闭。

**配套约束（OpenDesk 集成）**：共享 Temp 的 junction 会让 unrs-resolver
（jest-resolve 底层）在默认 realpath 时报 NOT_A_REPARSE_POINT (os error 4390)，
表现为 jest 环境内 `import(绝对路径)` 报 Cannot find module。OpenDesk 通过
`--env NODE_OPTIONS=--preserve-symlinks` 注入解决（用户已设置 NODE_OPTIONS 时
不覆盖）。

**为什么在镜像层做路径别名（`ApplySharedTempAlias`）的方案被放弃**：镜像层改写
真实路径会让 Dokan 内核 FCB 缓存（FileInfoTimeout）与用户态实际落点不一致——
csc/Add-Type 编译"主进程创建临时源文件 → 子进程 csc 二次打开"报 CS2001
（未能找到源文件）。junction 在真实路径层重定向，内核缓存与用户态看到同一个物理
位置，Add-Type/PowerShell 编译恢复正常（runtime 用例覆盖）。

**安全语义**：共享 Temp 意味着沙箱内进程（经卷）可读写宿主用户 `%TEMP%` 下的全部
内容，与宿主进程的临时文件可见性一致；策略层需放行该目录的写（OpenDesk
`policyText` 的 tempRoot 规则）。

**基准数据**（2026-09-27 本机，`npm run test` 全量 405 suites / 3753 tests，宿主 ~15s）：

| 配置 | 耗时 | vs 宿主 |
|---|---|---|
| 24c64ea3（历史最优） | ~112s | 7.5x |
| 1feee13b（删除退避恶化后） | ~258s | 17x |
| **当前（退避修复 + 共享 Temp + automount + preserve-symlinks + 热路径零分配）** | **~73-80s** | **~4.7-5.2x** |

**全量 IRP 分布**（Dokan DebugMode 采样，608 万 IRP）：GetFileInfo 27.5% +
Create 20.7% + Cleanup 18.6% + Close 18.6%（stat 链合计 ~85%）；
QueryVolumeInfo 9.5%（内核缓存旁路，不计耗时）；Read 4.0%；FindFiles 1.0%。
每 statSync = Create+GetFileInfo+Cleanup 3 IRP × ~150µs 内核↔用户态往返。

**已评估并排除的路线（本轮）**：
- **FileInfoTimeout 内核元数据缓存**：DokanNet 2.3.0.3 的 `DOKAN_OPTIONS`
  无该字段（反射确认只有 Version/SingleThread/Options/GlobalContext/MountPoint/
  UNCName/Timeout/AllocationUnitSize/SectorSize/VolumeSecurityDescriptor*）。
  实测 statSync 三轮 187µs→163µs（-13%，纯用户态缓存收益），内核层对新句柄
  stat 无缓存——与既有结论一致，数据再证实。
- **分发线程数**：`DOKAN_OPTIONS.SingleThread` 是唯一线程控制位（默认多线程，
  由驱动管理，不可调数量）。
- **热路径零分配改造**（AccessKinds 位掩码替代 HashSet + OrderBy，126 万次
  Create 的 GC 压力消除）：实测全量无显著变化（73→80s 波动带内），保留改造
  （正确的工程决策，为后续 stat 缓存命中率优化铺路）。
- **FindFiles 缓存**：目录枚举仅占 IRP 1%，已有 2s TTL 缓存，无优化空间。

**1feee13b 的性能回退根因**（2026-09-27 复盘定位）：`DeleteDirectory` 的判空退避
窗口被拉到 ~2.5s（`Thread.Sleep(50+attempt*30)` × 12 次）。该 sleep 在 Dokan 回调
线程内执行，jest 24 并发 worker 的删除风暴（rmSync recursive）下所有回调线程
同时陷入长睡眠，驱动请求泵被整体串行化——单测试套件仅 +22%（几乎无删除并发），
全量 +130%，CPU 反而更低，是"等待型"而非"计算型"退化的典型特征。
修复：两段式退避（前 8 次零等待热轮询 + 2ms 短退避，总窗口 ~2.5s 不变，语义
等价），回归全绿后全量降至 73s。

**热路径纪律的延伸教训**：`Thread.Sleep` 与插桩同属"回调线程不可阻塞"红线——
不仅禁止非线程安全状态，也禁止毫秒级以上的睡眠（数万 IRP/秒的负载下，一次
100ms 睡眠 ≈ 放弃数千次服务机会）。

余下 gap 的归因（对照实验）：单测试套件沙箱内 13.5s vs 宿主 0.85s（~16x），
镜像层微基准 stat 单价 187µs vs 宿主 22µs（8.4x），Dokan DebugMode 计数显示
一个测试套件即产生 3.8 万次 GetFileInfo（Node/jest 模块解析的 stat 风暴，
每次 statSync = Create+GetFileInfo+Cleanup 三个 IRP 往返 ≈150µs，用户态缓存命中
也不降该成本）。全量 405 套件读 2.7GB/21 万次 IO，即剩余瓶颈是"用户态文件系统
每 IRP 一次内核↔用户态往返"这一架构地板（statSync 新句柄模式无路径级内核缓存
可依赖），而非 Temp/缓存布局——实测 junction 指向宿主 Temp 根与其小子目录性能
一致。镜像层改写路径的别名方案实测更快（~150s），但依赖 FCB 缓存对部分 re-open
的非常规命中，伴随 csc 二次打开失败的正确性问题，不予采用。

---

## 六、构建与分发

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1              # 三架构全量 + 打包
powershell -ExecutionPolicy Bypass -File build.ps1 -Smoke       # 构建后自动跑完整测试
powershell -ExecutionPolicy Bypass -File build.ps1 -Rids win-x64,win-arm64
```

前置：.NET 8 SDK（用户目录安装即可，脚本自动定位）；首次构建会下载各架构
Dokan MSI（缓存于 `_setup\`）。

产物（`dist\`）：`dynobox-win-{x86|x64|arm64}.zip`——自包含单文件 exe
（目标机无需 .NET，构建时剥离 PATH/DOTNET_ROOT 验证）+ 同架构 Dokan MSI +
`install.cmd`（检测/静默装驱动 + 24 项自检）+ 示例策略与夹具。

---

## 七、已知限制

**保证做到：**

- 卷内每一次文件打开都按策略判定，检查位于 Dokan 驱动应答的必经路径，
  子进程无法绕过；direct syscall 到达的也是同一检查点；
- 后代进程全覆盖（token + Job 继承，禁 breakaway，管理进程死亡整树终止）；
- 拉起 exe / 加载卷上 DLL 受 execute 规则约束；
- 全链路 fail-closed（ask 端点死、超时、坏策略 → 拒绝）；
- 路径越界守卫：`..` 归一化 + 前缀校验双重拦截（测试固化）。
- 未映射的路径（卷根下的游离路径、未声明的虚拟目录）按 not-found 语义返回，
  不产生 AccessDenied——与宿主机上"路径不存在"的行为一致，避免工具的
  PATH/资源探测（如 python 启动时的 mime.types 探测）表现为错误。
- 目录删除（`rmdir`/`rmSync`/`Remove-Item`）以文件句柄方式（BACKUP_SEMANTICS
  + DELETE）打开目录，镜像放行该打开形态并交由 `DeleteDirectory`/`Cleanup`
  按策略与空目录检查执行；改名与删除在宿主端遇到瞬时共享冲突（索引服务/杀软
  以不含 FILE_SHARE_DELETE 的共享模式短暂握住刚写完的文件）时自动退避重试
  （约 1 秒窗口），持锁者不释放时按原语义尽快失败。

**明确不做 / 已知限制：**

- AppContainer 会保留 Windows 为系统运行时提供的基础读取权限；这不是把系统 DLL
  从内存中移除。普通用户文件、工作区和其他宿主数据路径会被拒绝；若需要连
  `C:\Windows` 等系统目录也不可读，必须部署内核 minifilter 或系统级 ACL 改造；
  第三方解释器及其运行时文件应预先放进沙箱卷；
- 盘符是 `Z:` 这类新盘符，无特权做不到与真实盘同盘符视图（device map 在
  登录会话级）；
- 解释器型执行（`python x.py`）在内核层是"读脚本"，execute 规则管不到脚本内容；
- `SetFileAttributesW` 的属性修改被 Dokan 驱动 FCB 缓存吸收、不转发用户态——
  沙箱内"解除只读"不可靠（测试已固化该怪癖，残留由编排器清扫）；
- 已打开句柄不受后续策略变化影响；ask 决策有 TTL 缓存；失败决策不缓存；
- LockFile 仅返回成功；安全描述符查询返回 NOT_IMPLEMENTED（Dokan 用默认 SD）——
  因此 robocopy（依赖安全描述符查询）对卷内路径会报错并失败，Get-Acl/icacls
  同样不可用；Copy-Item 等不依赖安全描述符的 .NET 语义不受影响。曾实现真实
  SD 转发，但 DokanNet 的编解码在多线程安全查询下会造成 IRP 挂起，故回退；
- 多句柄"同时"追加同一文件存在 Dokan FCB 尺寸缓存竞态，可能丢失后写句柄的
  数据（NTFS 依赖写入时机同样存在理论竞态）；先关后开的顺序追加完全可靠；
- 对**目录**执行 Rename-Item/Move-Item 改名在 Dokan 2.3.1 驱动下会被驱动静默
  吞掉（不转发到用户态 MoveFile），表现为改名成功但目录内容在新路径不可见；
  文件改名/移动正常。需要目录改名时使用 Copy-Item + Remove-Item 组合；
- 系统自带 tar.exe（bsdtar）在 AppContainer 子进程中以 0xC0000142
  （STATUS_DLL_INIT_FAILED）终止，属系统工具与 AppContainer 的兼容性限制；
  归档场景使用 Compress-Archive/Expand-Archive（已验证可用）；
- NTFS 备用数据流（ADS，如 `file.txt:Zone.Identifier`）与 WSH 脚本
  （cscript/wscript 执行 .vbs/.js）同样受驱动/AppContainer 限制：前者的
  冒号名在到达用户态前即被驱动拒绝，后者被 URLMON zone 检查判定为
  拒绝执行；两者均为已知限制而非策略缺陷；
- 硬链接（os.link/CreateHardLink）与符号链接（os.symlink）创建不受支持
  （驱动无对应转发/权限拒绝）；读取常规文件与目录、loopback 监听
  （python http.server 绑定 127.0.0.1）均正常可用；
- 跨映射根的改名/移动按拒绝处理（跨卷语义）；
- 整盘镜像（`[[roots]]` 声明 `/C` → `C:\`）下所有经由 `Z:` 的 IO 走用户态，系统目录批量访问变慢；
  且 `Z:` 上会看到整盘（读全放行的策略下）——敏感目录请用规则收窄。

---

## 八、目录结构

```
src\Dynobox\            C# 沙箱实现（见"代码结构"）
build.ps1                  交叉构建：发布 + 组装（MSI + install.cmd）+ 打 zip + 验证
tests\runtime.test.ts      原生 Dynobox 回归测试入口
tests\windows-sandbox-runtime.test.ts  真实运行测试（AppContainer 身份、网络能力、launcher 兼容；OPENDESK_SANDBOX_INTEGRATION=1 开启）
tests\NativeRegression\   MirrorFs 与并发挂载回归辅助项目
tests\\rules.toml        单目录示例策略（配套基础测试套件）
tests\\rules_drive.toml  整盘镜像示例策略（读全开、写默认拒）
tests\\rules_multi.toml  多盘 + UNC 示例策略（[[roots]]）
tests\\src\              镜像源（tests\ 基础套件、tests2\ 高级套件、工具夹具）
tests\\src2\             多根示例的第二根
tests\reliability.py       可靠性编排测试（驱动发行 exe）
_setup\                    Dokan 三架构 MSI
_vendor\dokan-dotnet\      DokanNet 绑定源码（接口依据）
dist\                      构建产物（三架构发行 zip）
```

## 九、许可

- 本仓库代码：随意使用；
- Dokan Library 为 **LGPL/MIT 双许可**：用户态动态链接 + 分发官方未修改安装器
  即可闭源商用（保留许可声明；若修改 Dokan 源码，改动部分需开源）。


