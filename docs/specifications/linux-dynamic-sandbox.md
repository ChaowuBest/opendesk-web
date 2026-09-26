# Linux 动态沙箱（dynobox-linux）设计规范

## 1. 背景与目标

Windows 平台已有基于 Dokan 的动态沙箱 `dynobox`（`native/windows/sandbox/`）：把真实目录镜像成虚拟盘符，子进程在 AppContainer 中，对虚拟盘的每次文件操作都经过策略引擎（allow/ask/deny），ask 同步询问 OpenDesk 权限引擎，fail-closed，管理进程死亡则整树终止。

本规范定义 Linux 平台的对等实现 `dynobox-linux`，目标：

- **透明路径**：沙箱内 `/home/liyi/work/foo.txt` 与宿主路径完全一致，但底层文件访问受策略钩子控制（FUSE）；
- **限制对子进程及全部后代生效**，无逃逸路径（见 §6 威胁模型）；
- **复用现有权限引擎与 ask 协议 v2**，OpenDesk 侧改动最小；
- 与 Windows 版并存：策略语义共享，挂载层各写各的（FUSE vs Dokan）。

## 2. 与 Windows dynobox 的机制对照

| Windows (Dynobox)                          | Linux (dynobox-linux)                         | 说明                                                                    |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| Dokan 虚拟盘符 `Z:`                        | FUSE 挂载点（就地挂载，路径不变）             | FUSE 为内核自带用户态文件系统框架，非特权可挂载，零驱动安装             |
| AppContainer（宿主路径不可见）             | user namespace + mount namespace + pivot_root | 构造根视图，未声明路径"不存在"，隔离比 AppContainer 更彻底              |
| Job 对象 `KILL_ON_JOB_CLOSE`、禁 breakaway | cgroup v2 `cgroup.kill` + PID namespace       | 管理进程死亡 → 整树终止                                                 |
| 盘符租约 MountLease（A–Z 互斥）            | 不需要                                        | 挂载点是目录路径，多实例天然隔离                                        |
| 回环豁免 network-ensure（UAC 一次）        | 不需要                                        | Linux 回环默认可用；网络可选 netns 控制                                 |
| `--del-to-trash` 回收站                    | gio trash / 自实现 trash 目录                 | 简单                                                                    |
| AppContainer 对系统目录的读取残留          | 系统目录 ro bind（/usr /lib /etc /bin…）      | 运行时依赖原生可用且不可改，解决 Windows 版"解释器须预放进沙箱卷"的痛点 |
| 规则路径 `/C/...` ↔ `C:\...`               | 规则 path 直接写宿主真实路径                  | 无需路径翻译，权限弹窗显示真实路径                                      |

## 3. 组件与一次执行时序

```
OpenDesk (Electron)
  └─ prepareLinuxSandbox()
       ├─ 起 HTTP /decide 决策端点（复用 Windows 版 decideResponse 逻辑，抽公共模块）
       ├─ 生成 policy TOML（path 直接写宿主真实路径）
       └─ spawn dynobox-linux run --policy p.toml --upstream http://127.0.0.1:P/decide
              │
              ▼
管理进程 dynobox-linux（宿主 namespace，可信边界）
  ├─ fork 装配进程：unshare(USER|MOUNT|PID|IPC) → 写 uid_map(0→宿主uid)
  ├─ 装配进程：构造 tmpfs 根 → pivot_root → ro bind 系统目录
  │            → 保留 backing → FUSE 就地挂载 → close_range 清理 fd
  ├─ 子 shell（bash -c ...）放入 cgroup v2（dynobox-<id>/）+ pid namespace
  ├─ 子进程每次 IO → 内核 VFS → FUSE → 管理进程策略引擎 → allow/ask/deny
  │            ask → HTTP → OpenDesk /decide → 权限引擎 → 弹窗/缓存
  └─ 退出 → cgroup.kill（管理进程死亡也触发）→ 卸载 FUSE → 清理
```

## 4. 透明路径：shadow 视图装配

关键设计：**backing（真实数据）留在管理进程 namespace，子进程视图里不存在**；所有内容以"盖在 tmpfs 上的挂载层"形式存在。

```
管理进程 namespace（子进程不可见）       子进程 mount namespace（pivot_root 后）
/run/dynobox/<id>/backing/  ← 真实数据   /              ← tmpfs 根
                                       ├── usr/lib/bin/etc/  ← ro bind（宿主系统目录）
                                       ├── home/liyi/        ← 只挂受控路径
                                       │   └── work/        ← FUSE 就地挂载（路径=宿主路径）
                                       └── home/liyi/.ssh   ← 未挂载 → ENOENT（masked）
```

装配步骤（全部在装配进程的 mount namespace 内，宿主零感知）：

1. `unshare(CLONE_NEWUSER|CLONE_NEWNS|CLONE_NEWPID|CLONE_NEWIPC)`，`/proc/self/uid_map` 写 `0 <uid> 1`（子进程视图内为 root，实际映射宿主普通用户，同时化解 setuid 二进制提权）；
2. 挂 tmpfs 到新根，`pivot_root`（丢弃宿主根，杜绝 chroot / `chdir("..")` 逃逸），随后 `umount -l` 旧根；
3. 系统目录 `mount --bind -o ro`：`/usr /lib /lib64 /bin /sbin /etc /opt`；
4. 受控路径：`open_tree()`/bind 保留真实源到 backing（管理进程持有），FUSE daemon 挂载**覆盖原路径**（`/home/liyi/work` 等，由 `--mount-spec` 声明）；
5. `/proc`（`hidepid=2`）、最小 `/dev`（/zero/urandom/tty，**不含 /dev/fuse**）；`/sys` 默认不挂；
6. `close_range(3, UINT_MAX)` 后 exec 子 shell。

## 5. 策略引擎与 ask 复用

| 项目                  | Windows 版                              | Linux 版                                 |
| --------------------- | --------------------------------------- | ---------------------------------------- |
| policy TOML           | `[[roots]]` + `/C/...` 虚拟路径         | 无 roots 映射，`path` 直接写宿主真实路径 |
| ask 请求 path         | `/C/foo` → `virtualPathToHostPath` 还原 | 恒等（真实路径即沙箱内路径）             |
| 权限弹窗显示          | `D:/work/a.txt` 去前缀                  | 真实路径，无需处理                       |
| 端点/缓存/grants/超时 | HTTP `/decide` + token + 决策缓存       | 完全复用                                 |
| 系统目录读            | AppContainer 残留权限，不可控           | ro bind 显式只读，更干净                 |

改动集中在 `src/main/applications/terminal/sandboxes/dynabox.ts`：

- 把 `decideRequest`、HTTP server、token 管理、`onPermissionWaitChange`、决策缓存抽成平台无关模块（如 `sandbox-decide.ts`）；
- `policyText` / `permissionRulesForSandbox` 去掉盘符翻译（Linux 分支恒等）；
- `sandboxRunArgs` 平台化。

## 6. 子进程限制：威胁模型与对策

设计原则：**限制靠"视图不可见 + 内核必经路径"两层，不依赖子进程合作**。FUSE 检查点位于内核 VFS 必经路径（同 Dokan 原理），direct syscall 也到达同一 VFS，无法绕过。

| #   | 逃逸途径                              | 对策                                                                                                                                                                |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 直接访问宿主路径绕过 FUSE             | pivot_root 后宿主根不在视图内；backing 路径只在管理进程 namespace，子进程无该路径                                                                                   |
| 2   | `umount` 掉 FUSE 挂载点               | ① 子进程在装配 userns 内为普通 uid，无 `CAP_SYS_ADMIN`；② 即便子进程 `unshare(CLONE_NEWUSER)` 后能 umount 自身 namespace，**露出的是 tmpfs 空目录**，拿不到 backing |
| 3   | chroot / `chdir("..")` / 保留 fd 逃逸 | pivot_root + 旧根 umount + 装配后 `close_range` 清理 fd                                                                                                             |
| 4   | setuid 二进制提权（sudo/passwd）      | 子进程在 user namespace 内，root 映射为宿主普通用户，setuid 最高提到 namespace 内 root = 宿主普通用户                                                               |
| 5   | 通过 `/proc/<pid>/fd` 读其他进程      | `/proc` 只挂 `hidepid=2`；`PR_SET_DUMPABLE=0`；默认 YAMA `ptrace_scope=1`                                                                                           |
| 6   | 硬链接 / symlink 指向宿主敏感文件     | 目标按子进程视图解析：未挂载路径 → ENOENT；系统目录 ro bind 只读可见（预期行为）                                                                                    |
| 7   | 写系统目录 / 安装恶意二进制           | 系统目录全部 ro；可写区域仅 FUSE 工作区（受写策略 ask 管控）                                                                                                        |
| 8   | kill 掉 FUSE daemon 造成越权          | daemon 与管理进程同 cgroup；daemon 死亡 → 管理进程检测 → 整树 `cgroup.kill`                                                                                         |
| 9   | 管理进程死亡后子进程残留              | cgroup v2 `cgroup.kill`（内核 5.14+）+ PID namespace 双保险                                                                                                         |
| 10  | 加载内核模块 / 操纵设备               | 无 `/dev/fuse`、最小 /dev；模块加载需真 root                                                                                                                        |
| 11  | 通过 FUSE 检查绕过（direct syscall）  | 检查点在 VFS 必经路径，无法绕过（与 Dokan 同理）                                                                                                                    |

已知边界（与 Windows 版一致的语义）：

- 已打开句柄不受后续策略变化影响；
- `python x.py` 等解释器执行是"读脚本"语义，execute 规则管不到脚本内容；
- FUSE 挂载点可被 `statfs` / `findmnt` / mountinfo 识别（路径字符串与目录树无法区分）。

## 7. AppArmor / user namespace 前置检查

Ubuntu 23.10+（24.04 默认）通过 AppArmor 限制非特权 user namespace（`kernel.apparmor_restrict_unprivileged_userns=1`）。受限时 `unshare(CLONE_NEWUSER)` 返回 `EPERM`，**整个沙箱无法启动**（装配第一步即失败）。Debian 12 无此限制，Debian 13 支持但默认关，Fedora/Arch 默认无此限制。

处理：

1. **打包 AppArmor profile 白名单**（推荐，对齐 Ubuntu 对 Chrome/bwrap 的官方做法）：

    ```
    # /etc/apparmor.d/opendesk-dynobox
    abi <abi/4.0>,
    include <tunables/global>
    <dynobox-linux 绝对路径> flags=(default_allow) {
        userns,
    }
    ```

    安装时写入 `/etc/apparmor.d/` + `apparmor_parser -r`，一次性管理员授权（类比 Windows 装 Dokan 驱动的 UAC；按用户偏好可用 zenity 密码框完成），可逆。

2. **运行时检测 + 降级（必做）**：装配前探测 `unshare -U true`，失败则报本地化错误"动态沙箱需要非特权 user namespace，当前被 AppArmor 限制"，设置页不暴露沙箱选项；绝不静默降级为无沙箱假沙箱。
3. sysctl 全局关闭（`kernel.apparmor_restrict_unprivileged_userns=0`）仅作为用户自助手段，不作为产品方案。

## 8. OpenDesk 集成改动清单

| 文件                                                                          | 改动                                                                                                                  |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/main/applications/terminal/sandboxes/dynabox.ts`                         | 抽公共 `sandbox-decide.ts`（decideRequest/server/token/cache）；`policyText` 平台分支                                 |
| `src/main/applications/terminal/sandboxes/linux-sandbox.ts`（新）             | `prepareLinuxSandbox`：复用 decide 模块 + 真实路径 policy + `dynobox-linux run` 参数                                  |
| `src/main/applications/terminal/shells/common.ts`                             | `executeShellCommand` 已支持 `useDynamicSandbox`，Linux 分支走新 prepare 函数                                         |
| `src/main/applications/terminal/shells/bash.ts` `zsh.ts`                      | 构造加 `sandboxed` 参数（对齐 pwsh.ts），prompt 贡献标记沙箱模式                                                      |
| `src/main/applications/terminal/scan.ts`                                      | Linux 平台为 bash/zsh 注册 sandboxed 变体（`sandboxVariantsAvailable` 改为检测 `dynobox-linux` 二进制 + 非 CLI 平台） |
| `src/main/applications/terminal/app.ts`                                       | bash/zsh 分支传 `shell.sandboxed`                                                                                     |
| `src/main/applications/terminal/sandboxes/loopback.ts`                        | Linux 分支跳过（无回环豁免需求）                                                                                      |
| `src/main/applications/terminal/sandboxes/ask-path.ts` / `path-diagnostic.ts` | Linux 透明路径下恒等，无需 Z: 前缀改写                                                                                |
| `src/common/shells.ts`、`src/main/utils/setting.ts`                           | 注释/文案从"仅 Windows PowerShell"放开到 Linux bash/zsh                                                               |
| terminal locale（zh-cn / en-us）                                              | `sandbox.*` 文案平台化（`cwdUnsupported` 等）                                                                         |

## 9. native 侧结构与构建

技术选型：**Rust（fuser crate）**，静态二进制，无运行时依赖（对齐 Windows 自包含 exe）；备选 Go（go-fuse）。

```
native/linux/sandbox/
  src/main.rs          CLI：run / debug-rules（对齐 Windows 子命令）
  src/sandbox.rs       装配编排：unshare/pivot_root/ro bind/FUSE 挂载/进程治理
  src/mirror_fs.rs     fuser 实现：透传 + 策略钩子（对齐 MirrorFs.cs）
  src/policy.rs        TOML 加载 + glob + ask 传输 + grants（移植 Policy.cs 语义）
  Cargo.toml           deps: fuser, serde, toml, libc, nix
  tests/               集成测试（node:test runner，见 §10）
```

- 构建：`cargo build --release`；新增 `scripts/build-linux-sandbox.cjs` + `forge.config.cjs` 的 `stageLinuxSandboxResource`（对齐现有 `stageWindowsSandboxResource`）；
- CLI 模式不安装二进制（对齐现有行为），`scanSupportedShells` 不注册沙箱变体。
- fuser 源码管理：`vendor/` 不再是入库的第三方源码树，而是构建时生成的本地缓存
  （`.gitignore` 排除）。`build-linux-sandbox.cjs` 在 `cargo build` 前确保
  `vendor/fuser` 就绪——缺失或 `patches/fuser-0.15.1.patch` 更新时，从 crates.io
  下载 `fuser-0.15.1.crate`、解压并 `patch -p1` 应用补丁（负缓存 entry、entry/attr
  TTL 分离、dead_code allow），以 `.patched` 标记记录 patch 指纹避免重复重打。
  下载地址可用 `OPENDESK_FUSER_CRATE_URL` 覆盖为镜像。

## 10. 测试策略（TDD，测试先行）

**单元（jest / node:test）**：policy 生成（真实路径、deny 优先、`**` 展开）、ask-path 恒等、run args 组装、scan 变体注册。

**集成（`npx tsx --test native/linux/sandbox/tests/runtime.test.ts`，rootless 环境）**：

- 透明路径：`pwd` / `$PWD` == 宿主路径；工作区文件读写走 FUSE；
- ask 决策：读 allow / 写 ask / deny；超时 fail-closed；决策缓存；子树授权；
- **逃逸用例（§6 逐条固化）**：umount 失败或露出空目录、chroot 逃逸失败、宿主 `.ssh` 不可见、unshare userns 后仍拿不到 backing、setuid 提权无效、`cgroup.kill` 整树陪葬；
- 并发实例隔离（各自挂载点 / cgroup，无需盘符租约）；
- 管理进程被杀 → 整树终止；重挂载 / 清理无残留。

前置检查：`kernel.unprivileged_userns_clone` / AppArmor 状态、fuse 模块、cgroup v2 delegation；不支持时明确报错并禁用沙箱选项。

## 11. 实现状态（2026-09-26）

M1/M2 已完成并验收：

- **native/linux/sandbox**（Rust + fuser）已实现：两次 unshare 装配、uid_map 单映射
  （ns root 映射宿主用户）、tmpfs 新根 + pivot_root、系统目录 ro bind、FUSE 就地
  挂载（透明路径）、fd 经 SCM_RIGHTS 交宿主 daemon、pid-1 内挂 /proc（pivot 前）、
  caps 收敛（bounding set 移除 SYS_ADMIN 等）、attr uid 映射（避免 nobody 权限错位）、
  `--ro-dirs`（工具链只读挂载）。
- 策略引擎：TOML/glob（`**/*/?`）/访问类别分解/HTTP ask（HTTP/1.0 避免 chunked）/
  grants 子树授权/fail-closed/决策缓存；execute 策略映射为 x 位 mask；
  内置 `endpoint` 子命令（对齐 Windows 演示端点）。
- OpenDesk 集成：`sandbox-decide.ts`（公共决策端点）、`dynabox-policy.ts`
  （Windows/Linux 策略生成）、`linux-sandbox.ts`、scan/app/bash/zsh/prompt/locale
  接线、forge 打包、构建脚本。
- 测试：Linux 集成测试 19/19 通过（访问控制/ask/fail-closed/逃逸/可靠性/大文件
  一致性）；OpenDesk dynabox 相关 ut 无回归；宿主演全量 400/401 套件（唯一失败为
  预置的 builtin-account-plugin，与本次改动无关）。

**复杂用例实测**（均在本机 Linux Mint 22.3）：

| 用例                         | 沙箱内  | 宿主基线  | 差距           |
| ---------------------------- | ------- | --------- | -------------- |
| cargo 全量构建 dynobox-linux | 10.03s  | 10.13s    | ≈0%            |
| OpenDesk `npm run test` 全量 | 105.7s  | 92.2s     | +14.6%         |
| 100MB 写读                   | 0.20s   | 0.13s     | +54%（毫秒级） |
| 简单命令启动                 | ~4ms/次 | ~0.7ms/次 | 可忽略         |
| go build（hello）            | 1.6s    | —         | —              |

**已知限制与工程注意**：

- **/proc**：userns 内无法把 proc 挂载到新目录（内核 ns_capable 检查），实现为
  mount on top 宿主 /proc 挂载点（可用）+ move_mount 移到新根，沙箱内 /proc 为
  真实 hidepid=2 的 pid ns 视图。**注意**：曾回退 ro bind 宿主 /proc——该方案允许
  沙箱内经 /proc/<宿主pid>/root 读宿主根（逃逸），已移除，改为 fail-closed。
- **FUSE negative dentry 缓存**：cargo/rustc 等并发创建后立即读元数据可能命中
  negative 缓存（ENOENT）；构建产物建议 `--target-dir` 指向沙箱内 tmpfs（实测
  也更快）。
- 非特权 userns 只允许单条 uid_map（0→宿主用户）：沙箱内 `id -u` 显示 0（ns root），
  已通过 caps 收敛 + 映射保证无宿主 root 特权。
- 透明路径的"痕迹"：statfs/mountinfo 可识别 FUSE 挂载点（路径字符串与目录树一致）。
- `--del-to-trash` 尚未实现（Linux 版删除为直接 unlink；OpenDesk 侧该选项仅
  Windows PowerShell 沙箱显示）。

## 12. 代码审查与修复记录（2026-09-26）

对 Rust 实现做了系统性审查并修复以下问题（均补充了回归测试）：

**沙箱装配（sandbox.rs）**

- 装配状态管道写端未及时关闭：管理进程 `read_to_string` 阻塞到整个 shell 退出，
  cgroup 登记实际失效——写 `1` 后关闭写端，管理进程可在 shell 运行期间继续。
- `umount2` 摘除旧根失败未检查：旧根（宿主全部挂载）残留可致逃逸——改为 fail-closed。
- fork daemon 失败时未清理已 fork 的 daemon（阻塞在 recvmsg）——补清理。
- A 进程 waitpid 丢失 WIFSIGNALED 信号信息——补 128+sig。
- `set_pdeathsig` 竞态窗口（fork 后父已死）——补父进程存活检查。

**FUSE 镜像（mirror_fs.rs）**

- readdir 子目录条目 ino 用根级路径分配：同一文件 lookup 与 readdir 得到不同 ino，
  内核 inode 错乱（已用同名文件回归测试固化）。
- `alloc_ino` 的 check-then-act 竞态：并发 lookup 会给同一路径分配不同 ino——
  inos/paths 合成单锁 InoMap 原子化。
- `setattr` 的 chown uid/gid 未做 userns 映射（沙箱内 0=宿主用户）——补映射，无映射
  uid 拒绝（EPERM）。
- 文件句柄全局锁串行化并发写——句柄改 `Arc<File>`，IO 在锁外执行。

**策略引擎（policy.rs）**

- ask 请求 path 未归一化：缓存 key 与端点 body 不一致——改用规范路径。
- `default="ask"` 被静默当 deny——按 ask_decide 判定。
- 端点响应无大小上限 / authority 未校验——补 1 MiB 上限与字符白名单。
- 策略 `virtual="/"` 会覆盖 tmpfs 新根视图——装配时拒绝（fail-closed）。

**CLI（main.rs）**

- `--policy` 缺失时 `expect` panic——改为优雅报错。
- `--log-file` 解析后未落盘——补启动/退出诊断日志。

新增单元测试 3 项（default=ask、规范化缓存 key、grants 过期清理）与集成测试 2 项
（readdir 子目录 ino 一致性、virtual=/ 拒绝），全部通过。

## 13. 第二轮代码审查与修复记录（2026-09-26）

在第一轮修复基础上再次全量审读，确认 fuser 0.15 为单线程串行请求循环
（MirrorFs 内部 Mutex 属防御性冗余，保留）；继续修复以下问题：

**并发写入（mirror_fs.rs）**

- open(O_APPEND) 后 `write_at(offset)`：Linux 上 O_APPEND 强制 pwrite 追加到
  全局 EOF，与内核发来的 offset 不一致，并发追加同一文件会丢失/覆盖行。
  FUSE 内核已在 VFS 层处理追加语义（write offset 即 EOF），FUSE 层不应再设
  O_APPEND——已移除，新增并发追加一致性测试（两进程各 50 行，断言恰好 100 行
  且无重复）。

**资源清理与启动校验（sandbox.rs）**

- fork 装配进程失败时未清理已 fork 的 daemon（阻塞在 recvmsg）与 root_dir——
  补清理。
- roots.real_path 未校验存在：会挂载空卷后所有 IO 静默 ENOENT——启动前 fail-fast。

**内存管理（policy.rs）**

- 决策缓存插入前清理过期条目（防无界增长）；
- grants 上限 1024（防恶意端点海量下发导致匹配开销失控）。

**工具与并发（endpoint.rs / main.rs）**

- 内置端点每连接独立线程：/slow 这类慢请求不再阻塞其他决策请求；
- debug-rules 补 --path/--access 实际求值（此前仅打印规则表）。

**其他**

- 确认 fuser 单线程模型（性能瓶颈已由 npm test +14.6% 实测量化，可接受）；
- ino 表只增不减：沙箱为短生命周期进程（每命令一个实例），内存随进程释放，
  不构成泄漏——注释说明。

新增集成测试 1 项（并发追加一致性），单测与集成全绿。

## 14. 第四轮代码审查与修复记录（2026-09-26）

本轮补齐 OpenDesk TS 集成层审查与 FUSE 语义/测试盲区：

**OpenDesk 集成层（TS）**

- 【功能缺陷】`linux-sandbox.ts` 未传 `--ro-dirs`：沙箱内 node/cargo/npm 等工具链
  全在宿主家目录（视图外）不可用——补工具链目录探测（PATH 解析 + nvm/cargo/
  rustup/go 候选）并传 `--ro-dirs`；同时经 `DynamicSandboxLaunch.env` 把
  CARGO_HOME/npm_config_cache/GOCACHE 等缓存重定向到沙箱内 /tmp（只读挂载
  缓存目录不可行，重定向避免把宿主可写路径暴露进沙箱）。
- 【功能缺陷】`scan.ts` 用 `require('node:child_process')` 探测 userns：项目为 ESM，
  require 运行时未定义，异常被 catch 吞掉 → 沙箱变体永不注册（静默失效）——改
  ESM import。
- `RUSTUP_HOME` 不能重定向（工具链由 --ro-dirs 从宿主 ~/.rustup 只读挂载，重定向
  到空 tmpfs 会让 rustc 找不到 toolchain）——已修正。
- 【边界】OpenDesk 权限规则若含相对 pathPattern（如 `src/**`），Linux 版恒等导出
  后 Rust 的 normalize 拒绝（非 / 开头）→ 整个策略加载失败——`hostPatternToVirtualLinux`
  改为返回 null 并跳过该规则。

**测试盲区补齐（集成）**

- 多 [[roots]]：多个受控路径独立可见/可写（此前从未测过）；
- 大目录 readdir 分页：600 文件强制多页 offset 续传，完整列出；
- scan 测试对构建产物/userns 的依赖改为条件 skip（CI 未构建二进制时不再误挂）。

## 15. 整根文件系统视图改造（2026-09-26）

按用户要求，从"受控目录 FUSE + 其余路径空 tmpfs"改为**整根视图**：

**布局与语义**

- FUSE 挂到沙箱根（`virtual="/" real="/"`）：沙箱内 `/home`、`/tmp`、`/var` 等
  布局与宿主完全一致；系统目录在其上只读 bind 覆盖（读性能不走 FUSE）；
- 读写权限检查：工作区写放行、其余写 ask/deny、读默认放行（敏感路径显式 deny）；
- `/tmp` 透传宿主目录：**跨沙箱实例持久，关闭不丢失**（修复"新建 tmp 下条命令
  即失"与"家目录写入虚假成功"两个 bug——后者是：非受控路径写入落在内存盘，
  exit=0 但宿主无文件）；
- 局部 [[roots]] 仍可用（挂到子路径）；与整根混用会形成嵌套 FUSE 死锁 → fail-fast。

**权限模型（单映射 userns 下的 attr 表达）**

- uid/gid 统一映射为宿主用户（ns 内唯一有效 uid）：非宿主属主文件（root/系统）
  只暴露 other 权限位，模拟"其他用户"视角——/etc/shadow 等 root 私有文件不可读，
  与真实权限语义一致（内核 make_kuid 对无效 uid 会拒绝一切访问，此前实测 EACCES）；
- 开启 `default_permissions`：内核按 attr 做标准权限检查（真实语义）。

**回收站（--del-to-trash）**

- unlink/rmdir 改写为移动至 XDG Trash（~/.local/share/Trash）：files/ + info/*.trashinfo
  （Path + 本地时间 DeletionDate）；跨文件系统（/tmp 等异盘）保留原文件并报错
  （fail-closed，不静默误删）；
- OpenDesk 侧 `shell_sandbox_del_to_trash` 开关在 Linux 沙箱生效（此前开关显示但无效）。

**FUSE 缓存与一致性**

- `link` 回调实现（cargo 用 hardlink 放置最终产物，缺失时产物静默丢失）；
- entry/attr TTL=1s：真实构建/测试（>1s）缓存自然过期；已知限制：<1s 的
  "创建后立即读取"工具（cargo 最小项目 0.06s）可能命中 negative dentry——
  极端短命令场景需调小 TTL（性能代价：npm test +14.6% TTL1s → +46% TTL0）。

**测试**

- 集成 30 项：新增 /tmp 跨实例持久、整根布局一致、敏感路径 deny、回收站
  （files+trashinfo+时间）、硬链接；既有用例全部适配整根语义（路径可见性、
  卷外写入拒绝等）。

## 16. 命令行场景加压测试与修复（2026-09-26）

对常见命令行场景做系统加压，发现并修复：

**git 完整工作流（agent 最高频）**

- 现象：`git init` 后 `.git/config` 等文件沙箱内不可见（stat 报 `-????`）、
  `git add` 报 `not a git repository`——git 依赖密集"创建后立即读"（.git 内
  lock + rename），1s 的 entry/attr 缓存让新建文件命中 negative dentry 缓存。
- 尝试：vendor fuser 补丁让 lookup error 回复 `nodeid=0,entry_valid=0`
  （内核 negative dentry 不缓存）——简单"创建后读"通过，但 git 的 lock+rename
  时序仍失败（内核 dentry 更新语义不可精确控制）。
- 结论：**默认 TTL=0（不缓存，正确性优先）** + `--cache-ttl` 可调（长构建/测试
  场景可设 1s 提速，npm test 约 +14.6% → 0.5x 时约 +30%，实测数据见 §15）。
- 已固化 `git full workflow` 集成测试（init/add/commit×2/branch/reset）。

**其他场景验证全部通过**

- 文件操作密集：cp -r、tar czf/xzf、find -delete、rm -rf（73+ 文件规模）；
- node：批量读写、递归目录、10MB 流式写、npm pack（需 npm_config_cache 环境，
  已由 linux-sandbox env 接线）；python3：json/os/hashlib；
- 属性：chmod/touch -d 正常；chown 到无映射 uid 被内核拒绝（合理）；
- 符号链接链（2 级）、硬链接、悬垂链接、指向 /etc 的链接（整根预期）；
- 特殊文件名（中文/空格/#）、30 进程并发写；
- /proc：ps/find/grep/du/df；timeout=SIGTERM(124)、kill(143) 信号语义正确。

**修改**

- mirror_fs：TTL 常量 → 实例字段（new 参数），默认 0、`--cache-ttl N` 可调；
- vendor/fuser（636KB，Cargo [patch]）：ReplyEntry::error 回复 negative entry
  （nodeid=0, valid=0）——虽然不足以完全解决 git，但对"创建后立即读"的普通
  场景有效，保留（需要 `git checkout` 关心）。

## 17. 第二轮命令行场景压测（2026-09-26）

清理全部编译警告（vendor fuser 低频协议结构 dead_code 加 allow；冗余常量删除）。

**发现问题并修复**

- `mkfifo` 失败（EIO）：FUSE 未实现 `mknod` 回调——实现 FIFO 与普通文件创建；
  设备/套接字节点（S_IFCHR/BLK/SOCK）daemon 无宿主 root 特权统一拒绝（fail-closed）。
  已固化 FIFO 双向通信集成测试。

**其余场景验证通过（未发现新问题）**

- FIFO 双向通信、/dev/null|urandom|zero 读写、flock 文件锁、随机偏移 IO；
- rsync（300 文件 + --delete）、make -j4 并发构建；万级文件目录 ls（14ms）/find；
- stdin 管道 + 交互读取；环境变量（SBX_ROOT/DYNOBOX_SANDBOX 正确）；PATH 28 段；
- 200 字符超长文件名、50 层深路径；
- 信号语义：timeout(SIGTERM)→124、kill→143；
- node 批量读写/递归目录/10MB 流式写/npm pack（需 npm_config_cache，已接线）。

**已知限制（记录）**

- 非 UTF-8 文件名被防御性拒绝（FUSE name 经 to_str() 校验，防非法路径注入；
  Linux 原生支持但沙箱 FUSE 层不接受——罕见场景，行为可预期）。

## 18. 缓存策略最终方案（2026-09-26）

`--cache-ttl` 手工调参不符合可用性（用户无法判断合适值），改为**无需配置的
分离 TTL**（vendor fuser 支持 entry/attr TTL 分离）：

- **entry_timeout = 0**：dentry/negative 缓存关闭——保证"创建后立即读"一致
  （git 的 lock+rename 密集写入、cargo 产物放置等短周期场景不命中缓存）；
- **attr_timeout = 1s**：文件属性缓存——stat/fstat 走内核缓存，性能回升。

实测（OpenDesk `npm run test`，宿主基线 92s）：

| 策略                           | 耗时       | 相对宿主   |
| ------------------------------ | ---------- | ---------- |
| entry=1s/attr=1s（有 git bug） | 105.7s     | +14.6%     |
| entry=0/attr=0（全不缓存）     | ~136s      | +46%       |
| **entry=0/attr=1s（最终）**    | **117.5s** | **+27.7%** |

取舍：一致性正确（git/cargo/npm 全部可用）为底线；较全 0 提升约 18 个百分点。
再往上需要 fuser 多线程 daemon（大工程、收益不确定），已记录为后续方向。

## 19. 阶段划分与风险

**M1（骨架先行，先做实"限制生效"）**：native 装配（unshare/pivot_root/静态 ro-rw bind）+ 子进程治理（cgroup.kill + pid ns）+ 逃逸测试 + AppArmor 检测/提权安装。

**M2（FUSE + ask）**：FUSE 层 + 策略钩子 + ask 协议 + OpenDesk 集成（§5/§8）。

风险：

- 非特权 user namespace 在 Ubuntu 23.10+/Debian 13 受限（AppArmor）→ §7 处理；运行时检测必做；
- cgroup v2 非特权 delegation 依赖 systemd 版本 → 降级 PID namespace 方案；
- FUSE 工作区大文件 IO 走用户态（系统目录 ro bind 不经过 FUSE，影响面小）。

## 20. 第五轮代码审查与修复记录（2026-09-26，含 x86/arm64 打包验证）

本轮重点：**桌面端打包（deb/rpm）的 x86/arm64 双架构正确性**与若干实现问题。

### 打包架构（x86/arm64）——核心修复

此前 `stageLinuxSandboxResource` 不区分 arch，永远复制构建机的
`runtime/dynobox-linux`；而 `packagerConfig.arch=['x64','arm64']` 与
`electron-forge package --platform=linux --arch=arm64` 组合下，arm64 安装包会塞入
x86_64 二进制，安装后沙箱命令直接 `exec format error`。本轮修复：

1. **产物按 rust target triple 落盘**（`scripts/build-linux-sandbox.cjs`）：
    - 本机构建：`cargo build --release` → `runtime/<host-triple>/dynobox-linux`；
    - 交叉构建：`OPENDESK_SANDBOX_TARGET=aarch64-unknown-linux-gnu npm run build:sandbox:linux`
      → `cargo build --release --target <triple>` → `runtime/<triple>/dynobox-linux`
      （rustup 预检未安装 target 时给出 `rustup target add` 修复提示）；
2. **stage 钩子按目标架构取产物并校验 ELF**（`forge.config.cjs` + 共享模块
   `scripts/packaging/linux-sandbox-arch.cjs`）：arch → triple 映射
   （x64→x86_64-unknown-linux-gnu / arm64→aarch64-unknown-linux-gnu），产物缺失
   直接报错（fail-fast，提示交叉构建命令），并对二进制做 **ELF e_machine 校验**
   （防构建机架构与目标不一致时错架静默进包）；
3. **asar 裁剪**：`PACKAGING_IGNORE_PATTERNS` 补 `native/linux/sandbox` 整树排除
   （对齐 Windows 沙箱），源码/vendor/target/tests 不再进安装包；
4. 交叉构建到 arm64 的完整命令：
   `rustup target add aarch64-unknown-linux-gnu`（+ 交叉链接器）→
   `OPENDESK_SANDBOX_TARGET=aarch64-unknown-linux-gnu npm run build` →
   `npm run make:linux -- --arch=arm64`；x64 同理（或在对应架构构建机上直接构建）。

### 运行期依赖收敛（libfuse）

Cargo.toml 此前 `features=["libfuse", ...]`：fuser 经 pkg-config 链接系统
libfuse3——**构建机无 fuse 开发包时 build.rs 直接 panic 失败**，且产物带
`libfuse3.so.3` 动态依赖（与"静态二进制、零运行时依赖"设计相悖；运行机缺
libfuse3-3 时沙箱命令启动即失败）。本实现只使用 `Session::from_fd` + 直接
`mount(2)`，不需要 fuser 的 mount 辅助——改为
`default-features=false, features=["abi-7-31"]`（pure-rust 后端），实测 ldd 仅剩
glibc（libc/libgcc_s），构建机不再需要 fuse 开发包。

### 进程治理

- **cgroup 登记时机/对象错误**：原实现读到装配成功管道后才
  `cgroup_setup(assemble_pid)`，此时装配进程已 fork 出 shell（S）；cgroup v2
  移动进程不带动已 fork 的子进程，**shell 树实际不在 cgroup 内**，`cgroup.kill`
  兜底失效。修复：fork 装配进程后立即登记（S fork 时继承 cgroup），装配失败路径
  同步清理 cgroup。pid ns + pdeathsig 仍为主保障，cgroup 为第三保险
  （非特权环境无 delegation 时创建失败属预期 best-effort）。

### 非整根（局部 roots）模式

非整根视图下 tmpfs 根没有系统目录，`RO_BIND_DIRS` 的 `mount --bind` 目标不存在
→ 装配必失败（与"局部 [[roots]] 仍可用"的文档承诺矛盾）。修复：非整根模式下
bind 前创建目标空目录；整根视图下绝不创建（会经 FUSE 在宿主根上建目录）。

### 安全面实证（排除项）

- **caps 越权猜想排除**：子进程 bounding set 保留了 `DAC_OVERRIDE/CHOWN/FOWNER`
  等，理论上可能绕过 `default_permissions`。实测（沙箱内 chmod 000 文件读写、
  /etc/shadow 读取）：均被内核 EACCES 拒绝，与宿主语义一致——权限检查未被
  DAC_OVERRIDE 绕过，无需移除 caps（FUSE attr uid 映射 + ro bind 挂载语义下
  内核按挂载 userns 做有效判定）。
- **ask 响应头分隔兼容**：`post_decide` 兼容 `\n\n`（非标准端点），`\r\n\r\n`
  优先。

### 测试

- 打包配置单测 6 项（`src/tests/ut/node/packaging/linux-sandbox-config.test.ts`）：
  arch→triple 映射、ELF e_machine 解析/拒绝、stage 钩子按 arch 取产物 + 缺失/
  架构不符 fail-fast、ignore 模式覆盖；
- 集成测试 2 项（宿主 /dev/fuse 环境执行）：非整根局部 roots 启动 + 系统目录
  ro bind + 受控写入落盘；cgroup 成员登记（delegation 可用时严格断言，否则
  best-effort 语义）。
- 回归：packaging 三件套 33 项全绿；Rust 单测 16 项全绿；jest unit
  377/381 通过（3 个失败为预置 builtin-account-plugin、scan 测试在嵌套 userns
  环境的 unshare 探测差异（宿主通过）、task-llm-retry 偶发，均与本次改动无关）。
