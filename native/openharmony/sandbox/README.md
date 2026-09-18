# dynobox-linux —— 基于 LD_PRELOAD 的轻量级文件访问控制沙箱

OpenDesk 中 Windows 版 [dynobox](../OpenDesk/native/windows/sandbox)（基于 Dokany 虚拟卷）
的 Linux 对应实现。把宿主任意目录镜像进一个**虚拟命名空间**，被拉起的子进程及其
全部后代对这个命名空间的每一次文件操作——读、写、执行、删除、改名、枚举——都先经过
策略判定：

- `allow` —— 直接放行
- `ask`   —— 同步询问上游决策端点（HTTP 或 Unix socket），按响应放行或拒绝，
             并可接受端点**连带下发的子树授权**（grants）
- `deny`  —— 直接拒绝
- 未命中任何规则 —— 按 `default`（默认 `deny`，fail-closed）
- ask 超时 / 端点不可达 / 响应不合法 —— 一律拒绝（fail-closed，且失败决策不进缓存）

```
子进程 open("/docs/a.txt") ──> LD_PRELOAD 拦截层 ──> 策略引擎（本进程内 + 树共享状态）
        allow（或 grants 命中）──┬──> 翻译为真实路径，转发真实文件系统
        ask ──> HTTP / Unix socket ──> 上游决策端点
        deny ──> EACCES
```

典型用途与 Windows 版一致：让 LLM agent / 构建脚本 / 第三方工具在受控的文件视图里
工作——读你允许它读的，写你批准它写的，其余一律碰不到。

---

## ⚠️ 安全边界（必读）

**LD_PRELOAD 沙箱是一个“策略层”，不是一个内核安全边界。** Windows 版 dynobox 的
判定位于 Dokan 驱动应答的必经之路，子进程无法绕过；LD_PRELOAD 工作在 libc 的
动态链接符号层，**无法对恶意代码做出同等承诺**。使用前必须清楚它能防什么、
不能防什么。

### 它能做到的（对“ cooperating（不主动规避）的程序”可靠）

- 通过 libc（glibc 动态链接 + PLT）发起的路径类操作全部受控：open/openat/fopen/
  stat/statx/access/readlink/opendir/scandir/rename/mkdir/chmod/utimes/… 共 90 余个
  入口，含 `*at` 变体、大文件变体、目录枚举、`popen`/`system`/`posix_spawn` 及全部
  `exec` 家族（glibc 内部会绕过 PLT 调 execve 的 `execl*` 等已单独挂钩）；
- 路径穿越防护：`..` 在虚拟命名空间内归一化后按根相对解释；符号链接在**解析后的
  真实路径**上做策略判定，沙箱内符号链接指向沙箱外受保护路径时按解析结果拒绝；
- 执行管控：拉起进程 / `dlopen` 共载库按 `execute` 类别判定；**拒绝执行 setuid/
  setgid 程序**（防止 exec 后 loader 丢弃 LD_PRELOAD 逃逸）；**解析脚本 shebang
  并对解释器做同一 execute 判定**（允许的脚本无法借 #! 引入被拒的解释器）；
  只读打开的文件描述符不能用于 `mmap(PROT_EXEC)`（覆盖脚本类”下载后直接执行”
  场景）；**硬链接源路径不适用系统目录允许清单**（系统文件无法被硬链接进
  可写区外带，需显式规则授权）；
- 防篡改：策略由 launcher 解析后序列化注入，exec 时自动重注入原值——沙箱内
  进程修改自身 `DYNOBOX_CFG`/`LD_PRELOAD` 环境变量后再 exec 无效；
- 一次打开涉及多个访问类别时**每个类别独立求值、全部通过才放行**（与 Windows 语义
  一致：只读规则不等于可写）；
- fail-closed：ask 超时/端点死亡/响应非法一律拒绝且不缓存；配置经 launcher 解析后
  以序列化形式注入子进程，沙箱内进程无法改写策略文件来扩权；
- 进程治理（尽力而为）：launcher 持有看护管道，任何沙箱内进程检测到 launcher 死亡
  即终止自身所在进程组；launcher 正常退出时向子进程组发 SIGKILL；setpgid +
  PR_SET_PDEATHSIG 双保险；策略里的 allow/ask 决策与端点下发授权存放在 launcher
  创建的共享内存中，整棵进程树共享（与 Windows 管理进程持有的状态对齐）；
- 网络管控（可选）：`[network]` 支持 `allow` / `deny` / `loopback` 三档，
  默认 `allow`（对齐 Windows 版 internetClient 能力）。

### 它不能做到的（明确的能力边界）

以下任一手段都可以**完全绕过本沙箱**，这不是 bug 而是机制边界：

1. **静态链接 / 自带 syscall 的程序**：Go、Rust(非 gnu target)、Alpine 程序等不经过
   glibc PLT，直接执行 `syscall` 指令；
2. **内联系统调用**：任何 C 程序都可以 `syscall(SYS_open, ...)` 绕过 libc 封装；
3. **setuid/setgid**：内核对特权程序不施加 LD_PRELOAD（本沙箱已把 exec setuid
   默认拒绝，见上，但这是我们的策略而非机制保证）；
4. **主动卸载**：程序可以 `dlclose` 不了自身，但可以 `unsetenv(LD_PRELOAD)` 后用
   原生 syscall exec，或修改自身 GOT；
5. **继承前的窗口**：动态链接器在运行我们的构造函数之前加载的库、以及 libc 内部
   少量不经 PLT 的路径打开（如 NSS 模块加载、locale 装载）不在管控内；
6. **基于 fd 的操作**：已打开的 fd 可任意读写在策略之外（与 Windows“已打开句柄不受
   后续策略影响”语义一致）；`fexecve` 要求 fd 可归属，无法归属时直接拒绝；
7. **内核对象**：ptrace、`/proc`（默认拒绝读，但依赖内核权限）、netlink、信号、
   共享内存等其他 IPC 均不管控；`mprotect` 匿名页转可执行不拦截（JIT 场景）；
8. **无映射的边界收益**：身份命名空间（虚拟路径==真实路径）天然消除了
   路径翻译歧义与 `[[roots]]` 相关的攻击面；代价是策略规则必须使用真实路径，
   且沙箱内程序"看到"的路径就是宿主路径（无虚拟视图隔离）；
9. **TOCTOU**：策略判定与真实系统调用之间存在时间窗，并发修改路径对象存在理论
   竞态（任何用户态文件沙箱共有的限制）。

**结论**：适用于让 *工具链、构建脚本、LLM agent 的 shell 工具* 这类“按常规方式使用
libc 的程序”遵守文件策略，并提供审计与人工审批点。**不适用于对抗性恶意代码的
 containment**。需要硬保证时，请叠加 Landlock / seccomp / bubblewrap / 容器等内核
机制（Landlock 与本沙箱的路径策略天然互补，后续可作可选加固层）。

---

## 一、快速开始

环境要求：Linux x86_64，glibc ≥ 2.33（Ubuntu 22.04+ / Debian 12+ 均满足），gcc + make。
开发与测试在 WSL2 Ubuntu 24.04 中验证。

构建与自检：

```bash
make tests              # 构建 build/dynobox、build/libdynobox.so 与测试探针
bash tests/run_all.sh   # 90 项功能/安全测试
```

最小示例（身份命名空间：规则直接作用于真实路径）：

```toml
# rules.toml
version = 1
default = "deny"

[[rules]]
path = "/home/you/work/public/**"
access = "all"
perm = "allow"

[[rules]]
path = "/home/you/work/**"
access = "read"
perm = "allow"
```

```bash
build/dynobox run --policy rules.toml -- /bin/sh -c 'echo hi > /home/you/work/public/a.txt && cat /home/you/work/public/a.txt'
build/dynobox run --policy rules.toml -- /bin/sh -c 'cat /etc/shadow'   # -> Permission denied
```

日常使用（等价于 Windows 版 --src 的兼容模式，仅切换工作目录）：

```bash
build/dynobox run --src ~/work --default deny -- /bin/sh
# 子进程工作目录即 ~/work，相对路径从该目录解析
```

带人工审批端点（参考实现内置演示规则，与 Windows 版一致）：

```bash
build/dynobox endpoint --port 8080 --default deny &
build/dynobox run --policy rules.toml --upstream http://127.0.0.1:8080/decide -- /bin/sh
# **/notes/**    读 -> 端点 allow 并下发 notes 读子树授权
# **/scratch/**  全部 -> allow 并下发 scratch 子树授权（后续同树零问询）
# **/staging/**  写 -> allow + 下发写授权；读放行走静态规则
# **/reject/**   -> 恒 deny；**/guarded/** -> allow 但不下发授权（每个新路径重新问询）
# **/slow/**     -> 端点挂起 8 秒（演示超时 fail-closed）
# 其余           -> --default
```

## 二、命令行参考（子命令与选项与 Windows 版 dynobox 对齐）

```text
dynobox run --policy <rules.toml> [选项] -- <命令> [参数...]
  与 Windows 版同名同义的选项：
         --policy FILE        策略文件
         --src DIR            兼容模式：仅切换子进程工作目录（同 Windows --src
                              的"以卷根启动"体验；无路径映射）
         --automount          接受但为 no-op（身份命名空间下恒等视图即默认行为）
         --upstream URL       ask 端点：http://host:port/path、unix://PATH、
                              或 pipe://名字（对应 Windows 命名管道，
                              endpoint --pipe 创建 /tmp/dynobox-pipes/<名>.sock）
         --map OLD=NEW        接受但为 no-op（身份命名空间下无路径翻译）
         --del-to-trash       接受但为 no-op（Linux 无回收站机制）
         --mount 盘符         接受但为 no-op（Linux 无盘符概念）
         --log FILE           诊断日志（--log-file 为别名；OpenDesk 集成传
                              --log-file；全部 DENY 均记录）
         -v                   放行也逐条记录（同 Windows 通用选项）
  Linux 扩展选项（Windows 版的对应值写在 TOML 内，两边都支持）：
         --default allow|deny       覆盖策略 default
         --net allow|deny|loopback  网络策略（默认 allow，对齐 Windows
                                    internetClient 能力）
         --timeout-ms N             ask 超时（默认 2000）
         --cache-ttl N              ask 决策缓存秒数（默认 60，0 禁用）
         --grant-ttl N              端点授权默认 TTL（默认 300，上限 3600）
         --no-system-read           关闭系统目录读/执行允许清单
         --cwd DIR                  子进程工作目录（--src 模式默认为 DIR，
                                    对齐 Windows"以卷根启动"）

dynobox endpoint [--port N] [--pipe 名字] [--unix PATH] [--default allow|deny] [--log FILE]
         内置参考决策端点；不给传输参数时默认 --port 8080（同 Windows）；
         --pipe 名字 创建 /tmp/dynobox-pipes/<名字>.sock，供 --upstream
         pipe://名字 使用（Windows 命名管道 \\.\pipe\名字 的等价物）
dynobox debug-rules --policy F [--path P] [--access read|write|execute|all]
         打印编译后的规则，并对指定路径输出求值过程（同 Windows）
dynobox network-status | network-ensure | network-setup --user-sid SID
         兼容 Windows 启动脚本的 no-op：Linux 回环访问默认可用，无需
         UAC/回环豁免；network-status 输出 configured=true 的 JSON
dynobox version
```

与 Windows 版的刻意差异（机制使然）：`mount` 子命令不适用——虚拟化逐进程生效、
无 Dokan 卷/盘符，调用会得到明确报错并指向 `run`；`--del-to-trash` 与 `--mount`
被接受但为 no-op，保证跨平台启动脚本无需改写即可运行。

---

## 三、策略文件格式

```toml
version = 1
default  = "deny"          # allow | deny（未命中任何规则时的兜底）

[ask]
endpoint          = "http://127.0.0.1:8080/decide"  # 或 "unix:///path/to/sock"
timeout_ms        = 2000     # 超时/不可达 => deny（fail-closed）
cache_ttl_seconds = 60       # ask 决策缓存（树内共享），0 = 不缓存
grant_ttl_seconds = 300      # 端点子树授权默认有效期（响应可覆盖，上限 1h）

[network]
default = "allow"            # allow | deny | loopback（仅 127.0.0.0/8 与 ::1）

[[rules]]                    # 按声明顺序匹配，第一条命中生效 —— 具体的放前面！
path   = "/etc/shadow"
access = "all"
perm   = "deny"

[[rules]]
path   = "/home/you/work/**"
access = "read"
perm   = "allow"
```

| 字段 | 取值 | 含义 |
|---|---|---|
| `path` | `/home/u/work/**` 之类 | 真实路径 glob（身份命名空间，无映射）：`**` 跨层级、`*` 单层级、`?` 单字符；`/dir/**` 同时匹配 `/dir` 本身；`/**` 匹配整棵文件树 |
| `access` | `read` | 读内容、列目录、读属性 |
| | `write` | 写内容、创建、删除、改名、改属性（删除/改名对相关路径都按 write 判定） |
| | `execute` | 拉起进程、加载共享库（dlopen）、mmap 可执行 |
| | `all` | 以上全部 |
| `perm` | `allow` / `ask` / `deny` | 放行 / 问上游 / 拒绝 |

一次操作涉及多个访问类别（如 `open(O_CREAT|O_RDWR)` = read+write）时，**每个类别
独立求值，全部通过才放行**；端点下发的授权（grants）只细化 ask 的结果，永远无法
越过静态 deny/allow/default。

### 路径语义与系统目录（Linux 版设计）

- **身份命名空间**：策略与沙箱内程序使用同一套真实路径，无任何映射。Windows 版的
  `[[roots]]`（虚拟前缀 → 宿主前缀）与 `--map` 前缀翻译在本版本中**不再支持**——
  策略文件出现 `[[roots]]` 会拒绝启动；
- 系统运行时路径默认允许读+执行：`/usr`、`/bin`、`/sbin`、`/lib*`、`/opt`、
  `/etc` 下的运行时文件（ld.so.cache、nsswitch.conf、hosts、resolv.conf、passwd、
  group、localtime 等）、`/dev/null|zero|urandom|tty|pts` 等（`/dev/null` 与 tty
  类设备允许读写）。这与 Windows 版"AppContainer 保留系统目录读取"的边界对应；
  `--no-system-read` 可整体关闭；
- `/proc` 默认**不**在任何允许清单中（防止 `/proc/self/fd/N` 重开绕过），需要的
  话请显式添加规则；
- 符号链接在**解析后的真实路径**上判定：经链接指向受保护路径会被拒绝；
- 硬链接的源路径不适用系统目录允许清单（系统文件无法被硬链接进可写区外带）；
- 涉及 deny 区的路径穿越（`..` 归一化后仍落在受保护路径）按策略拒绝。

### ask 协议（v2，与 Windows 版相同）

请求（HTTP POST body，或 unix socket 的 4 字节小端长度 + JSON 帧）：

```json
{ "path": "/staging/a.txt", "access": "write" }
```

响应：

```json
{ "decision": "allow",
  "grants": [ { "path": "/staging/**", "access": "write", "ttl": 120 } ] }
```

fail-closed：超时、连接失败、非 200、字段缺失 => 按 deny 且**不进缓存**；
allow 决策与 grants 存入树内共享内存，TTL 内全树零问询。

---

## 四、沙箱内子进程可见的环境

| 变量 | 含义 |
|---|---|
| `DYNOBOX_SANDBOX` | `1`（供脚本识别身处沙箱） |
| `SBX_ROOT` | 虚拟命名空间根（`/`） |
| `SBX_REAL_SRC` | 单根模式（--src）时的真实源目录；多根模式下为空 |
| `LD_PRELOAD` / `DYNOBOX_CFG` / `DYNOBOX_SHM_FD` / `DYNOBOX_WATCH_FD` | 沙箱内部机制，exec 时自动重新注入，不要手工修改 |

`getcwd()` 返回真实工作目录；readlink/realpath 返回真实路径——**身份命名空间下
不存在任何路径翻译**。

---

## 五、测试

```bash
make tests
bash tests/run_all.sh          # 直接跑（/mnt 下 drvfs 并发断言可能偶发误报）
tests/wsl_run.sh               # WSL 推荐：同步到 ext4 后构建+运行
```

三套共 **90 项**（另有 128 项单元断言）：

- **单元**（`tests/unit_policy`，128 断言）：TOML 子集解析（BOM/CRLF/重复键）、
  glob 语义（`/dir/**` 匹配目录本身、大小写敏感）、求值顺序、grants TTL 与类别
  子集、失败不缓存、路径归一化与符号链接解析、配置序列化回环、默认 allow +
  显式 deny、缓存覆盖；
- **功能**：read/write/delete/rename/mkdir/chmod/enum 的 allow-deny、
  EACCES 语义、O_EXCL、追加/截断、穿越拦截、符号链接逃逸（经解析路径拒绝）、
  执行管控（白/黑/ask、PATH 搜索逐候选判定、popen、setuid 拒绝）、
  dlopen/mmap-PROT_EXEC、网络三档、fd 表陈旧性（dup/churn）、
  ENOTDIR 语义、深嵌套/Unicode/空格/2MB 大文件；
- **可靠性与 ask 流**：HTTP、Unix socket、抽象 socket、pipe:// 三种传输、
  决策树内跨进程缓存、grants 推权与 TTL 过期重问询、guarded（每路径重新问询）、
  超时 fail-closed 且失败不缓存（计时断言）、**端点中途死亡 → 已缓存决策仍有效、
  新问询拒绝**、**杀 launcher → 整棵进程树（含孙进程）终止**、关闭看护 fd 的
  fail-closed 终止、双沙箱并行、坏策略（含 `[[roots]]`）拒绝启动、
  裸 syscall 绕过的边界存在性验证。

---

## 六、代码结构

```
src/
  dynobox.h    公共类型（perm/access/roots/rules/grants）
  mini_toml.*  极简 TOML 子集解析器（对应 Windows 版 MiniToml）
  policy.*     策略引擎：glob 编译与顺序匹配、类别分解、grants、
               ask 决策缓存、系统目录允许清单、共享内存状态
  pathmap.*    虚拟↔真实映射（最长前缀）、`..` 归一化、组件级符号链接
               解析（raw syscall，含 ENOENT 尾段与 NOFOLLOW 语义）
  ask.*        ask 传输：HTTP 与 Unix socket（4 字节帧）、协议 v2 JSON、
               全部 raw syscall（避免递归进自身 hook）
  cfgio.*      策略序列化（base64 环境变量注入，子进程无法改写策略）
  preload.c    LD_PRELOAD 拦截层：~90 个 libc 入口、fd 归属表、mmap-exec
               门、setuid 拒绝、argv/env 改写与重注入、看护线程
  endpoint.c   参考决策端点（HTTP + Unix socket、演示规则、/log 审计）
  main.c       CLI：run / endpoint / debug-rules / version，
               launcher 侧进程治理（进程组 + 看护管道 + 共享内存）
tests/
  unit_policy.c  单元测试（119 断言）
  t_*.c          沙箱内探针（IO/线程/进程链/网络/mmap/dlopen）
  run_all.sh     86 项功能/可靠性编排
  wsl_run.sh     WSL 下同步到 ext4 运行（规避 drvfs 锁缺陷）
  policies/      测试策略模板
```

## 七、许可

本仓库代码随意使用。仅依赖 libc 与 POSIX，无第三方运行时依赖。
