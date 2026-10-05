# dynobox —— 基于 LD_PRELOAD 的轻量级文件访问控制沙箱（OpenHarmony）

OpenDesk 中 Windows 版 [dynobox](../OpenDesk/native/windows/sandbox)（基于 Dokany 虚拟卷）
的 OpenHarmony/Linux 对应实现。把宿主任意目录镜像进一个**虚拟命名空间**，被拉起的子进程及其
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

以上承诺由 `tests/t_adversarial.{c,py,js}` **持续验证**：21 项基于受控 API 的规避
手段全部被拦下 —— `open`/`openat`/`fopen`/`access`/`statx`、符号链接逃逸、硬链接外带、
改名进可写区、`chmod` 提权、`..` 穿越、chdir 后相对路径上跳、`/proc/self/{root,cwd}`、
`exec`/`popen`/`system` 起子进程、fork 后不 exec、经 `dlopen` 载入的第三方库，
以及 `unsetenv(LD_PRELOAD)` / 改写 `DYNOBOX_CFG` 后重新 exec（策略会被重新注入），
再加上 Python 与 Node 侧的常规 API。

### 它不能做到的（明确的能力边界）

以下任一手段都可以**完全绕过本沙箱**，这不是 bug 而是机制边界：

1. **静态链接 / 自带 syscall 的程序**：Go、Rust(非 gnu target)、Alpine 程序等不经过
   glibc PLT，直接执行 `syscall` 指令；
2. **内联系统调用**：任何 C 程序都可以 `syscall(SYS_open, ...)` 绕过 libc 封装；
3. **setuid/setgid**：内核对特权程序不施加 LD_PRELOAD（本沙箱已把 exec setuid
   默认拒绝，见上，但这是我们的策略而非机制保证）；
4. **取得未经拦截的 libc 入口**：三条路径，门槛依次升高 ——
   (a) `dlopen("libc.so")` + `dlsym(h, "open")`：**纯标准 libc API**，不需要裸 syscall
       或任何恶意手法，某些运行时、FFI 绑定与插件加载器会自然地这么写。这是本机制
       **门槛最低**的绕过方式，应按"随时可能发生"来评估（实测确认）；
   (b) `unsetenv(LD_PRELOAD)` 后用原生 syscall `execve`：子进程脱离沙箱（实测确认）；
   (c) 修改自身 GOT 表指向原始符号。
   注意 `dlsym(RTLD_NEXT, "open")` **不属于**此类：它从调用者之后搜索，命中的仍是本
   拦截层，实测**无法**绕过；
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

**两个现实例子**（不是构造出来的对抗代码，而是常见程序的日常行为）：

- **Node / libuv**：`fs.statSync` 内部直接 `syscall(SYS_statx)`，因此 node 程序对
  任意路径的**属性查询**天然不受管控 —— 但读内容、写、删除、执行子进程仍受控；
- **Python / ctypes**：`ctypes.CDLL(None).syscall(SYS_openat, ...)` 同理。

两者都由测试固化（`adv(node): statSync still bypasses`、
`adv(python3): ctypes syscall still bypasses`），机制一旦变化会立刻报出。

**入口语义**：`dynobox run -- <命令>` 中的 `<命令>` 由调用者选定，launcher 本身在沙箱
之外，因此**该可执行文件不受策略约束**（受管控的是它之后的所有文件访问与子进程）。
与 Windows 版一致：交给 dynobox 启动什么，是使用者的决定。

**结论**：适用于让 *工具链、构建脚本、LLM agent 的 shell 工具* 这类“按常规方式使用
libc 的程序”遵守文件策略，并提供审计与人工审批点。**不适用于对抗性恶意代码的
 containment**。需要硬保证时，请叠加 Landlock / seccomp / bubblewrap / 容器等内核
机制（Landlock 与本沙箱的路径策略天然互补，后续可作可选加固层）。

按使用面定位：

| 场景 | 是否适用 |
|---|---|
| 约束自己/团队的构建脚本、CI 步骤 | 适用 |
| 约束 LLM agent 产生的 shell / python / node 命令 | 适用（常规 API 全部受控）|
| 约束第三方工具（假定其不主动规避） | 适用，但须知 `dlopen(libc)` 与裸 syscall 的口子 |
| 隔离不可信代码 | **不适用**，请用 Landlock / seccomp / VM |

---

## 一、快速开始

环境要求：

- Linux x86_64/arm64，glibc ≥ 2.33（Ubuntu 22.04+ / Debian 12+ 均满足），gcc + make。
  开发与测试在 WSL2 Ubuntu 24.04 中验证；
- HarmonyOS PC / OpenHarmony aarch64（musl libc + clang/gcc 兼容驱动）。
  见下文「OpenHarmony 平台备注」。

构建与自检：

```bash
make tests              # 构建 build/dynobox、build/libdynobox.so 与测试探针
bash tests/run_all.sh   # 功能/安全测试
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

### OpenHarmony 平台备注（musl / aarch64）

本实现同时支持 glibc 与 musl：`src/preload.c` 按 libc 能力条件编译。musl 把
`open64`/`stat64`/`mmap64` 等 LFS64 名字定义成基础函数的宏，且不导出
`faccessat2`/`scandirat`/`execveat`/`dlmopen`/`close_range` —— 这些入口在 musl 下
不单独拦截，由其基础函数覆盖；`SYS_poll` 在 aarch64 上不存在，改用 `ppoll`。

HarmonyOS（OpenHarmony PC）原生环境下的已知差异，均已在本仓库内处理：

| 差异 | 处理方式 |
|---|---|
| 系统运行时位于 `/system`，`/bin`、`/lib`、`/lib64`、`/etc` 都是它的符号链接 | 策略在**解析后的真实路径**上判定，因此系统目录允许清单显式包含 `/system`（`policy.c`） |
| 内核拒绝对文件做 `mmap(PROT_EXEC)`（EACCES，与文件类型和权限位无关） | `mmap` 门只在"拒绝"方向有意义；测试先做内核能力探测，不成立时跳过放行方向的断言 |
| HMDFS（`$HOME`）拒绝 `bind()` Unix socket（EPERM）、`/dev/shm` 被 SELinux 拒绝（EACCES）、`/tmp` 是只读挂载 | `pipe://` 的 socket 目录改为探测式选择（`DYNOBOX_PIPE_DIR` 可显式覆盖）；测试用 `SOCKDIR` 选择可用目录 |
| HMDFS 不保留 `mkdir` 请求的权限位（目录固定为继承值） | 测试先探测工作区文件系统能力，不成立时跳过该断言 |
| 默认测试工作区位于 `$HOME`（HMDFS） | 可用 `DYNOBOX_TEST_WORK=<dir>` 重定向到其它文件系统 |

这套环境下的实测结果见「五、测试」。

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
         --del-to-trash       删除文件/目录时移入回收站目录（--trash 指定，
                              默认 $HOME/Trash，不存在自动创建；回收站内
                              写操作一律拒绝，防止沙箱进程清空回收内容）
         --trash DIR          回收站目录（配合 --del-to-trash；无需策略规则）
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
         --ro-dirs D1,D2            将宿主目录以只读方式暴露（身份命名空间下
                                    实现为对这些目录 write/delete 的 deny 规则，
                                    对应 FUSE 版 dynobox-linux 的只读 bind 挂载，
                                    可重复逗号分隔多项）
         --tmp DIR                  把沙箱内 /tmp（与 /tmp/*）映射到宿主 DIR：
                                    映射区总是可读可写，无需策略规则
                                    （OpenHarmony 的 /tmp 为只读挂载）
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
无 Dokan 卷/盘符，调用会得到明确报错并指向 `run`；`--mount` 被接受但为 no-op。

---

## 三、策略文件格式

```toml
version = 1
default  = "deny"          # allow | deny（未命中任何规则时的兜底）

[ask]
endpoint          = "http://127.0.0.1:8080/decide"  # 或 "unix:///path/to/sock"
token             = "..."    # 可选：发送给端点的 Bearer 认证（HTTP 头
                             # Authorization: Bearer 与 body 均携带），
                             # 防止本地其他进程伪造 allow；OpenDesk 集成必带
timeout_ms        = 2000     # 超时/不可达 => deny（fail-closed）
cache_ttl_seconds = 60       # ask 决策缓存（树内共享），0 = 不缓存
grant_ttl_seconds = 300      # 端点子树授权默认有效期（响应可覆盖，上限 1h）

[network]
default = "allow"            # allow | deny | loopback（仅 127.0.0.0/8 与 ::1）

[[rules]]                    # most-specific 匹配（四平台统一）：命中多条取最具体
path   = "/etc/shadow"       # 模式（剥尾 /** 的前缀最长），同长 deny > ask > allow；
access = "all"               # 规则书写顺序无关，宽 allow 在前也不吞掉精确 deny
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

两个可重定向的工作区变量（默认值适用于常规 Linux）：

| 变量 | 作用 |
|---|---|
| `DYNOBOX_TEST_WORK` | 测试工作区（fixture/日志/临时策略），默认 `tests/work`。放在不保留权限位的文件系统上（如 HarmonyOS 的 HMDFS）时，mkdir 权限断言会自动跳过 |
| `SOCKDIR` | Unix socket 目录，默认从 `$TMPDIR`、`/data/storage/el2/base/temp`、`/dev/shm`、`$WORK` 中挑一个可用者（HMDFS 与 /dev/shm 在 HarmonyOS 上会拒绝 `bind()`） |

四组共 **144 项**（另有 129 项单元断言）：

- **单元**（`tests/unit_policy`，129 断言）：TOML 子集解析（BOM/CRLF/重复键）、
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
  fail-closed 终止、双沙箱并行、坏策略（含 `[[roots]]`）拒绝启动；
- **解释器**（`tests/interp_probe.{sh,py,js}`）：sh / python3 / node 各自的
  allow/deny 矩阵 —— 允许区读、写、执行放行，拒绝区读、写、删除、枚举、
  执行全部拦下（Python 侧还含 `subprocess` 拉起的子进程）；
- **对抗性边界**（`tests/t_adversarial.{c,py,js}`，三侧共 30 项手段）：每种
  手段尝试读取"禁读哨兵文件"，探针自带预期判定 ——
  `must-block` 手段（symbolic/hard link 逃逸、改名外带、`..` 穿越、
  `/proc/self/{root,cwd}`、`exec`/`popen`/`system` 起子进程、经 `dlopen` 载入的
  第三方库、fork 后不 exec、`unsetenv(LD_PRELOAD)` 与改写 `DYNOBOX_CFG` 后 exec、
  Python/Node 的常规 API）**必须被拦住**；
  `boundary` 手段（内联 `syscall`、裸 `execve`、显式 `dlopen(libc)+dlsym`、
  Python `ctypes`、Node `statSync`）**必须仍可绕过** —— 边界若被意外扩大
  （must-block 泄露）或被意外收窄（boundary 失效）都会在测试里报出来；
- **回归**：拦截层自身的健壮性 —— NULL/空路径调用不得让沙箱崩溃、
  `posix_spawn`（含 close-on-exec file actions，等价 node `execFileSync`）不得
  误杀进程树、exec 后子进程环境变量必须完整且 `LD_PRELOAD` 已重注入。

- **性能**：`tests/t_stat_storm.c`（file stat 风暴探针）与 `tests/PERF.md`
  （鸿蒙真机宿主/沙箱吞吐基线：纯属性访问 +30µs/次、HOT 场景约 6.4× 慢，
  并说明与 Windows 侧 +27.7% 的口径差异）。

---

### 入库的运行时产物（`runtime/`）

**HarmonyOS 的原生构建环境不易获得**，所以把开箱可用的运行时产物一并纳入版本管理：

```
runtime/aarch64-linux-ohos/
  dynobox            命令行入口（launcher）
  libdynobox.so      LD_PRELOAD 拦截层
  BUILD-INFO.txt     来源与构建信息
```

**开箱可用**：`dynobox` 会在**自身所在目录**查找 `libdynobox.so`（见 `main.c` 的
`find_preload_lib()`），因此整个目录拷贝到任何位置都能直接运行 —— 不需要 `build/`，
也不需要在目标机器上具备编译环境。

```bash
runtime/aarch64-linux-ohos/dynobox version
runtime/aarch64-linux-ohos/dynobox run --policy rules.toml -- /bin/sh
```

**改了源码之后必须重新生成**，否则产物与源码脱节：

```bash
make runtime                                    # -> runtime/aarch64-linux-ohos/
make runtime RUNTIME_TARGET=x86_64-linux-gnu    # 其它目标
```

`run_all.sh` 的 `== runtime artifacts ==` 一节会在**独立工作区**里验证入库产物开箱
可用（能启动、放行允许区、拦住拒绝区）—— 产物一旦与源码脱节就会报出来。

**产物已瘦身并重新签名** —— 约为带调试信息版本的 35%：

| 文件 | `build/`（带 `-g`） | `runtime/`（瘦身后） |
|---|---|---|
| `dynobox` | 191 KB | 63 KB |
| `libdynobox.so` | 269 KB | 79 KB |

`make runtime` 内部顺序是**先改后签**，不可颠倒：

```
strip  →  binary-sign-tool sign -selfSign 1 -inFile ... -outFile ... -signAlg SHA256withECDSA
```

原因：ohos 工具链在链接时**会自动自签名**（ELF 带 `.codesign` 段），而 `strip` /
`patchelf` / `objcopy` 等任何二进制改写都会让签名失效 —— 所以必须先把旧签名去掉、
再重新签名，**签名之后不要再改动文件**。`BUILD-INFO.txt` 记录了所用流程与工具链版本。

在缺少 `binary-sign-tool` 的环境（普通 Linux / WSL）上，`make runtime` 会自动退化为
"只瘦身、不签名"并打印提示，方便在其它平台产出产物。

**两点注意**

- **不要跨目标混放**：本目录产物是 `ELF64 / AArch64` 且依赖 musl 的 `libc.so`，与
  x86_64 / glibc 构建出来的产物**互不通用**，务必各自放在 `runtime/<target>/` 下；
- `BUILD-INFO.txt` 记录了生成时的 git 版本与编译器版本，可据此判断产物是否已过期。

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
runtime/
  <target>/                入库的运行时候产物：dynobox + libdynobox.so + BUILD-INFO.txt
                            （make runtime 生成；同目录布局让两者可独立部署）
tests/
  unit_policy.c            单元测试（129 断言）
  t_probe.c                通用探针（IO/权限位/线程/进程链/网络/mmap/dlopen/回归）
  t_threads.c t_exec_chain.c t_net.c t_mmap.c t_dlopen.c   专项探针
  t_adversarial.c          对抗性边界探针（必须拦 / README 已声明边界）
  t_adversarial.py         Python 侧对抗探针（含 ctypes 直发 syscall）
  t_adversarial.js         Node 侧对抗探针（含 libuv 裸 statx）
  interp_probe.{sh,py,js}  解释器侧 allow/deny 矩阵
  adv_helper.c             dlopen 用的第三方库（验证库内部访问同样受控）
  run_all.sh               144 项功能/可靠性/对抗/回归编排
  wsl_run.sh               WSL 下同步到 ext4 运行（规避 drvfs 锁缺陷）
  policies/                测试策略模板
```

## 附录：踩坑记录（HarmonyOS / musl / LD_PRELOAD）

移植与加固过程中实际踩到并修掉的问题。按类别记录现象、根因与处置，供后续维护参考。

### A.1 libc 平台差异（glibc → musl）

| 现象 | 根因 | 处置 |
|---|---|---|
| `use of undeclared identifier 'SYS_poll'` | aarch64 内核没有 `poll`/`select` 系统调用，musl 不定义 `SYS_poll` | `util.h` 的 `dbox_raw_poll()` 在无 `SYS_poll` 时改用 `ppoll` |
| `redefinition of 'open64'`、`struct stat64` 不完整 | musl 把 LFS64 名字定义成**宏别名**（`open64`→`open`、`stat64`→`stat`、`mmap64`→`mmap`…），不存在独立符号 | `preload.c` 探测宏，用 `REAL64`/`RESOLVE64`/`FALLBACK64` 条件编译；glibc 路径保持不变 |
| `struct statx` 不完整、`statx` 未声明 | musl 只从 `<linux/stat.h>` 提供 | 显式 include；探针用**弱声明**（SDK 的 stub `libc.so` 不含 `statx`，运行时 musl 才导出） |
| `faccessat2` / `scandirat` / `execveat` / `dlmopen` / `close_range` 链接失败 | musl 不导出这些符号 | 仅在 glibc（`DBOX_EXTRA_HOOKS`）下挂钩 |

**要点**：musl 的库内调用**不走 PLT**（`fopen` 内部直接 `__syscall`），所以不能指望
"拦住底层调用"就够，必须逐个挂钩公共 API 入口。实测 musl 下
`execl`/`execv`/`execvp`/`system`/`popen`/`posix_spawn` 都会命中对应钩子。

### A.2 HarmonyOS 系统布局与限制

| 现象 | 根因 | 处置 |
|---|---|---|
| 沙箱内连 `/bin/sh` 都起不来 | `/bin`、`/lib`、`/lib64`、`/etc` 都是 `/system/...` 的符号链接，而策略按**解析后真实路径**判定 | 系统运行时允许清单显式加入 `/system`（`policy.c`）|
| `bind()` unix socket 报 `EPERM` / `EACCES` | HMDFS（`$HOME`）拒绝创建 socket 文件；`/dev/shm` 被 SELinux 拒绝；`/tmp` 是只读挂载 | `pipe://` 的 socket 目录改为**实际 bind 探测**选择（`DYNOBOX_PIPE_DIR` 可覆盖）；测试用 `SOCKDIR` |
| `mkdir -m 0755` 实际得到 `2771` | HMDFS 不保留请求的权限位 | 测试先探测工作区文件系统能力，不满足时跳过该断言 |
| `mmap(PROT_EXEC)` 恒返回 `EACCES` | 内核拒绝对文件做可执行映射（与 ELF、权限位、文件系统均无关）| `mmap` 门只保留"拒绝"方向的意义；测试先做内核能力探测再断言 |
| node 启动即失败：`OpenSSL configuration error ... Permission denied` | 它读 `/etc/ssl/openssl.cnf`——该文件**并不存在**，但拦截层在尾段 ENOENT 时退回了词法路径，把"不存在"判成"无权限" | 见 A.3 的尾段解析修复 |

### A.3 拦截层自身的坑（最耗时的一类）

| 现象 | 根因 | 处置 |
|---|---|---|
| 沙箱内 python 启动即**挂死** | HarmonyOS 的 DFX **信号处理器**在同一线程上打断了正持有 `g_pol_mu` 的钩子，随即在信号上下文里再次进入钩子（`access("/proc/self/unexpected_die_catch")`）→ 非递归互斥锁**自死锁** | 三把锁改为**递归锁**（`init_mutexes()` 运行时初始化）|
| 改用递归锁后，任何 `fork` 都挂死 | 递归锁记录 owner TID，`fork` 后子进程 TID 变化 → 锁被误认为"被别的线程持有" | `atfork_child` 重新初始化锁 |
| `subprocess` / `execFileSync` 崩（SIGTRAP / SIGSEGV）| `free_envp` 按 `"DYNOBOX_"` **前缀**释放，误把 launcher 经 environ 传入的 `DYNOBOX_SANDBOX`（非堆内存）`free()` 掉 → **堆损坏** | `build_envp` 返回自有条目的起始下标，`free_envp` 只释放这一段 |
| 读取**不存在**的 `/etc/...` 报 `EACCES` 而非 `ENOENT` | `dbox_plan_path` 在尾段 ENOENT 时**丢弃已解析路径**、改用词法路径判定；经符号链接的系统路径因此被误判越权（反向也可能让针对链接名的规则漏掉真实目标）| 始终采用解析结果（"已解析前缀 + 缺失尾段"）|
| 策略前缀匹配偶发失效 | 解析到根之后拼接产生 `//data/...` | 根处拼接不再追加多余斜杠 |
| 任意程序传 NULL / 空路径会让**沙箱自己崩** | `gate_resolve` 对 NULL 输入返回"成功"但 `vpath` 为空，随后策略匹配器 `memcmp(NULL)` | `gate1x` 对 NULL/空路径直接透传（交给内核报错）；`gate_resolve` 返回失败 |
| 子进程被 `SIGKILL`（退出码 137）| `posix_spawn` 的 close-on-exec file actions（node 的 `close_fds`）关掉了看护 fd，`watch_thread` 把 `EBADF` 误判成"launcher 已死"→ 杀掉整棵树 | `start_watch()` 先校验 fd 可用性，无效则不启动看护 |
| `fork` 与 `exec` 之间创建线程引发异常 | POSIX 只允许该窗口内调用 async-signal-safe 函数，而 `atfork_child` 里调了 `start_watch()` | 移除；`exec` 后构造函数会重建看护 |

这些用例现已全部固化为回归测试（`t_probe` 的 `path` / `posix_spawn [closefds]` /
`spawn_env`，以及 `unit_policy` 的路径解析断言）。

### A.4 测试与调试

- **策略里的宽规则会放开 fixture**：给对抗测试加 `"$ROOT/tests/**" read` 时，恰好把
  位于 `tests/work/` 之下的**拒绝区一并放开**，21 项 must-block 全部假失败。现改为把
  探针脚本复制进允许区运行，并在 `run_all.sh` 内注释说明。
- **lldb 调不动 exec 场景**：`follow-fork-mode child` 跟踪到的子进程 `execve` 在
  HarmonyOS 上会因 ptrace/SELinux 返回 `EPERM`（进程 exit 127），无法用它调试沙箱内的
   spawn。替代手段：`faulthandler.register(SIGTRAP)` 抓 Python 侧栈、`--log -v` 看判定
  序列、把问题**缩小成独立 C 探针**（`tests/t_adversarial.c` 就是这么长出来的）。
- **`/proc/<pid>/task/*/syscall` 在该平台为空**，但 `wchan` 可用 —— `FUTEX` 与
  `EVENTPOLL` 曾直接指向"锁竞争"与"看护线程在 poll"这两个事实。
- **`pkill -f` 会匹配到自己的命令行**：脚本里清进程请用 `pkill -x <comm>` 或显式 PID。

---

## 七、许可

本仓库代码随意使用。仅依赖 libc 与 POSIX，无第三方运行时依赖。
