# dynobox-linux —— 基于 FUSE 的 Linux 文件访问控制沙箱

Windows 平台 `dynobox`（`native/windows/sandbox/`）的 Linux 对等实现。把宿主目录
**就地镜像为 FUSE 卷**：沙箱内路径与宿主完全一致（透明路径），子进程对卷内每一次
打开/创建/删除/改名/枚举都先经过策略引擎（allow/ask/deny），ask 同步询问 OpenDesk
权限引擎，全链路 fail-closed。

## 机制概览

```
OpenDesk / CLI ── spawn ──> dynobox-linux run --policy rules.toml --upstream http://127.0.0.1:P/decide -- <shell...>
                                 │
管理进程（宿主 namespace）        ├─ fork daemon（每 root 一个）：FUSE 会话，直接访问镜像源
                                 └─ fork 装配进程 A：
                                      unshare(USER) → uid_map → unshare(NS|PID|IPC)
                                      → fork S（pid ns 内 pid 1）：
                                          tmpfs 新根 + ro bind 系统目录 + 最小 /dev
                                          + FUSE 就地挂载（透明路径）+ /proc
                                          → pivot_root（丢弃宿主根）
                                          → 收敛 caps（移除 SYS_ADMIN 等）
                                          → exec shell
```

- **透明路径**：`[[roots]]` 的 `virtual = real = 宿主路径`，FUSE 覆盖同名路径，
  沙箱内 `/home/liyi/work/foo` 与宿主同一路径，但 IO 受策略控制；
- **治理**：PID namespace（shell 死 → 全 ns 清空）+ `PR_SET_PDEATHSIG`（管理进程死
  → 整树陪葬）+ cgroup v2 `cgroup.kill`（best effort 双保险）；
- **逃逸防护**：pivot_root 丢弃宿主根、caps 收敛（bounding set 移除
  SYS_ADMIN/MODULE/PTRACE/CHROOT 等）、`/dev` 最小化（不含 /dev/fuse）、
  /proc hidepid=2（内核不允许时回退 ro bind 宿主 /proc）、attr uid 映射
  （ns 内 0 = 宿主用户，杜绝 nobody 权限错位）。

## 构建

```bash
# 依赖：Rust 工具链 + libfuse3-dev（Debian/Ubuntu：apt install libfuse3-dev）
npm run build-sandbox:linux        # 或直接在 native/linux/sandbox 下 cargo build --release
```

产物：`native/linux/sandbox/target/release/dynobox-linux`（及 `runtime/dynobox-linux`）。

> 注意：脚本名刻意用 `build-sandbox:<platform>`（连字符 + 平台段在末尾），
> 因为 run-script-os 会把 `build:<中间段>:linux` 形式的键当作 `build` 的 Linux 平台变体
> （旧名 `build:sandbox:linux` 就踩过这个坑：`npm run build` 在 Linux 上被劫持为沙箱构建
> 后直接退出，跳过 `electron-vite build`）。带连字符的 `build-sandbox` 前缀不是分发器，不会被匹配。

前置检查（rootless 环境必须）：

```bash
unshare -U true && echo OK   # 非特权 user namespace（AppArmor/userns 限制时需放行）
test -e /dev/fuse && echo OK
```

## 使用

```bash
dynobox-linux run --policy rules.toml --cwd /home/liyi/work \
    --ro-dirs /home/liyi/.cargo,/home/liyi/.rustup \
    -- /usr/bin/bash -c 'ls /home/liyi/work'
```

| 选项 | 说明 |
|---|---|
| `--policy <rules.toml>` | 策略文件（TOML，见下） |
| `--upstream URL` | ask 决策端点（HTTP /decide，协议 v2，对齐 Windows） |
| `--cwd DIR` | 沙箱内工作目录（透明路径 = 宿主路径） |
| `--ro-dirs P1,P2` | 额外只读挂载目录（工具链等宿主路径，沙箱内同路径只读可见） |
| `--log-file FILE` | 诊断日志（装配/退出关键事件） |

策略文件（透明路径语义，规则 path 用宿主绝对路径）：

```toml
version = 1
default = "deny"
[[roots]]
virtual = "/home/liyi/work"      # 挂载点（= 宿主路径）
real    = "/home/liyi/work"      # 镜像源
[ask]
endpoint = "http://127.0.0.1:8080/decide"
timeout_ms = 2000
cache_ttl_seconds = 60
grant_ttl_seconds = 300
[[rules]]
path = "/home/liyi/work/secret.txt"
access = "all"
perm = "deny"
[[rules]]
path = "/home/liyi/work/**"
access = "read"
perm = "allow"
```

- `path` glob：`**` 跨层级、`*` 单层级、`?` 单字符；`/dir/**` 同时匹配 `/dir`
- `access`：read / write / execute / all（execute 映射为 x 位掩码）
- `perm`：allow / ask / deny；`default` 可选 allow|deny|ask
- ask 超时/不可达/坏响应 → deny 且不进缓存（fail-closed）

其他子命令：`endpoint`（内置参考决策端点）、`debug-rules --policy P --path P --access K`
（规则求值诊断）、`detect`（userns/fuse 可用性探测）。

## 测试

```bash
cargo test                                   # 策略引擎单元测试
npx tsx --test native/linux/sandbox/tests/runtime.test.ts   # 集成测试套件
```

集成测试覆盖：访问控制矩阵、ask 决策（allow/deny/超时 fail-closed）、子树授权、
执行管控（x 位掩码）、子目录 ino 一致性、并发追加一致性、逃逸用例（umount/mount/
chroot/backing 不可见/uid 映射）、可靠性（并发实例隔离、管理进程被杀整树陪葬、
退出无残留）、大文件一致性。

## 已知限制

- 非特权 userns 只允许单条 uid_map（0→宿主用户）：沙箱内 `id -u` 显示 0（ns root），
  通过 caps 收敛 + 映射保证无宿主 root 特权；
- 内核 ≥7 拒绝非特权 userns 内挂载 proc：回退 ro bind 宿主 /proc（hidepid 不可用，
  跨进程访问由 YAMA ptrace_scope 兜底）；
- FUSE 的 entry/attr 缓存 TTL=1s：并发创建后立即读的可能命中 negative 缓存
  （cargo/rustc 场景）——构建产物建议 `--target-dir` 指向沙箱内 tmpfs；
- 已打开句柄不受后续策略变化影响；解释器执行（python x.py）是"读脚本"，execute
  规则管不到脚本内容（同 Windows 版）；
- `--del-to-trash` 未实现（删除为直接 unlink）。

## 许可

Mulan PSL v2（同仓库其他代码）。fuser/libfuse3 为 LGPL/MIT 双许可。