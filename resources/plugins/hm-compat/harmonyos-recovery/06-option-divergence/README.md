# 🔧 桶6: 选项差异导致的问题

HarmonyOS 采用 musl libc、toybox 和 clang 工具链，与标准 Linux（glibc + GNU coreutils + gcc）存在底层实现差异。同样的代码或命令在标准 Linux 上正常运行，在 HarmonyOS 上可能因编译选项不支持、POSIX API 缺失、头文件冲突或命令行为不同而报错，产生如 `unsupported option`、`Unknown option` 等错误。

---

## 子分类

| 子分类       | 内容                                                 | 文件                                     |
| ------------ | ---------------------------------------------------- | ---------------------------------------- |
| 编译选项差异 | 编译和构建的选项差异，如不支持 32 位、POSIX API 缺失 | [compile-option.md](./compile-option.md) |
| 命令选项差异 | install/grep/locale/read 等命令行为不同              | [command-option.md](./command-option.md) |

---

[⬆ 返回顶部](../README.md)
