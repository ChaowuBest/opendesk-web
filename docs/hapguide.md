# OpenDesk 桌面版 + 鸿蒙 HAP 打包 全流程指南

> 从零开始，在一台任意 Windows 设备上完成 OpenDesk 桌面版开发环境搭建，并打包生成鸿蒙 `.hap` 安装包。
>
> 本指南面向**新手开发者**，每一步都配有详细说明和命令示例，照着做即可。

---

## 目录

- [总览：你需要做什么](#总览你需要做什么)
- [第一阶段：准备 Windows 开发环境](#第一阶段准备-windows-开发环境)
    - [1. 安装 Git](#1-安装-git)
    - [2. 安装 NVM-Windows](#2-安装-nvm-windows)
    - [3. 安装 Node.js](#3-安装-nodejs)
    - [4. 安装 Python 3](#4-安装-python-3)
    - [5. 配置 NPM 国内镜像源](#5-配置-npm-国内镜像源)
    - [6. 配置 Electron 国内镜像源](#6-配置-electron-国内镜像源)
- [第二阶段：安装 DevEco Studio（鸿蒙开发工具）](#第二阶段安装-deveco-studio鸿蒙开发工具)
    - [1. 下载并安装 DevEco Studio](#1-下载并安装-deveco-studio)
    - [2. 申请鸿蒙受限权限（关键步骤）](#2-申请鸿蒙受限权限关键步骤)
- [第三阶段：克隆并开发 OpenDesk 桌面版](#第三阶段克隆并开发-opendesk-桌面版)
    - [1. 克隆代码仓库](#1-克隆代码仓库)
    - [2. 安装依赖](#2-安装依赖)
    - [3. 运行开发模式](#3-运行开发模式)
- [第四阶段：克隆 OpenDesk-ohos 鸿蒙壳工程](#第四阶段克隆-opendesk-ohos-鸿蒙壳工程)
    - [1. 克隆代码仓库](#1-克隆代码仓库-1)
    - [2. 了解项目结构](#2-了解项目结构)
- [第五阶段：一键构建鸿蒙 HAP 包](#第五阶段一键构建鸿蒙-hap-包)
    - [基于本地 OpenDesk 目录构建](#基于本地-opendesk-目录构建)
    - [查看构建产物](#查看构建产物)
- [第六阶段：在鸿蒙设备上安装测试](#第六阶段在鸿蒙设备上安装测试)
    - [1. 通过 DevEco Studio 直接推送安装](#1-通过-deveco-studio-直接推送安装推荐)
    - [2. 通过小白调试助手安装](#2-通过小白调试助手安装)
    - [3. 通过 HDC 命令行手动安装](#3-通过-hdc-命令行手动安装操作复杂不推荐)
- [常见问题排查](#常见问题排查)
- [常用命令速查表](#常用命令速查表)

---

## 总览：你需要做什么

整个过程分为 **6 个阶段**：

| 阶段     | 内容                                          | 预计耗时                |
| -------- | --------------------------------------------- | ----------------------- |
| 第一阶段 | 安装 Git、Node.js、Python 等基础工具          | ~15 分钟                |
| 第二阶段 | 安装 DevEco Studio + HarmonyOS SDK + 配置权限 | ~30 分钟                |
| 第三阶段 | 克隆 OpenDesk 代码，跑通桌面版开发            | ~10 分钟                |
| 第四阶段 | 克隆 OpenDesk-ohos 鸿蒙壳工程                 | ~2 分钟                 |
| 第五阶段 | 一键构建鸿蒙 HAP 包                           | ~10-20 分钟（首次较慢） |
| 第六阶段 | 在鸿蒙设备/模拟器上安装测试                   | ~5 分钟                 |

### 两个仓库的关系

```
OpenDesk (桌面版源码)          OpenDesk-ohos (鸿蒙壳工程)
├── src/                       └── ohos_hap/
├── package.json                   ├── electron/     ← 鸿蒙端 Electron 适配
└── node_modules/                  ├── web_engine/   ← Web 渲染引擎层
                                   └── build_hap.py  ← 一键构建脚本

      关系: OpenDesk-ohos 在构建时，会把 OpenDesk 的代码嵌入到
            web_engine/src/main/resources/resfile/resources/app/ 目录中
```

**核心理解**：OpenDesk-ohos 是一个"壳"，它本身不包含 OpenDesk 的业务代码。构建时，它会把 OpenDesk 的代码拉进来，做裁剪（删掉不需要的模块），然后打包成鸿蒙 HAP。

---

## 第一阶段：准备 Windows 开发环境

### 1. 安装 Git

1. 打开浏览器，访问 [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. 点击 **"Click here to download"** 下载 64 位安装程序
3. 双击下载好的 `.exe` 文件，安装时 **保持所有默认选项**，一路 Next 即可
4. 安装完成后，打开 **CMD（命令提示符）** 或 **PowerShell**，输入以下命令验证：

```cmd
git --version
```

输出类似 `git version 2.45.0.windows.1` 即表示安装成功。

### 2. 安装 NVM-Windows

> **为什么需要 NVM？** NVM（Node Version Manager）让你可以在一台机器上管理多个 Node.js 版本，避免版本冲突。

1. 打开浏览器，访问 [https://github.com/coreybutler/nvm-windows/releases](https://github.com/coreybutler/nvm-windows/releases)
2. 找到最新版本的 **`nvm-setup.exe`**（例如 `nvm-setup-1.1.12.exe`），下载
3. 双击安装，保持默认选项即可
4. 安装完成后，**关闭已有的 CMD/PowerShell 窗口**，重新打开一个新的（否则环境变量不会生效）
5. 验证安装：

```cmd
nvm version
```

输出类似 `1.1.12` 即表示成功。

### 3. 安装 Node.js

在命令行中执行以下命令安装NodeJS，通常安装最新版即可：

```cmd
nvm install latest
nvm use latest
node -v
npm -v
```

- `nvm install latest`：下载并安装最新版本的 Node.js
- `nvm use latest`：切换到刚安装的版本
- `node -v`：应输出类似 `v22.x.x`
- `npm -v`：应输出类似 `10.x.x`

> **注意**：如果 `nvm install` 速度很慢，可以尝试指定一个国内镜像源：
>
> ```cmd
> nvm node_mirror https://npmmirror.com/mirrors/node/
> nvm npm_mirror https://npmmirror.com/mirrors/npm/
> nvm install latest
> ```

### 4. 安装 Python 3

鸿蒙构建工具链依赖 Python。

1. 打开浏览器，访问 [https://www.python.org/downloads/](https://www.python.org/downloads/)
2. 点击下载最新的 Python 3.x 版本（建议 **3.9 或更高**）
3. 运行安装程序，**务必勾选底部的 "Add Python to PATH"** 选项（这是最容易遗漏的一步！）
4. 安装完成后，打开新的 CMD 窗口验证：

```cmd
python --version
```

输出类似 `Python 3.12.x` 即表示成功。

### 5. 配置 NPM 国内镜像源

由于默认的 NPM 仓库在海外，下载速度可能很慢。执行以下命令切换到国内镜像：

```cmd
npm config set registry https://registry.npmmirror.com
npm config get registry
```

输出 `https://registry.npmmirror.com` 即表示设置成功。

### 6. 配置 Electron 国内镜像源

Electron 在安装时还会额外下载自己的二进制文件，也需要配置镜像源。

**方式一：通过环境变量（推荐）**

在 CMD 中执行：

```cmd
setx ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
```

在 PowerShell 中执行：

```powershell
[Environment]::SetEnvironmentVariable("ELECTRON_MIRROR", "https://npmmirror.com/mirrors/electron/", "User")
```

设置完成后，**关闭并重新打开**命令行窗口使环境变量生效。

---

## 第二阶段：安装 DevEco Studio（鸿蒙开发工具）

### 1. 下载并安装 DevEco Studio

1. 打开浏览器，访问华为开发者联盟官网 [https://developer.huawei.com/consumer/cn/deveco-studio/](https://developer.huawei.com/consumer/cn/deveco-studio/)
2. 点击 **下载** 按钮，获取 Windows 版本的 DevEco Studio 安装包
3. 下载完成后，双击安装包进行安装
4. **建议安装到默认路径** `D:\DevEco Studio`（如果 D 盘空间不够也可以选 C 盘，但记住你的安装路径）
5. 安装过程中会提示安装 SDK 和相关工具，按默认选项继续即可

### 2. 申请鸿蒙受限权限（关键步骤）

OpenDesk 在鸿蒙平台上运行需要两个受限权限：

| 权限                                   | 用途                                              |
| -------------------------------------- | ------------------------------------------------- |
| `ohos.permission.READ_WRITE_USER_FILE` | 访问家目录下的配置文件（bash、nodejs 等工具依赖） |
| `ohos.permission.CUSTOM_SANDBOX`       | 允许 nodejs 使用 io_uring 等高性能系统调用        |

1. 找到 DevEco Studio 的 SDK 安装目录，可以在 DevEco Studio 中打开 **File → Settings → SDK Manager** 查看 SDK 路径

2. 找到文件 `UnsgnedReleasedProfileTemplate.json`（注意文件名里有个拼写错误 `Unsgned`，这是华为官方文件名）, 正常情况下它应该在 `<sdk目录>/default/openharmony/toolchains/lib/UnsgnedReleasedProfileTemplate.json`中.

3. 用文本编辑器（如 VS Code 或 Notepad++）打开这个文件

4. 找到 `"apl"` 字段，修改为：

    ```json
    "apl": "system_basic"
    ```

5. 找到或添加 `"acls"` 字段，修改为：

    ```json
    "acls": {
        "allowed-acls": [
            "ohos.permission.READ_WRITE_USER_FILE",
            "ohos.permission.CUSTOM_SANDBOX"
        ]
    }
    ```

6. 保存文件

7. 回到 DevEco Studio，重新生成签名信息（在 **File → Project Structure → Signing Configs** 中）

---

## 第三阶段：克隆并开发 OpenDesk 代码仓库

### 1. 克隆代码仓库

打开 CMD 或 PowerShell，进入你希望存放代码的目录（例如 `D:\Projects`），然后执行：

```cmd
git clone https://gitcode.com/openharmony-robot/OpenDesk/
cd OpenDesk
```

### 2. 安装依赖

在 OpenDesk 目录下执行：

```cmd
npm install --verbose
```

这一步会：

- 下载并安装 `package.json` 中声明的所有依赖
- 自动安装 Electron 二进制文件（如果之前的镜像源配置正确，速度会比较快）
- 使用 `--verbose` 来持续查看安装步骤，如果卡住的话会比较容易发现

首次安装可能需要几分钟到十几分钟，取决于网络速度。

### 3. 以开发模式运行 OpenDesk 桌面版

依赖安装完成后，启动开发模式：

```cmd
npm run start
```

这将启动 Electron 应用的开发模式，会自动弹出一个窗口，显示 OpenDesk 的界面。开发模式下修改代码会自动热重载。

---

## 第四阶段：克隆 OpenDesk-ohos 鸿蒙壳工程

### 1. 克隆代码仓库

下载 Opendesk-ohos 仓库:

```cmd
git clone https://gitcode.com/openharmony-robot/OpenDesk-ohos
cd OpenDesk-ohos
```

### 2. 了解项目结构

```
OpenDesk-ohos/
└── ohos_hap/
    ├── electron/          ← 鸿蒙端 Electron 主模块（ArkTS 编写）
    ├── web_engine/        ← Web 渲染引擎与适配层
    │   └── src/main/resources/resfile/resources/
    │       └── app/       ← OpenDesk 业务代码将嵌入到这里
    ├── patches/           ← 对 OpenDesk 代码的鸿蒙适配补丁
    ├── build_hap.py       ← 一键构建脚本
    └── build-profile.json5← 签名和构建配置
```

> **重要**：仓库中 `app/` 目录默认是空的（或不存在），因为 OpenDesk 的代码需要通过构建流程嵌入。

---

## 第五阶段：一键构建鸿蒙 HAP 包

构建前，确保你已完成：

- [x] 第一阶段：基础工具（Git、Node.js、Python）
- [x] 第二阶段：DevEco Studio + SDK + 权限配置
- [x] 第三阶段：OpenDesk 代码已克隆并能正常构建
- [x] 第四阶段：OpenDesk-ohos 代码已克隆

### 基于本地 OpenDesk 目录构建

这是**最简单**的方式，直接用你本地的 OpenDesk 代码构建 HAP，不需要额外的 Git 操作。

进入 PowerShell 或 CMD 运行下面的命令（注意：**不要使用DevEco Studio内置的终端**，因为它会注入环境变量，导致node/npm只能找到 Deveco Studio自带较老的 v18 版本，无法识别我们刚刚的安装)：

> 我们也支持使用 git bash。但如果用 git bash 的话，请注意把路径按照 git bash 的规范进行调整，例如原本来路径是 `D:\Projects\Opendesk`, 在 git bash 下则应当使用 `/d/Projects/Opendesk`。

```powershell
cd OpenDesk-ohos\ohos_hap

python build_hap.py \
    --devec-root "<Deveco Studio安装路径>" \
    --use-opendesk-root "<Opendesk代码路径>"
```

这个命令会自动完成以下步骤：

1. 将 OpenDesk 的代码复制到 `web_engine/src/main/resources/resfile/resources/app/`
2. 清理不必要的构建产物目录（`dist/`、`benchmarks/`、`native/`）
3. 自动应用鸿蒙适配补丁（`patches/` 目录下的 `.patch` 文件）
4. 安装 app 依赖（`npm install`）
5. 编译 OpenDesk（`npm run build`）
6. 裁剪不需要的依赖（`npm prune --omit=dev`）
7. 精简 `node_modules`（删除 x86 平台模块、源码文件等）
8. 安装鸿蒙依赖（`ohpm install --all`）
9. 执行 hvigor 构建，生成 `.hap` 文件

第一次构建时，会遇到代码签名问题。即可以构建出未签名版本的hap包，但是最后的签名步骤失败。
这是正常的，你需要参考 [配置调试签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing) 中的步骤，打开 Deveco Studio配置好调试签名，下次执行脚本就可以正常构建了。

### 查看构建产物

构建成功后，HAP 文件默认生成在：

```
cd OpenDesk-ohos\ohos_hap\electron\build\default\outputs\default\
ls electron-default-signed.hap
```

文件名可能因签名配置而略有不同。

> **首次构建较慢是正常的**，因为需要下载和安装大量 npm/ohpm 依赖。后续构建会利用缓存，速度会明显提升。

---

## 第六阶段：在鸿蒙设备上安装测试

### 1. 通过 DevEco Studio 直接推送安装（推荐）

1. 用 DevEco Studio 打开 `OpenDesk-ohos/ohos_hap/` 目录
    - 打开 DevEco Studio → **Open** → 选择 `ohos_hap` 文件夹
2. 等待项目加载和索引完成
3. 连接鸿蒙设备（USB 连接），或在 DevEco Studio 中启动 **模拟器**
    - 模拟器：点击工具栏上的设备选择器 → **Create Virtual Device** → 选择一个设备模板
4. 确保签名配置正确（**File → Project Structure → Signing Configs**）
5. 点击右上角的 **运行按钮（绿色三角）**
6. DevEco Studio 会自动完成构建、签名、推送到设备并启动应用

### 2. 通过小白调试助手安装

auto-installer(小白调试助手) 是一个三方开发的鸿蒙hap包安装工具，也支持登录华为开发者账号后自动签名。你可以在 [这里](https://github.com/likuai2010/auto-installer/)下载该工具，在windows和mac上均可以用它来安装hap包。

### 3. 通过 HDC 命令行手动安装（操作复杂，不推荐）

`hdc` 是鸿蒙的设备调试工具（类似 Android 的 adb），DevEco Studio 安装后自带。

1. 找到 hdc 工具的路径，通常在 SDK 目录下：

    ```
    C:\Users\<你的用户名>\AppData\Local\Huawei\Sdk\default\openharmony\toolchains\hdc.exe
    ```

2. 连接设备后，验证连接：

    ```cmd
    "C:\Users\<你的用户名>\AppData\Local\Huawei\Sdk\default\openharmony\toolchains\hdc.exe" list targets
    ```

3. 安装 HAP 文件：

    ```cmd
    "C:\Users\<你的用户名>\AppData\Local\Huawei\Sdk\default\openharmony\toolchains\hdc.exe" file send "D:\Projects\OpenDesk-ohos\ohos_hap\electron\build\default\outputs\default\electron-default-signed.hap" /data/local/tmp/
    ```

4. 在设备上通过包管理命令安装：
    ```cmd
    "C:\Users\<你的用户名>\AppData\Local\Huawei\Sdk\default\openharmony\toolchains\hdc.exe" shell bm install -p /data/local/tmp/electron-default-signed.hap
    ```

<p align="center">
  <i>按照以上步骤，你应该能够顺利搭建 OpenDesk 桌面版开发环境，并打包生成鸿蒙 HAP 文件。</i>
</p>
