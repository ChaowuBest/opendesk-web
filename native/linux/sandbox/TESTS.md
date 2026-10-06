# dynobox-linux 测试场景清单（LD_PRELOAD 版）

> 原 FUSE 镜像卷版（Rust）已随架构切换移除，本文档描述 LD_PRELOAD 版。
> 机制与 OpenHarmony 版 dynobox **同源**（共用同一套 C 源码），详见
> `native/openharmony/sandbox/README.md` 与鸿蒙侧 `~/Projects/test-sandbox/bugs.md`
> 的测试方法论（500+ 场景，18 个维度）。

自动化测试入口：

- **core 策略引擎单元测试**：`make unit`（policy/pathmap/ask/cfgio 等，POSIX C）
- **宿主 TS 侧单测**：`npx jest src/tests/ut/terminal`（策略生成、shell 扫描、产物解析、打包）
- **端到端（真机）**：按 OpenHarmony 侧方法论执行（本实现与之同构）

## 功能覆盖（继承自 OpenHarmony 版实现）

- **基础访问控制**：read/write/execute 三类独立求值，组合类别（O_RDWR）逐类别判定；
  静态 deny / ask 动态决策 / grants 子树授权 / 决策缓存
- **路径语义**：身份命名空间（真实路径规则）；符号链接真实路径解析；`*`/`**` glob
- **删除与回收站**：`--del-to-trash` 移入统一回收站（`<uuid>.back` + `summary.json`，
  协议与 Windows/Linux/macOS 一致）；回收站目录写保护（trash-protected DENY）；
  跨设备 EXDEV fail-closed 保留文件；沙箱内新建文件删除直接清除；
  **无恢复价值目标不入站**（0 字节普通文件、空目录——含 `rmdir` 与
  `unlinkat(AT_REMOVEDIR)` 两条路径，判定核心为 `dbox_trash_worth_keeping`，
  单元测试见 `make unit` 的 `test_trash_worth_keeping`，真机回归见
  `tests/run_all.sh` 的 `trash` 分段；`rm -rf` 只留下内容条目，不再产生空壳）；
  **排除清单**（`--trash-exclude` 可重复 → `DYNOBOX_TRASH_EXCLUDE`，':' 分隔）：
  命中目录前缀的删除直接真删、不入站（内建临时目录 `/tmp`、`/var/tmp`、`/dev/shm`
  + `DYNOBOX_TMP` 兜底，宿主再显式传入已知临时目录），判定核心为
  `dbox_trash_excluded`（`make unit` 的 `test_trash_excluded`）
- **进程治理**：watchdog 管道（launcher 退出 → 整树陪葬）；`build_envp` 环境变量
  强制重注入（9 个 DYNOBOX_* + LD_PRELOAD 不可篡改）；exec 家族拦截（execve/execvp/
  execvpe/posix_spawn/system/popen/fexecve）
- **ask 决策**：HTTP POST /decide；端点点故障（拒绝/超时/坏响应）全部 fail-closed；
  grants 不可越过静态 deny
- **安全属性**：环境变量篡改重注入、dlsym(RTLD_NEXT) 无法绕过、进程树策略继承、
  并发（shm 锁）、TOCTOU 窗口覆盖

## 已知边界（与 OH/macOS 同级）

- 进程内直接 `syscall()` 绕过 libc 封装（README 能力边界；OH 侧 BUG-017 已验证属
  机制边界非缺陷）
- 策略序列化（DYNOBOX_CFG）超过 64KB 时 fail-closed 拒绝启动（BUG-015 修复，不再
  静默降级为无沙箱）
- fd 系属性入口（fchmod/fchown/futimens）已补 write 判定（BUG-025 修复）

## 打包与布局

- 构建产物：`runtime/<triple>/{dynobox, libdynobox.so}`（必须同目录）
- 打包：`resources/sandbox/{dynobox, libdynobox.so}`（forge stageLinuxSandboxResource，
  校验 ELF e_machine 防错架二进制）
- 架构：x86_64-unknown-linux-gnu / aarch64-unknown-linux-gnu / i686-unknown-linux-gnu