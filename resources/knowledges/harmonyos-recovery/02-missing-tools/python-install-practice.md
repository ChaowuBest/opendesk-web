# 实践：统一布局安装 Python（executeZsh 通道）

本节保留一次完整实践，用来展示 cmd-pkgs 渠道安装 python 的处理过程。python 通常已经由 hm-compat 插件引导自动安装（探测 `python3` 输出 `Python 3.12`）。本节为案例，不是所有工具都必须照搬的固定安装方案；通用原理参见[执行权限受限](../03-permission-denied/exec-permission.md)。

本实践的命令经 executeZsh 执行：该通继承 OpenDesk env 注入（`$CMD_PKGS_DIR/bin`），安装产物统一落 `cmd-pkgs/bin`。bash 通道安装案例另见[curl安装实践](./curl-install-practice.md)。

## 1. 安装

install.sh 以统一 prefix 模式安装（与 node 及 agent 手动安装的包共用 `$CMD_PKGS_DIR` 顶层 bin/lib）：

```bash
curl -fsSL https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs/releases/download/pkgs/install.sh \
  | sh -s -- python 3.12.9 "$CMD_PKGS_DIR"
```

注意带上第 3 参数 `"$CMD_PKGS_DIR"`：不传时默认装到 `$HOME/usr/local`，会污染外部环境。

由 cmd-pkgs 下载的tarball 为 flat 结构（bin/ lib/ 顶层，无 symlink 成员——`bin/python3` 为真实 ELF 副本），install.sh 将内容合并进 `$CMD_PKGS_DIR/bin` 等子目录下。

## 2. 验证

PATH 已前置 `$CMD_PKGS_DIR/bin`，agent 会话内直接 `python3 --version` 即可。

```bash
python3" --version
# Python 3.12.9
```

## 3. pip 自愈

cmd-pkgs python 包不引导 pip：site-packages 为空、bin/ 无 pip 入口，但 ensurepip 模块与 bundled wheel 随包分发。全程以 `python3 -m` 形式操作，不依赖 bin/pip 入口：

```bash
"$CMD_PKGS_DIR/bin/python3" -m ensurepip --upgrade
"$CMD_PKGS_DIR/bin/python3" -m pip --version
```

## 4. 镜像源与二进制分发约束

OpenDesk 子进程 env 已注入以下变量（手动复现场景需显式指定）：

```bash
PIP_INDEX_URL=https://pypi.repo.openharmony.cn/artifactory/openharmony-pypi/simple \
PIP_TRUSTED_HOST=pypi.repo.openharmony.cn \
PIP_ONLY_BINARY=:all: \
  python3 -m pip install <pkg>
```

- 鸿蒙上无编译工具链，tgz 源码包无法安装，`PIP_ONLY_BINARY=:all:` 仅允许 wheel 二进制分发；
- env var 优先级高于 pip.conf，不写用户主目录配置文件。

## 5. pip 全局包落点与多包共存

- pip 全局包默认经 env 注入落 `PIP_TARGET`，不要用 `--user` 或改写 pip.conf 落到用户主目录；
