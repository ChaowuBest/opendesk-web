# dynobox-darwin：macOS 轻量动态沙箱

基于 `DYLD_INSERT_LIBRARIES` interposing 的用户态沙箱，与 Linux（FUSE + namespace）/ Windows（AppContainer + 镜像卷）dynobox 功能对齐：

- **透明路径**：沙箱内文件系统布局与宿主完全一致，无虚拟根；
- **策略管控**：读默认放行、任务工作区写放行、其余写按策略 ask/deny（TOML 策略与 Linux 同构，复用 `policyTextLinux`）；
- **写目标父链缺失透传（判定层，四平台统一）**：写类操作（open 写模式/creat/fopen 写/rename/mkdir/chmod/symlink/link/mknod/setxattr——全部汇聚 `check_write_path`）目标**直接父目录当前不存在**时该写注定失败（内核 ENOENT），直接透传不触发 ask（deny 规则仍优先拦截，alias 变体参与最具体竞争）。典型：dbghelp/SymSrv 按模块内嵌 CodeView 路径（node.exe 的 `c:\ws\out\Release\node.pdb`）探测写符号缓存，不再弹审批框；
- **读目标缺失透传（判定层，与 Linux/Windows 读 ENOENT 豁免同语义）**：纯读操作（open 读模式/openat 读/fopen 读——汇聚 `check_read_path`）目标当前不存在时读不到任何内容，直接透传不判定不 ask（deny 规则仍优先拦截防 deny 区存在性探测泄露，alias 变体参与最具体竞争）。典型：git status 每次对 attributes 查找链上不存在的 `~/.config/git/attributes`、`<Git 安装前缀>/share/git-core/gitattributes` 做存在性探测，cache_ttl=0 不缓存，此前逐次弹读审批框；
- **匹配语义**：most-specific（四平台统一）——命中多条规则取最具体模式（剥尾
  `/**` 的前缀最长），同长 deny > ask > allow，规则顺序无关；
- **策略引擎复用共享 core**：TOML 解析（mini_toml.c）与路径 glob 匹配由
  `native/openharmony/sandbox/src` 提供（三平台单一来源）；本 dylib 保留 macOS
  特有外壳：`/var↔/private/var` 别名竞争、curl ask 传输；
- **权限审批**：ask 请求走与 Linux/Windows 相同的 HTTP `/decide` 协议
  （`sandbox-decide.ts`），请求构造/响应解析用共享 core 的协议函数（严格 JSON，
  含 grants 下发语义对齐）；
- **watchdog 进程治理**（对齐 Linux/OH）：dylib 为每个沙箱进程布防 kqueue
  EVFILT_PROC 监听父进程；宿主退出 → kill 本进程组整树陪葬（沙箱 shell 由
  TS 层 detached spawn 建立独立进程组）；
- **回收站**：`OPENDESK_SANDBOX_TRASH=1` 时，任务开始前已存在的文件删除送
  **OpenDesk 任务级回收站** `<opendesk>/trash/<taskId>/`（由宿主通过
  `OPENDESK_SANDBOX_TRASH_DIR` 传入），沙箱实例内新建文件删除时直接清除（与
  Linux TTL/Windows 跟踪语义一致）。同一任务多次删除以 UUID 命名（`<uuid>.back`
  + summary.json，四平台协议一致）。回收站目录写保护：写/删除回收站内容一律
  拒绝（对齐 Linux/OH/Windows 的 trash-protected）。

## 构建

```bash
npm run build-sandbox:darwin                    # 宿主架构 + 必备 slice
OPENDESK_SANDBOX_ARCH=all npm run build-sandbox:darwin   # 三架构全量（打包前建议）
```

产物：`runtime/dynobox-darwin.dylib`（universal）。

**架构要求**：dylib 必须包含 `arm64e` slice —— `/bin/zsh` 等系统二进制是 arm64e 平台二进制，dyld 只接受同 ABI 的插入库。

## 平台二进制重签（关键机制）

dyld 对不同二进制的插入行为：

| 二进制类型 | DYLD_INSERT 行为 |
| --- | --- |
| Apple 平台二进制（/bin/zsh 等，无 CS_ADHOC） | 静默忽略 |
| 平台 arm64e + 架构不匹配的插入库 | 直接终止 |
| hardened runtime 第三方二进制（CS_RUNTIME） | 默认终止 |
| 普通 adhoc / linker-signed 二进制 | 允许注入 |

因此：

1. 宿主侧（`darwin-sandbox.ts` 的 `prepareShellForSandbox`）启动 shell 前把平台二进制复制到缓存（SHA-256 命名，`~/Library/Caches/com.opendesk.sandbox/exec`）并 adhoc 重签，以副本启动；
2. 沙箱内 dylib interpose 了 `execve`/`posix_spawn`，子进程为平台/hardened 二进制时执行同样的复制+重签+缓存（同一哈希命名，两供建立的副本一致）；
3. shebang 脚本改写为直接 exec 解释器，避免内核直接加载平台解释器绕过沙箱。

## interpose 范围

文件：`open`/`fopen`/`creat`/`unlink`/`unlinkat`/`rmdir`/`rename`/`renameat`/`mkdir`/`chmod`/`chown`/`truncate`/`ftruncate`/`symlink`/`link`/`mknod`/`setxattr`/`removexattr`/`write`/`pwrite`；
进程：`execve`/`execvp`/`execvP`/`posix_spawn`/`posix_spawnp`（exec 系经 `__execve`/`__posix_spawn` 直通内核——interpose 环境下 `dlsym(RTLD_NEXT)` 会解析回替换函数自身，不可用）。

沙箱自身 IO（日志、签名缓存、ask 的 curl、codesign）经线程局部深度计数豁免策略检查，防递归。

## CLT 编译工具链白名单

`prepare_exec` 对位于 `/Library/Developer/CommandLineTools/` 下、basename 命中编译/链接驱动
清单（`cc`/`clang`/`clang++`/`gcc`/`g++`/`ld`/`swift`/`swiftc`/`ar`/`ranlib`/`nm`/`strip`/
`libtool`/`install_name_tool`/`otool`/`codesign`/`lipo`）的 exec 走**豁免路径**：不复制重签、
剥离 `DYLD_INSERT_LIBRARIES` 原地运行（这类二进制依赖树庞大，重签副本在编译子进程链上实测
hang；其写操作几乎总落在工作区/工具链缓存，policy 已放行。**git 等数据类工具刻意不在清单**，
写必须管控）。匹配语义：

- 基名**精确匹配**或 **`<基名>-<纯数字>` 版本后缀匹配**（`clang-14`/`gcc-12` 等版本别名
  随 CLT 版本演进出现，逐个枚举会过时；纯数字约束保证 `clang-format`/`clang++` 等
  连字符名不会误命中）；
- `lipo` 只豁免只读子命令（`-archs`/`-info`/`-detailed_info`）；变更型子命令
  （`-create`/`-thin` 等 `-output` 形态）直接拒绝（fail-closed）。

豁免前 `policy_check(ACC_EXEC)` 已完成，豁免的只是「重签+注入」机制，不绕过执行权限管控。
匹配函数（`clt_toolchain_basename`）的单测见 `src/tests/ut/node/boxdylib-matching.test.ts`
（C harness）与 `src/tests/ut/terminal/darwin-sandbox-kernel.test.ts`（真进程）。

## xcode-select tool-shim 特殊处理

`/usr/bin/python3` 等 78 个 CLT 工具是 xcode-select 的 **tool-shim**（平台二进制，
Identifier=`com.apple.dt.xcode_select.tool-shim-public`），运行时按自身 basename 到
CLT 的 `usr/bin/` 下查找真实工具。两个坑与对策：

1. **副本必须保留原 basename**：缓存布局为 `cache/<hash>/<原basename>`（目录化），
   平铺 `<hash>.bin` 会让 shim 报 "Failed to locate ... requesting installation of
   command line developer tools"（exit 72）。
2. **CLT 真实工具的 @executable_path 依赖**：真工具（如
   `.../Python3.framework/.../bin/python3`）依赖相对框架。副本路径镜像原目录的
   最后 N 级层级（N = 依赖最大上跳数），并为每条 `@executable_path` 依赖创建
   符号链接指回原位置。

**管控链路完整性**：shim → 真实工具 → 真实工具 spawn 的子进程，全程通过
`DYLD_INSERT_LIBRARIES` 环境变量传递注入——每层进程（含普通签名的 CLT 真实
工具、Python.app）都加载本 dylib，文件操作管控在每一层都生效。实测脚本内
`python3` 写工作区外会被拒绝（PermissionError）。

## 已知边界（与 LD_PRELOAD 类沙箱同级）

- 进程内直接 syscall、mmap 后自写代码段不在拦截范围；
- 策略按调用时路径检查，不解析符号链接（TOCTOU 与 Linux 镜像层同粒度）；
- App Store 分发的 hardened Electron 宿主不影响：沙箱只注入 shell 子进程。

## 配置（环境变量，宿主 TS 层注入）

| 变量 | 说明 |
| --- | --- |
| `OPENDESK_SANDBOX_POLICY` | 策略 TOML 路径（缺省 passthrough） |
| `OPENDESK_SANDBOX_LOG` | 日志路径 |
| `OPENDESK_SANDBOX_TRASH` | =1 时删除送废纸篓 |
| `OPENDESK_SANDBOX_TRASH_DIR` | 任务级废纸篓目录（`<opendesk>/trash/<taskId>/`，多级自动创建） |
| `OPENDESK_SANDBOX_EXEC_CACHE` | 平台二进制重签缓存目录 |

## 测试

```bash
npm test -- --selectProjects unit --testPathPatterns 'darwin-sandbox'   # 单测 + 端到端
```

端到端覆盖：工作区写放行、工作区外写拒绝/decide 授权放行、预存在文件删除送废纸篓、实例内新建文件直接清除、shebang 脚本经解释器改写后仍受管控。
