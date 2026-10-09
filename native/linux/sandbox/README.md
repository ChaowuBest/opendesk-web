# dynobox-linux —— 基于 LD_PRELOAD 的 Linux 文件访问控制沙箱

Linux 平台的动态沙箱，与 OpenHarmony（dynobox）、Windows（Detours hook）、macOS
（DYLD interpose）同一套 OpenDesk 动态沙箱体系。**源码复用**：与 OpenHarmony 版共用
`native/openharmony/sandbox/src/` 下的一套 C 实现（core 策略引擎 + LD_PRELOAD
拦截层 + CLI），本目录只提供构建脚本与运行时布局，**不持有第二份源码**。

## 原理

通过 `LD_PRELOAD` 注入 `libdynobox.so`，拦截进程的文件系统调用（open/unlink/rmdir/
rename/chmod/execve 等），对每次访问按策略（TOML 规则，真实路径匹配）判定：

- **allow**：放行
- **deny**：拒绝（errno=EACCES）
- **ask**：向宿主决策端点发起 HTTP 询问（超时/不可达一律拒绝，fail-closed）
- **写目标父链缺失透传（判定层，四平台统一）**：写类操作（open 写模式/mkdir/rename
  目标）的直接父目录当前不存在时，该写注定失败（内核返回 ENOENT），直接透传内核
  错误码、不触发 ask（deny 规则仍优先拦截）。典型噪音源：dbghelp/SymSrv 按模块
  内嵌 CodeView 路径（如 node.exe 的 `c:\ws\out\Release\node.pdb`）探测写入符号缓存。

路径语义为**身份命名空间**：沙箱内路径与宿主完全一致，无虚拟根/路径映射（与
OpenHarmony 版一致）。系统运行时读/执行由内建 `system_read` 清单放行，写工作区
放行、其余询问（策略由宿主 TS 层生成，见 `src/main/applications/terminal/sandboxes/dynabox-policy.ts`）。

与 FUSE 版的关键差异：

| | FUSE 镜像卷（已移除） | LD_PRELOAD（当前） |
|---|---|---|
| 机制 | mount FUSE + userns + pivot_root | 进程内符号拦截 |
| 环境依赖 | /dev/fuse + userns + mount 权限 | **仅需 LD_PRELOAD，无特权/环境依赖** |
| 安全边界 | 内核强制（裸 syscall 也拦） | 裸 `syscall()` 可绕过（与 OH/macOS 同级，README 已知边界） |
| 性能 | FUSE 用户态往返 | 直调 libc，更低开销 |

## 构建

```bash
npm run build-sandbox:linux                # 本机构建（make + runtime 落盘）
OPENDESK_SANDBOX_TARGET=aarch64-unknown-linux-gnu npm run build-sandbox:linux  # 交叉构建
```

产物：`runtime/<triple>/{dynobox, libdynobox.so}`（两者必须同目录——launcher 的
`find_preload_lib()` 在 dynobox 自身目录旁查找 libdynobox.so）。

直接 make：

```bash
make            # build/{dynobox,libdynobox.so}
make runtime    # runtime/<host-triple>/（strip）
make unit       # core 策略引擎单元测试
```

## 用法

```bash
dynobox run --policy <rules.toml> --upstream http://127.0.0.1:8080/decide \
    --cwd <工作目录> --log-file <日志> [--del-to-trash --trash-dir <回收站>] \
    -- <命令> [参数...]
```

策略文件（与 OpenHarmony 版同构，规则 path 为宿主真实路径）：

```toml
version = 1
default = "deny"

[[rules]]
path = "/home/user/work/secret.txt"
access = "all"
perm = "deny"

[[rules]]
path = "/home/user/work/**"
access = "read"
perm = "allow"

[ask]
endpoint = "http://127.0.0.1:8080/decide"
timeout_ms = 2000
cache_ttl_seconds = 60
grant_ttl_seconds = 300
```

### 规则匹配语义（四平台统一：most-specific）

一条路径命中多条规则时，取**最具体**的模式（剥离尾部 `/**` 后的前缀最长）；
同长按 deny > ask > allow。**规则书写顺序无关**——"宽 allow 在前 + 精确 deny
在后"的防御写法总是生效，防护不依赖作者记得把 deny 放前面（历史 first-match
语义下该写法是 fail-open 陷阱，见 OpenHarmony bugs.md BUG-009）。同一策略在
Linux / OpenHarmony / macOS / Windows 上判定结果一致。

### ask 架构（协议入 core，传输按平台）

请求构造（`dbox_ask_build_request`）与响应解析（`dbox_ask_parse_response`，
含 grants 子树授权下发）由共享 core 的 ask.h 提供——四平台同一份协议实现。
传输层按平台：Linux/OpenHarmony 走 rawio socket（HTTP/unix://）；Windows 走
WinHTTP / 命名管道（common/ask.cpp）；macOS 走 /usr/bin/curl 子进程。

## 回收站（--del-to-trash）

删除文件/目录时移入 OpenDesk 统一回收站：`<trashDir>/<uuid>.back` + 追加
`summary.json` 记录（uuid / original_path / size / deleted_at ISO8601 UTC），与
Windows/Linux/macOS 各平台协议完全一致。宿主侧读取/搜索/找回见
`src/main/utils/trash.ts`。

- 回收站目录写保护：沙箱内对 `<trash>/**` 的任何写操作一律拒绝（内建 trash-protected）。
- 跨文件系统（EXDEV）：回收站目录与被删文件不同设备时**保留原文件并报错**（fail-closed，
  绝不静默真删——BUG-020 修复）。
- 沙箱实例内新建文件：删除直接清除，不进回收站（临时文件语义）。

## 已知边界（与 LD_PRELOAD 类沙箱同级）

- 进程内直接 `syscall()`、已打开 fd 的后续操作不在拦截范围（与 OH/macOS 同源，见
  OpenHarmony bugs.md 的 BUG-017 能力边界说明）。
- 策略按调用时路径判定，不解析符号链接。

## 源码复用关系

```
native/openharmony/sandbox/src/
  policy.c pathmap.c ask.c cfgio.c util.c log.c mini_toml.c   ← core 策略引擎（纯 POSIX C）
  preload.c   ← LD_PRELOAD 拦截层（glibc / musl 双兼容）
  main.c      ← CLI（run / endpoint / debug-rules / version）
  endpoint.c  ← ask 决策端点
native/linux/sandbox/Makefile    ← 引用上述源码构建（不复制）
native/darwin/sandbox/src/boxdylib.c  ← macOS 版（DYLD interpose，独立实现，未来可复用 core）
```

## 测试

```bash
make unit       # core 策略引擎单测
npm test        # 宿主 TS 侧（策略生成 / shell 扫描 / 打包）
```

端到端（真机）：见 OpenHarmony 侧 bugs.md 的测试方法论（本实现与之同源）。
