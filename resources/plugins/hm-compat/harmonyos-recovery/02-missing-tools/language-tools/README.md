# 编译语言工具

HarmonyPC 社区已提供包括 Node.js、Python、Rust、Go、Java、Julia、FPC 等在内的编译语言运行时工具。

本 agent（OpenDesk）**内置了 `python3` 和 `node` 支持**（`python3`、`node`、`npm`、`npx` 均位于 `/data/app/bin`），可直接使用。Python 另提供了 `uv` 包管理器（同目录下），可替代 `pip` 用于更快的包安装和环境管理。其他语言工具需按以下指引安装。

| 运行时  | 获取方式               |
| ------- | ---------------------- |
| Node.js | 见下方及上游仓库       |
| Python  | 见下方及上游仓库       |
| Rust    | [Rust.md](./Rust.md)   |
| Go      | [Go.md](./Go.md)       |
| Java    | [Java.md](./Java.md)   |
| Julia   | [Julia.md](./Julia.md) |
| FPC     | [FPC.md](./FPC.md)     |
| C/C++   | [C-CPP.md](./C-CPP.md) |

---

## Node.js 运行时

- 源码仓库：[DevNode-OH](https://gitcode.com/OpenHarmonyPCDeveloper/DevNode-OH)

### 常见问题

| 场景                    | 说明                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| 安装 npm 包             | `npm install <模块名>`                                                                                     |
| 安装慢或失败            | 配置国内镜像源，详见 [01-download-and-network.md](../../01-download-and-network.md) 中的 npm registry 配置 |
| 查看已适配鸿蒙的 npm 包 | https://cnb.cool/OpenHarmonyPCDeveloper/npm                                                                |

---

## Python 运行时

- 主仓库：[ohos-python-release](https://gitcode.com/OpenHarmonyPCDeveloper/ohos-python-release)

可用 Python 版本及安装方式以主仓库说明为准。本 Agent 内置的 Python 可直接通过 `python3` 使用。

### 常见问题

| 场景                             | 说明                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `python`/`pip`/`pip3` 指令找不到 | 使用 `python3 -m pip install <包名>`                                                                         |
| 安装 C 扩展包                    | 查看 [Python_Package_For_HarmonyOS](https://gitcode.com/OpenHarmonyPCDeveloper/Python_Package_For_HarmonyOS) |
| 安装慢或失败                     | 配置鸿蒙镜像源，详见 [01-download-and-network.md](../../01-download-and-network.md) 中的 pipy 配置           |
| 查看已适配鸿蒙的 Python 包       | https://cnb.cool/OpenHarmonyPCDeveloper/pypi                                                                 |
| 扩展模块（`.so`）加载失败        | 编译的 `.so` 扩展模块必须签名后才能加载，详见 [执行权限受限](../../03-permission-denied/exec-permission.md)  |

---

[⬆ 返回桶2](../README.md)
