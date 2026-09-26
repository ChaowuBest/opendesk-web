# dynobox-linux 测试场景清单

本文档以自然语言描述沙箱已覆盖的测试场景（不做代码细节），供回归与后续扩展参考。
自动化测试入口：

- **Rust 单元测试**：`cargo test`（策略引擎 policy.rs，见 §12）
- **Linux 集成测试**：`npx tsx --test native/linux/sandbox/tests/runtime.test.ts`（访问控制/ask/逃逸/可靠性/整根视图/文件语义等）
- **OpenDesk 侧单测**：`src/tests/ut/terminal/*.test.ts`（策略生成、shell 扫描、prompt 文案、工具链探测）

---

## 1. 基础访问控制

- 读：策略允许的文件可读（内容一致）；静态 deny（如 secret.txt）拒绝读（EACCES）
- 写：工作区/受控目录内写入落盘（宿主可验证）；卷外写入被策略拒绝（明确报错，非虚假成功）
- 枚举：目录可列出；未映射/不存在路径不可见
- 执行：允许的脚本可执行；execute-deny 的脚本被拒（x 位掩码）；execute-ask 经端点放行
- 目录操作：mkdir/mv/rm/rmdir 在受控区域可执行；卷外全部被策略拒绝
- 文件属性：chmod（644→600→711 生效）、touch 时间戳（指定时间生效）、chown 到无映射 uid 被内核拒绝

## 2. ask 决策引擎

- ask→allow：staging 写经端点放行（写入落盘）
- ask→deny：reject 路径被端点拒（EACCES）
- ask 超时：slow 路径端点挂起 → 沙箱侧 fail-closed 拒绝（不进缓存）
- 子树授权：scratch 写 5 个文件仅 1 次 ask（端点下发子树授权）
- 决策缓存：同一规范化路径两次 ask 命中缓存（仅 1 次请求）
- 兜底规则：读默认放行、写默认 ask、执行默认放行（整根视图）

## 3. 进程与治理

- 子进程退出码透传（exit 0/37/42）
- 后代进程链（bash→bash→bash）策略延续
- 管理进程被杀（SIGKILL）→ 整树陪葬（心跳停止验证）
- **cgroup 成员登记**：shell 树位于 dynobox-* cgroup（宿主 delegation 可用时
  严格断言；否则验证 best-effort 语义，pid ns + pdeathsig 为主保障）——回归：
  登记时机必须在装配进程 fork shell 之前（§20 修复，此前 shell 树不在 cgroup 内）
- 并发沙箱实例隔离（各自挂载点/写入互不干扰）
- 正常退出无残留（/tmp/dynobox-root-*、cgroup 清理）
- 陈旧 root_dir 回收（上次被 kill 的孤儿目录下次启动清理）

## 4. 整根文件系统视图

- 布局与宿主一致：/home、/tmp、/usr、/var 等全部可见
- /tmp 透传宿主：沙箱写入跨实例持久（关闭不丢失）
- 敏感路径读 deny：~/.ssh、~/.aws、~/.gnupg、~/.git-credentials 等显式拒绝
- 多 [[roots]]：与整根混用被拒绝（fail-fast，防嵌套 FUSE 死锁）；局部 root 覆盖语义
- **局部 [[roots]]（非整根）模式**：系统目录 ro bind 可用（tmpfs 根无系统目录时
  bind 目标自动创建）+ 受控路径写入落盘宿主（§20 修复：此前非整根模式装配必失败）
- virtual="/" 合法性：整根视图合法；局部+整根混用拒绝

## 5. 逃逸防护

- umount/mount 在沙箱内失败（caps 收敛）
- chroot 失败（无 CAP_SYS_CHROOT）
- /proc/<pid>/root 解析到沙箱根（宿主敏感文件不可达）
- /proc/self/exe、meminfo 等工具兼容性正常
- uid_map 显示 ns root 映射宿主用户；无宿主 root 特权
- 系统目录只读（/etc 写失败）；root 属主文件按 other 权限（/etc/shadow 不可读）

## 6. 文件语义与一致性

- 大文件写读一致性（4MiB hash 校验）
- 并发追加同一文件不丢行（O_APPEND 语义由内核处理）
- 子目录 readdir 的 ino 映射正确（根级同名文件不串扰）
- 大目录 readdir 分页（600+ 文件多页 offset 续传完整列出）
- 硬链接创建/读取（cargo 产物放置依赖）
- FIFO 创建与双向通信（mkfifo + 读写）
- flock 文件锁（python fcntl）
- 随机偏移 IO（lseek + patch 读）
- 万级文件目录 ls/find（性能）

## 7. 回收站（--del-to-trash）

- 删除文件 → XDG Trash（files/ + info/*.trashinfo，本地时间）
- 跨文件系统（/tmp 等异盘）删除保留原文件并报错（fail-closed）
- 原文件移除且宿主侧验证落盘

## 8. 命令行场景

- 文件操作密集：cp -r、tar czf/xzf、find -delete、rm -rf
- git 完整工作流：init/add/commit×2/branch/reset（密集 lock+rename 一致性）
- node：批量读写、递归目录、10MB 流式写、npm pack
- python3：json/os/hashlib、mmap 场景
- rsync（含 --delete）、make -j4 并发构建
- 管道：stdin 读取、grep 管道、进程替换
- 特殊设备：/dev/null、/dev/urandom、/dev/zero 读写
- 符号链接链（2 级）、悬垂链接、指向 /etc 的链接
- 特殊文件名（中文/空格/#）、非 UTF-8 文件名（防御性拒绝）
- 超长文件名（200 字符）、深路径（50 层）
- 信号语义：timeout→SIGTERM(124)、kill→143
- 环境变量：SBX_ROOT=/、DYNOBOX_SANDBOX=1、PATH 传递

## 9. 高级命令行场景

- 进程替换 `<(...)` 与 `/dev/fd/N`（bash diff/cat 进程替换）
- socket 网络：python http.server 回环 + curl + TCP 客户端双向（AF_INET 回环）
- sparse 文件：1GB 稀疏 + 偏移 patch + 尾部读
- mmap 文件映射（python mmap 写读）
- xargs -P 4 并发 ×20、gzip 管道（tar czf/xzf）
- fd 重定向（exec 3>）、heredoc、/dev/fd 无泄漏（100 次操作 fd 数不变）
- 文本工具链：sed/awk/sort/uniq/diff/patch
- 守护进程：nohup 后台长进程、setsid
- locale（中文）、ulimit -n、复杂管道链（seq|grep|awk）
- 符号链接链、硬链接、悬垂链接、指向 /etc 链接
- 超长文件名（200 字符）、深路径（50 层）、非 UTF-8 文件名（防御性拒绝）

## 9b. 后续轮次新增场景（第 5-8 轮）

- **Unix socket**：AF_UNIX bind/accept 双向（mknod S_IFSOCK，修复）
- 目录 rename（mv 目录、swap 目录对换）、rmdir 非空报错
- flock 双向竞争（两线程各 50 次互斥追加 100 字节）、跨进程 flock（NB 被阻塞拒绝）
- /dev/shm 共享内存映射、inotify 文件事件监听（CREATE/DELETE 48 字节）
- bash 特性：alias/function/数组/mapfile/globstar/dotglob/umask/source/trap EXIT+RETURN
- errno 矩阵：ENOENT/Is-a-directory/文件当目录/Read-only/EPERM shadow/Directory-not-empty
- 并发目录 mkdir/rm（20×10 竞争，仅少量合理残留）
- 数据完整性：300 随机文件 sha256 校验全 OK
- 符号链接环/悬垂、`./`/`..` 路径边界、软链目录作为 cwd
- setuid/sgid/sticky 位（4755/2755/1777）、默认 644（umask 022）
- 1GB 大文件写读回 hash 一致、100MB 管道大流量 md5
- SIGINT 后台语义（与宿主一致）、sh/dash 兼容、find -exec、时间戳（秒/纳秒）
- 200000 行输出、二进制输出、base64、多语言字符、CRLF 文本
- 并发读同文件 8×、父目录 000 权限（errno 语义记录）、高 fd 场景
- O_TMPFILE（FUSE 无回调 ENOTSUP，合理限制）、cp --reflink/--sparse、sparse du
- glob 展开（500 文件/`?`/`[...]`）、僵尸回收、超长参数/大量环境变量（与宿主一致）
- shebang（#!/usr/bin/env python3 等）与符号链接执行
- pread/pwrite 定位语义、并发 seek+write（宿主一致：python 线程不安全，非沙箱）
- 混合长任务稳定性：git+node+tar+find+xargs 序列 ×2 结果一致

## 10. 性能

- OpenDesk `npm run test` 全量：宿主 92s；沙箱（分离 TTL）117.5s（+27.7%）
- 简单命令启动开销 ~4ms/次
- 万级目录 ls 14ms

## 10. 策略引擎（Rust 单元测试承载）

见 §12：路径归一化、glob 匹配（`**/*/?`）、ask HTTP、default=ask、规范化缓存、
grants 过期清理。

## 11. OpenDesk 集成层

- 策略生成：整根 roots、敏感路径 deny、工作区写放行、.gitconfig 写放行、
  缓存目录（~/.cache/opendesk-sandbox）写放行（dynabox-linux-policy.test.ts）
- 策略完整性回归：生成策略不含残缺规则（曾含字面 `...` 且缺 access/perm，
  导致所有 Linux 沙箱命令"策略文件解析失败"）
- 真实策略可解析：OpenDesk 生成的 policyTextLinux 能被 dynobox-linux 加载启动
- 工具链目录探测（PATH 解析 + 家目录候选，linux-sandbox-utils.test.ts）
- 完整链路：prepareLinuxSandbox 生成的 args/env（--del-to-trash、CARGO_HOME 重定向）
  经沙箱实际执行 + 回收站命中
- 决策缓存 key：Linux 大小写敏感（曾小写化误合并 /Work/a 与 /work/a）
- 二进制解析：打包路径优先、开发路径兜底（CLI/测试环境可用）
- shell 扫描：Linux 注册 bash/zsh 沙箱变体（二进制+userns 可用时）
- prompt 文案：整根布局/tmp 持久描述

## 11b. 打包架构（x86/arm64，node 单测承载）

- arch → rust target triple 映射：x64→x86_64-unknown-linux-gnu、arm64→
  aarch64-unknown-linux-gnu、ia32→i686-unknown-linux-gnu；未知架构抛错
- ELF e_machine 解析：x86_64(62)/aarch64(183)/i386(3)；非 ELF、过短、大端 → null
- assertLinuxElfMachine：架构不符/非 ELF fail-fast 拒绝（防错架二进制进包，
  安装后 exec format error）
- stageLinuxSandboxResource：按目标架构取 runtime/<triple>/ 产物、移除 native 树、
  产物缺失报错提示 OPENDESK_SANDBOX_TARGET、ELF 校验
- PACKAGING_IGNORE_PATTERNS 覆盖 native/linux/sandbox 整树（asar 不进源码/
  vendor/target）
- build-linux-sandbox.cjs：本机构建落 runtime/<host-triple>/；交叉构建
  OPENDESK_SANDBOX_TARGET 时 rustup target 预检给出 rustup target add 提示

## 12. Rust 单元测试（policy.rs，`cargo test`，16 项）

| 测试 | 场景 |
|---|---|
| normalize_rejects_traversal | 拒绝 `..` 穿越、折叠 `//`、去 `.`、根为 [] |
| glob_star_single_level | `*` 单层级不跨 `/` |
| glob_double_star_crosses_levels_and_matches_self | `**` 跨层级且 `/dir/**` 匹配 `/dir` 自身；`/**` 匹配根 |
| glob_question_mark | `?` 单字符 |
| ask_decide_allow_via_http | HTTP ask 请求格式（POST/decide、Bearer token、路径）+ allow 响应 |
| default_ask_falls_back_to_endpoint | `default="ask"` 未命中规则时按端点判定 |
| check_uses_canonical_path_for_ask_body_and_cache_key | 不同写法同路径规范化后缓存 key 一致（仅 1 次请求） |
| grants_expire_and_are_pruned | grants TTL 过期自动清理 |
| check_fail_closed_on_invalid_path | 非法路径（穿越/控制字符/相对）一律拒绝（fail-closed），即使 default=allow |
| rule_order_specific_before_wildcard | 首条命中规则生效：具体 deny 在前覆盖宽泛 allow |
| access_bits_filter_unrelated_rules | 规则 access 与请求类别无交集时跳过 |
| all_access_covers_rw_e | access=all 覆盖 read/write/execute |
| default_deny_and_allow_semantics | default deny/allow 的兜底语义 |
| grant_matches_subtree_only | grants 子树匹配（含自身）且类别需匹配 |
| normalize_rejects_control_chars | 拒绝控制字符、空路径 |
| policy_load_rejects_bad_perm_and_relative_path | 策略加载拒绝非法 perm 与相对路径规则 |

## 13. 挂载泄漏事故与防传播加固（宿主根曾被 FUSE 覆盖）

**事故**：2026-09-26 20:56 宿主挂载树出现 `dynobox on / type fuse.dynobox`——
沙箱的整根 FUSE 视图挂载到了**宿主根 /**，覆盖整个文件系统（/proc、/dev/fuse 等
伪文件系统全部不可见，只能重启恢复）。

**机制**：mount namespace 中新建挂载的传播类型继承父挂载点。正常情况下装配顺序
`unshare(CLONE_NEWNS) → make-rprivate（全树私有）→ 挂载` 保证新挂载私有、不外泄；
但该次运行时父挂载的传播状态异常（shared），FUSE 挂载的**传播是即时事件**，一旦
发生立即污染宿主挂载树（事后无法撤销，必须重启）。

**防御（fail-closed 双保险）**：
1. 每个挂载点（root_dir tmpfs、FUSE、ro bind、/dev tmpfs、/proc move）**挂载后
   立即显式 `MS_PRIVATE`**，切断其传播组；私有化失败视为致命，宁可不启动沙箱也
   不污染宿主挂载树。
2. 保留装配顺序主防线：`unshare(NEWNS) → make-rprivate → 全部挂载`（bwrap 标准）。

**验证**（重启后宿主正常，防御加装前无法复现，防御加装后多次复现均无泄漏）：
```bash
SBX=native/linux/sandbox/target/release/dynobox-linux
# 单跑 ×3、Electron 风格（家目录 workspace）、并发 ×3 + 中途 kill，均：
mount | grep dynobox   # 必须为 0（宿主无泄漏）
ls -d /tmp/dynobox-root-*  # 无残留
```
**判定标准**：任意沙箱运行（含并发、中途 kill、崩溃路径）后，宿主 `mount` 不得
出现 `dynobox`/`fuse.dynobox` 挂载；出现即视为回归失败（需重启宿主验证是否污染）。
