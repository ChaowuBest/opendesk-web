# HarmonyOS PC CLI 错误知识库

本文档记录在 HarmonyOS PC 的 HiShell/OpenDesk 环境中执行命令行工具时，常见问题的现象、原因及处理方法。所有条目按问题类型归入分类桶。

## 知识库边界

本知识库覆盖：

- HarmonyOS PC 上命令行工具的安装、构建和运行问题
- HiShell/OpenDesk 执行环境与常规 Linux 环境的差异
- 文件系统、权限、工具链、运行时和命令选项兼容问题

本知识库不覆盖 ArkTS、ArkUI、Ability、HAP/HSP、DevEco Studio 或应用开发 API 等通用 HarmonyOS 应用开发问题，也不保证其中方案适用于手机、平板、穿戴设备或其他 OpenHarmony 发行版。

## 重要说明

- **若问题来自 HarmonyOS PC 环境差异且无法规避，可切换到 Headless Node 的 Linux 环境执行（通过 `executeNodeShell`）**。
- 问题与修复方案仅供参考，具体效果可能因系统、SDK、工具和 OpenDesk 版本而异。
- 软件包、工具和运行时的可用版本以各条目链接的上游仓库为准。

## 分类索引

| 桶  | 分类                                                   | 适用场景                                                                            | 典型报错或现象                                                                             |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | [下载与软件源](./01-download-and-network.md)           | pip/npm/Git 下载超时、TLS 证书校验失败或 Git 子模块缺失                             | `ReadTimeoutError`、`ERR_SOCKET_TIMEOUT`、`CERTIFICATE_VERIFY_FAILED`、`submodule missing` |
| 2   | [找不到命令或工具](./02-missing-tools/README.md)       | 系统缺少编译器、构建工具、语言运行时、包管理器或相关模块                            | `command not found`、`module not found`、`Can't locate`                                    |
| 3   | [权限被拒绝](./03-permission-denied/README.md)         | HMDFS、只读文件系统、SELinux、代码签名或动态链接器 namespace 限制文件操作和程序加载 | `Read-only file system`、`Operation not permitted`、`ERR_DLOPEN_FAILED`、退出码 126        |
| 4   | [编译与构建报错](./04-build-errors.md)                 | autotools/CMake 配置或生成异常，以及链接阶段符号缺失                                | `undefined symbol: libintl_gettext`、`autoreconf: failed`                                  |
| 5   | [路径与运行环境](./05-path-and-runtime.md)             | 脚本解释器路径不存在，或 OHOS SDK 动态库路径未加入运行环境                          | `bad interpreter: /bin/bash`、`libxml2.so.16: cannot open`                                 |
| 6   | [选项差异导致的问题](./06-option-divergence/README.md) | musl、toybox 与 GNU/Linux 的编译选项、API、Shell 变量或命令行为存在差异             | `unsupported option`、`CLOCK_REALTIME undeclared`、`Unknown option`、非交互命令阻塞        |
