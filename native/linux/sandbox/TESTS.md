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

## 9c. 策略逃逸与语义修复（第 1 轮审视，2026-09-30）

- **硬链接逃逸**：link 对 all-deny 源文件必须拒绝（link 现同时要求源路径 write
  放行——否则敏感文件可链进可写目录后经 `/** read allow` 兜底读出）
- **O_TRUNC 逃逸**：open 携带 O_TRUNC（含 O_RDONLY|O_TRUNC）计入 write 类别——
  write-deny 文件不可被"只读"打开清空；经写授权（staging ask→allow）仍可截断
- **组合类别逐类别判定**：O_RDWR（read|write）拆分逐一判定，任一类别被拒即拒绝
  （对齐 Windows MirrorFs.Check）；read allow 不再放行 write deny 的组合打开
- **ask 上报类别**：组合位按更敏感类别上报（read|write → "write"），不再错报
  "execute" 导致 TS 端点 execute 规则静默放行
- **rmdir 回收站语义**：--del-to-trash 下 rmdir 非空目录返回 ENOTEMPTY（此前
  rename 绕过内核空检查，整棵目录树被移进回收站且返回成功）
- **cgroup 登记竞态**：仅父进程登记 cgroup（子进程分支 cgroup_setup(0) 在
  delegation 环境创建孤儿 dynobox-0 并竞争迁移装配进程）
- **readdir 分页边界**：offset 编码统一（"."=1、".."=2、条目 i=i+3），极端小
  缓冲续传不再跳过 ".."
- **attr x 位掩码范围**：execute-deny 仅掩文件 x 位；目录 x 位是遍历权限不掩
- **fixture 完整性**：scratch/reject/slow 目录纳入 makeFixture（此前相关测试
  假阳/失败）；ls 大小断言改用"属组+大小"列（中文 locale 时刻含数字不再假阳）

## 9d. 第 2-5 轮审视（2026-09-30）

- **ask 连接超时**：端点 IP 不可达（黑洞路由）时 connect 受 timeout_ms 约束
  （此前系统级 TCP 超时 ~2min 会冻结单线程 FUSE 会话）；测试
  ask_connect_timeout_is_bounded（部分环境 connect 立即失败，测试仍作回归保护）
- **rename 目标 deny**：rename 到 write-deny 路径被拒、源文件保留（双侧检查
  的目标分支固化）
- **stat ctime 语义**：FileAttr.ctime 为 inode change time（st_ctim，经
  MetadataExt::ctime/ctime_nsec）——此前误用 birth time（created()）填充，
  chmod 等元数据变更后沙箱内 ctime 与宿主不一致
- **daemon 会话诊断**：FUSE 会话异常退出时输出 stderr 线索（此前静默退出，
  沙箱内只表现突发 EIO 难以定位）
- **优化**：daemon fork 后关闭无关 socket fd（防 daemon 间互持对端）；ask
  决策缓存 4096 条上限（与 MAX_GRANTS 对称）；诊断日志真实日期（civil_time，
  此前输出 epoch 天数）；execute-deny 不掩目录 x 位（目录 x 是遍历权限）；
  内置测试端点用 serde_json 构造响应（path 含特殊字符不破坏 JSON）；
  readdir 条目列表 Arc 共享（大目录多页不逐页克隆）

## 9e. 第二次循环（2026-10-01）

- **daemon umask 双重叠加**：create/mkfifo/mknod 的 mode 已按请求方 umask
  计算，daemon 自身 umask 被内核再次叠加——子进程 `umask 000` 创建文件期望
  0666 实际 0664。修复：daemon 启动 `umask(0)`；回收站目录显式 0700（防
  umask(0) 后首次创建权限落入 0777）；mkdir 改一步 `libc::mkdir`（消除
  "先创建再 chmod"两步之间的宽权限窗口）
- **rename flags 被忽略**：`RENAME_EXCHANGE` 实测被当作普通覆盖执行（目标
  数据静默丢失、源消失）；修复：EXCHANGE/WHITEOUT fail-closed 拒绝（EINVAL），
  NOREPLACE 防御性实现（内核 VFS 层当前已拦截）。`mv -n` 与 renameat2 端到端断言
- **roots 嵌套/重复 fail-fast**：局部 [[roots]] 互相嵌套（/a 与 /a/b）会形成
  嵌套 FUSE 死锁（此前仅拦截"整根+其他"混用）；validate_roots 单测覆盖
  前缀边界（/tmp/w2 与 /tmp/w 不误判）
- **mknod 设备节点拒绝固化**：字符设备 mknod 必须 EPERM 且不落盘（行为已正确，
  测试防御回归）

## 9f. 第三次循环（2026-10-01，协议层视角）

- **xattr 透传**：getxattr/setxattr/listxattr/removexattr 从 ENOSYS 改为透传
  宿主真实路径（l 前缀变体，读=read 写=write 策略；字节级名字支持）——此前
  cp -a/rsync -X/tar --xattrs 退化或警告
- **fallocate 透传**：裸 fallocate 从 ENOSYS 改为透传（fh 优先，路径兜底）；
  os.posix_fallocate 因 glibc 写零 fallback 掩盖缺口，测试用裸 syscall 断言
  且宿主侧验证 size=8192 真实落盘
- **copy_file_range / 裸 mknod(mode 无类型位)**：实测内核已兜底（自动降级拷贝 /
  宿主同为 EINVAL），行为与宿主一致，无需实现（记录判定依据）
- **参数防呆**：--ro-dirs 拒绝相对路径（防沙箱内错误挂载点）；endpoint
  --default 非法值报错（此前静默按 deny）

## 9g. 第四次循环（2026-10-01，协议语义视角）

- **deny 响应的 grants 不再安装**（ask/grants 协议缺陷）：历史实现不检查
  decision 一律安装端点下发的 grants——"虚假拒绝 + 后门授权"可经 grant_hit
  （优先于端点询问）绕过决策。修复：仅 allow 时安装（fail-closed）。Windows 版
  Policy.cs:231-232 存在同一缺陷（本次仅修 Linux，Windows 待单独任务对齐）。
  TS 生产端点 deny 时不带 grants，生产行为不变，纯协议加固
- **fuser 负缓存补丁判定**：ReplyEntry::error 拦截 errno 发 nodeid=0 负缓存回复
  ——与内核 fuse_lookup 对错误的原生处理一致（错误除 ENOMEM/ENAMETOOLONG 外
  本就以 negative dentry 呈现），无需修改
- **连续 `**` 回溯复杂度判定**：glob_match_at 对连续 `**` 的最坏全回溯实测
  4×`**`×25 层路径仅 ~4ms（段比较快速剪枝），非真实问题
- **回归事故与恢复**：临时基准测试清理时误用 git checkout 回滚了 policy.rs
  全部未提交修改，已按会话记录完整重建并全量回归（22/22 + 46/46）

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

## 12. Rust 单元测试（policy.rs / mirror_fs.rs / sandbox.rs，`cargo test`，22 项）

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
| check_combined_access_requires_every_kind_allowed | 组合类别逐类别判定：write deny 不被 read allow 绕过 |
| ask_reports_write_for_combined_rw_access | 组合位 ask 上报 write（不错报 execute） |
| grants_from_deny_response_are_not_installed | deny 响应的 grants 不安装（防虚假拒绝+后门授权） |
| ask_connect_timeout_is_bounded | 端点不可达时 connect 受 timeout_ms 约束 |
| civil_time_converts_epoch_seconds | civil_from_days 时间换算锚点（回收站/日志依赖） |

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
