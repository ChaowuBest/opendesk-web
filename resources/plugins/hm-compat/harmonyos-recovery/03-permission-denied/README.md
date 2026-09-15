# 🔒 桶3: 权限被拒绝

由于鸿蒙PC的文件系统设计、SELinux权限限制、以及 Agent 的沙箱隔离，当命令行执行涉及读写文件、创建链接、执行脚本或程序时，可能被系统拒绝，产生如 `Permission denied`、`Read-only file system`、`Operation not permitted`等报错。

---

## 子分类

| 子分类       | 内容                                                         | 文件                                       |
| ------------ | ------------------------------------------------------------ | ------------------------------------------ |
| 文件操作受限 | /tmp 只读、软链接、硬链接、/proc 访问、git 所有权、venv 创建 | [filesystem-ops.md](./filesystem-ops.md)   |
| 执行权限受限 | 非权限位限制的脚本和二进制执行权限受限                       | [exec-permission.md](./exec-permission.md) |

---

[⬆ 返回顶部](../README.md)
