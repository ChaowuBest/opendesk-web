# 执行权限受限

一些脚本或 ELF 在 `chmod +x` 后仍然失败，通常不是传统权限位问题，而是文件系统、SELinux 标签、代码签名或动态库路径解析共同导致。

本 Agent（OpenDesk）内置的 bash、python3 和 node 已完成运行时适配。用户自行安装编译的可执行文件等如果碰到问题，可参考本页列出的条件逐一解决。

[⬆ 返回桶3](./README.md)

## 适用现象

```text
Permission denied
Operation not permitted
bad interpreter: Permission denied
退出码 126
ERR_DLOPEN_FAILED
Error loading shared library libxxx.so
Error relocating ...: symbol not found
```

如果错误是 `command not found`，请先查看[命令行工具与三方库](../02-missing-tools/cli-tools.md)。

## 1. 确认失败阶段

| 现象                                     | 常见阶段             | 优先检查                                  |
| ---------------------------------------- | -------------------- | ----------------------------------------- |
| 执行文件立即返回 126                     | `execve()`           | 文件系统、SELinux、可执行文件签名、解释器 |
| `dlopen(...): Permission denied`         | 运行时加载           | 目标 `.so` 签名、路径和标签               |
| `Error loading shared library`           | 启动或运行时搜索依赖 | `NEEDED`、RPATH/RUNPATH、依赖签名         |
| `Error relocating ...: symbol not found` | 重定位               | 前置依赖是否加载、ABI 和符号版本          |
| `bad interpreter`                        | 脚本启动             | shebang 路径及解释器是否可执行            |

## 2. 文件系统与 SELinux

不同路径可能位于不同文件系统，并具有不同 SELinux 类型。文件内容和权限位完全相同，也不保证执行结果相同。
若同一已签名 ELF 在私有目录可运行、在共享挂载点返回 `Operation not permitted`，问题主要在文件系统或 SELinux 策略，而不是动态链接器搜索路径。

供 OpenDesk 本地执行的原生工具和动态库应优先安装到 `/data/storage/el2/base/files` 下，不要安装到 `$HOME` 对应的 HMDFS 路径后直接执行，两个常见路径SELinux类型有很大差异。

| 路径                               | 常见 SELinux 类型 | ELF 执行/加载结果                                         |
| ---------------------------------- | ----------------- | --------------------------------------------------------- |
| `/storage/Users/currentUser/...`   | `hmdfs`           | 已签名 ELF 仍可能在执行阶段返回 `Operation not permitted` |
| `/data/storage/el2/base/files/...` | 应用数据文件类型  | 有效签名且依赖路径正确时，可以执行并加载 `.so`            |

## 3. ELF 代码签名

HarmonyOS 会校验可执行 ELF 和共享库的代码签名，包括：

- C/C++、Go、Rust 等编译的可执行文件
- 普通 `.so`
- Python 原生扩展
- Node `.node` addon

本地可使用 `binary-sign-tool` （注：是需要用户从ApppGallery下载DevNode后配置的工具，位于`/data/service/hnp/bin`） 自签名：

```bash
# 必须先完成 patchelf/objcopy 等所有 ELF 修改
llvm-objcopy --remove-section=.codesign input.elf unsigned.elf

binary-sign-tool sign \
  -selfSign 1 \
  -inFile unsigned.elf \
  -outFile signed.elf \
  -signAlg SHA256withECDSA

chmod 755 signed.elf
binary-sign-tool display-sign -inFile signed.elf
```

必须遵循以下顺序，签名前先完成所有会改变 ELF 内容的操作：

```
复制或编译 -> 修改 RPATH/NEEDED -> 删除旧签名 -> 重新签名 -> 不再修改文件
```

签名后执行 `patchelf`、`objcopy`、`strip`、追加数据或覆盖部分内容，都会使原签名失效。

`binary-sign-tool display-sign` 能显示签名元数据，但不能替代系统实际加载验证。最终应执行目标程序或最小 `dlopen()` 测试。

## 4. 动态依赖与搜索路径

检查目标及其依赖：

```bash
readelf -d <elf> | grep -E 'NEEDED|RPATH|RUNPATH|SONAME'
```

需要确认：

- 每个 `NEEDED` 都能解析到预期文件；
- 架构和 ABI 匹配；
- 依赖链中的每个 ELF 都具有有效签名；
- RPATH/RUNPATH 指向当前环境允许加载的位置；
- 修改后的文件已经重新签名。

依赖链中的每个 ELF 都必须在最终修改后重新签名。`LD_LIBRARY_PATH` 只能影响库搜索，不能修复无效签名、HMDFS 执行限制或 SELinux 拒绝。

> `$ORIGIN` 与绝对路径：`$ORIGIN` 是标准的相对部署机制，应优先保留可迁移布局。但不同 OpenHarmony/HarmonyOS 版本、加载阶段和安全配置可能存在兼容差异。如果相邻库存在但 `$ORIGIN` 未按预期工作，可用绝对路径做诊断对照：

## 6. 语言原生扩展

OpenDesk 内置的 python3 可以安装与执行如 numpy 这样包括扩展库的模块，因为扩展及其依赖具有有效签名，并位于可加载的应用数据目录。

对于覆盖外的场景，应采用如下流程：

1. 用 `readelf -d` 列出全部 `NEEDED`；
2. 确认主扩展和所有传递依赖都在 `/data/storage/el2/base/files` 等可加载路径；
3. 完成 RPATH、NEEDED 等修改；
4. 对每个 ELF 重新签名；
5. 分别执行实际 `import`、`ctypes.CDLL()` 或 Node addon 加载验证。

### 其他方案：静态链接

静态链接可以减少运行时动态库和路径问题，但不是通用解法：

```bash
./configure --enable-static --disable-shared
```

---

## 其他常见问题

### 1 `make install` 后二进制执行被拒

```
编译产物 make install 后 Permission denied
make check 中测试用例全部失败（误判为功能问题）
```

依次检查：安装路径是否为 HMDFS、ELF 是否在最终修改后签名、依赖是否都能找到。不要用批量执行未验证文件的方式替代诊断。

### 2 脚本文件无执行权限

```
./script.sh: Permission denied
make[2]: *** [Makefile:1234] Error 126
/bin/sh: bad interpreter: Permission denied
```

脚本失败还可能来自 shebang 解释器不可执行。优先显式调用已适配的解释器：

```bash
/data/app/bin/bash ./script.sh
```
