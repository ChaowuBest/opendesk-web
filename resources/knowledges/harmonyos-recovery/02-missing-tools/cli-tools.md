# 命令行工具与三方库

在 OpenHarmony 上运行命令时，可能遇到：

```text
xxx: command not found
```

系统不默认包含所有常见 CLI，可按场景选择安装方式：

| 方式                               | 适用场景                       | 特点                                   |
| ---------------------------------- | ------------------------------ | -------------------------------------- |
| **cmd-pkgs**（社区预编译包）       | 快速安装单个命令行工具、系统库 | 轻量，一条命令安装一个包               |
| **Harmonybrew**（鸿蒙版 Homebrew） | 批量管理、搜索和更新软件包     | 完整包管理器，可用包以项目实时列表为准 |

[⬆ 返回桶2](./README.md)

---

## 方式一：cmd-pkgs（社区预编译包）

通过 OHPCD 社区的 [cmd-pkgs](https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs) 项目安装。可用软件和版本以仓库实时列表为准。

### 安装命令

```bash
wget -qO- https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs/releases/download/pkgs/install.sh | sh -s -- <包名> <版本>
```

完整包列表：https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs

### 常见安装失败处理

```text
wget: (22) The requested URL returned error: 404
install.sh: line N: <包名>: package not found
```

原因通常是网络不通或包名、版本号错误。先查看实时包列表：

```bash
wget -O- https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs/releases/download/pkgs/packages.txt
```

也可以从社区仓库直接下载预编译文件：

```bash
wget -O <工具名> <下载地址>
chmod +x <工具名>
```

### 原生动态包

部分 cmd-pkgs 包含 ELF 可执行文件和私有 `.so`，可检查动态依赖：

```bash
readelf -d "$(command -v <command>)" \
  | grep -E 'NEEDED|RPATH|RUNPATH'
```

出现 `Permission denied`、`Operation not permitted`、`Error loading shared library` 或 `Error relocating` 时，不属于“命令缺失”，请按[执行权限受限](../03-permission-denied/exec-permission.md)诊断。
不要只执行 `chmod +x` 或反复设置 `LD_LIBRARY_PATH`。

在 OpenDesk 中，原生包优先部署到应用数据目录：

```bash
PREFIX=/data/storage/el2/base/files/interpreters/<工具名>
mkdir -p "$PREFIX/bin" "$PREFIX/lib" "$PREFIX/lib/external"
```

不要直接从 `$HOME` 对应的 `/storage/Users/currentUser` HMDFS 路径运行原生 ELF。

### 实践：安装和运行带私有动态库的 curl

cmd-pkgs 的 curl 包含 `libcurl.so.4`、`libssl.so.3` 和 `libcrypto.so.3` 等私有依赖，已按以下方式验证成功：

```
1. 安装到 `/data/storage/el2/base/files/interpreters/curl-cmdpkg`；
2. 将可执行文件和各级 `.so` 的 RUNPATH 改为该目录下的绝对路径；
3. 对修改后的每个 ELF 使用 `SHA256withECDSA` 自签名；
4. 使用系统 CA `/etc/ssl/certs/cacert.pem`；
5. 验证 `curl --version`、HTTPS 下载、Bash 子进程和 Python `subprocess` 调用。
```

具体操作在[curl安装实践](./curl-install-practice.md)。

---

## 方式二：Harmonybrew（鸿蒙版 Homebrew）

```text
brew: command not found
```

[Harmonybrew](https://atomgit.com/Harmonybrew/docs/blob/main/zh-CN/user/install.md) 将 Homebrew 移植到 OpenHarmony。安装路径和可执行能力以 Harmonybrew 当前官方说明为准，不要将 cmd-pkgs 的手工迁移、改 RPATH 和重签名流程直接套用到其受管理目录。

### 安装

```bash
zsh -c "$(wget -O- https://harmonybrew.atomgit.com/install.sh)"
```

安装后按项目文档配置环境：

```bash
echo >> ~/.zshrc
echo 'eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"' >> ~/.zshrc
eval "$(/storage/Users/currentUser/.harmonybrew/bin/brew shellenv)"
```

### 常用命令

| 操作           | 命令                    |
| -------------- | ----------------------- |
| 更新包索引     | `brew update`           |
| 搜索软件包     | `brew search <关键词>`  |
| 安装软件包     | `brew install <包名>`   |
| 卸载软件包     | `brew uninstall <包名>` |
| 列出已安装包   | `brew list`             |
| 列出仓库所有包 | `brew formulae`         |

---

## 其他常见告警

### Perl 模块构建失败

```text
ExtUtils::MakeMaker.*error
PERL5LIB.*not found
Makefile.PL.*failed
```

原因通常是 Perl 或对应构建模块不存在，需要先安装 Perl。

### PostgreSQL PGXS 构建模式

```text
pg_config.*not found
pgxs.mk.*not found
```

PostgreSQL 扩展使用 PGXS，而非标准 configure。需先安装 PostgreSQL，并通过 `pg_config --pgxs` 定位构建系统。

---

[⬆ 返回桶2](./README.md)
