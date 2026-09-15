# 📍 桶5: 路径与运行环境

程序编译成功了但跑不起来，或脚本/解释器找不到正确路径

---

## /bin/bash 不存在

```
bad interpreter: /bin/bash: no such file or directory
configure 失败 (exit 127)
```

OpenDesk 内置了 `bash` 命令，位于 `/data/app/bin`，可直接在命令行运行。若脚本 shebang 指向 `/bin/bash`，按以下方式修改：

```bash
sed -i '1s|#!/bin/bash|#!/bin/env bash|' configure
# 或直接写绝对路径
sed -i '1s|#!/bin/bash|#!/data/app/bin/bash|' configure
```

---

## LD_LIBRARY_PATH 未含 OHOS SDK 路径

```
error while loading shared libraries: libxml2.so.16
cannot open shared object file: libxml2.so.16
lld: error:.*libxml2
```

OHOS SDK 的 lib 目录未自动加入 `LD_LIBRARY_PATH`，需手动指定：

```bash
export OHOS_SDK_HOME=/data/service/hnp/ohos-sdk.org/<已安装的-SDK-目录>
export LD_LIBRARY_PATH="$OHOS_SDK_HOME/ohos/native/llvm/lib:$LD_LIBRARY_PATH"
```

> `/data/service/hap/bin` 是用户在 AppGallery 中手动下载 DevBox 后安装的路径，包含编译、构建及 HarmonyOS 专属工具等可执行文件。

---

[⬆ 返回顶部](./README.md)
