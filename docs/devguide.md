# OpenDesk 开发说明

本文档介绍了如何快速上手开发OpenDesk。

大多数情况下，着手开发OpenDesk是一个易于上手并且能够快速看到成果的工作 ;) 然而，对于面向鸿蒙设备的，以及在Windows Arm环境下的开发者，你需要额外阅读下面的教程：

- [鸿蒙化适配说明](./platforms/openharmony.md)
- [Windows Arm上开发所需要的额外配置](./platforms/win32-arm64.md)

## 1. 配置开发环境

### 1.1 安装NVM, NodeJS和Electron

#### 安装NVM (_Node Version Manager_)

- MacOS和Linux环境在这里下载并安装最新版本的[nvm](https://github.com/nvm-sh/nvm)
- Windows环境建议使用[nvm-windows](https://github.com/coreybutler/nvm-windows)

#### 配置国内镜像源

首先需要配置国内的NPM镜像源

```shell
npm config set registry https://registry.npmmirror.com
npm config get registry
# 看到 https://registry.npmmirror.com 则修改成功
```

由于Electron安装过程中还会单独下载Electron自己的二进制文件，所以需要额外配置镜像。
根据你使用的Shell环境不同，你需要自己选择正确的环境变量配置方式，以`bash`为例，需要在
`$HOME/.bashrc`中添加:

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

如果是Windows CMD/PowerShell环境则需要对应地修改Windows环境变量。

#### 安装

首先安装最新版本的NodeJS。你可以按照下面的命令始终安装最新版本（建议），也可以安装某个固定的版本。

> 注：Windows Arm用户请参考[Windows Arm上开发所需要的额外配置](./platforms/win32-arm64.md)这里
> 进行安装，否则可能导致运行速度非常慢（很容易安装成x86版本，windows也可以通过转译层运行）

```shell
nvm install latest
nvm use latest
node -v
# v22.15.1
```

本项目使用了 [node-gyp](https://github.com/nodejs/node-gyp#on-windows)，因此对于 Windows 用户，请确保安装了以下基础环境：

1. [Python](https://www.python.org/downloads/)：推荐 3.9 以上的版本
2. [Microsoft Visual Studio](https://visualstudio.microsoft.com/downloads/)：社区版即可，需要勾选 “使用 C++ 的桌面开发”（Desktop development with C++）

接下来进入OpenDesk的代码仓库，执行下面的命令自动安装包括 Electron 在内的所有依赖。

```shell
npm install
```

## 2. 安装包构建

当前OpenDesk通过Electron Forge支持Windows和MacOS平台上的安装包构建。

### MacOS (dmg)

首先你需要有一台MacOS设备作为打包环境。在这台设备上将开发环境配置完成之后，直接运行下面的命令：

```shell
npm run package
npm run make
```

即可在`out/make/`中生成对应的dmg格式安装包。

### Windows (MSI)

在Windows下，我们通过`maker-wix`来构建.msi格式的安装包。

#### 配置依赖项

1. 下载并安装[Wix3 Toolset](https://github.com/wixtoolset/wix3/releases/tag/wix3141rtm)
2. 将Wix的bin目录(我这里是`C:\Program Files (x86)\WiX Toolset v3.14\bin`配置到环境变量`PATH`中, 如果你修改了安装路径，那么按你自己的情况配置)

#### 构建安装包

在bash或cmd中运行下面的命令即可。

```shell
npm run package
npm run make
```

构建好的安装包会保存在`out/make/wix`中。

## 3. 代码结构介绍

OpenDesk 采用经典的 Electron 应用架构支持跨平台开发。为了保持开发过程的简洁清晰，并没有使用诸如`React`, `Vue`一类的前端框架，暂时也没有使用JS的打包工具。仅仅引入[Tailwind CSS](https://tailwindcss.com/)支撑前端的样式设计，以及[Alpine.js](https://alpinejs.dev/)来实现少量动态行为。同时这两个轻量级的框架均对大模型辅助开发非常亲和，在Gemini 3, Claude等模型中可以很容易一键直出生成可用的UI实现。

### 3.1. 整体架构

项目的主入口为[src/main/main.js](../src/main/main.js), 在这里我们创建Electron应用的主窗口，并建立窗口前端网页与后端服务的IPC通信管道。

1. **主进程（Main Process）** - `src/main/`
    - 应用入口和核心逻辑
    - 窗口管理、系统集成
    - 服务管理和应用注册
    - IPC 通信处理

2. **渲染进程（Renderer Process）** - `src/renderer/`
    - 用户界面展示
    - OpenDesk主程序的前端组件和交互逻辑（各个内嵌应用的逻辑分布在应用系统中）
    - 通过 IPC 与主进程通信

3. **应用系统（Applications）** - `src/main/applications/`
    - 可扩展的应用模块
    - 每个应用可提供服务、工具和 GUI 界面
    - 通过应用注册机制统一管理

4. **服务系统（Services）** - `src/main/services/`
    - 后台服务，运行在独立的工作线程中
    - 提供文件系统、意图解析等系统级功能

### 3.2. 前端界面

前端界面位于 `src/renderer/` 目录，采用原生 Web 技术构建。

#### 主要文件结构

```
src/renderer/
├── index.html              # 主窗口 HTML
├── application.html        # 应用窗口 HTML
├── floatpage.html          # 浮动窗口 HTML
├── preload.js              # 预加载脚本，暴露 IPC API
├── components/             # Web Components
│   ├── homepage.js         # 首页组件
│   ├── sidebar.js          # 侧边栏组件
│   ├── taskview.js         # 任务视图组件
│   ├── agentinput.js       # AI 输入组件
│   ├── setting.js          # 设置组件
│   └── ...
└── styles/                 # 样式文件
    ├── custom.css
    ├── tailwind.css
    └── ...
```

#### 前端特性

1. **Web Components 架构**
    - 使用自定义元素（Custom Elements）构建组件
    - 组件间通过事件和属性通信

2. **IPC 通信**
    - 通过 `preload.js` 暴露安全的 API
    - 主要 API 包括：
        - `taskManagerAPI`: 任务管理相关操作
        - `fsAPI`: 文件系统操作
        - `settingAPI`: 设置管理
        - `notificationAPI`: 通知系统
        - `applicationAPI`: 应用间通信

3. **实时更新机制**
    - 通过 IPC 订阅任务更新
    - 支持流式渲染 AI 响应内容

4. **样式系统**
    - 使用 Tailwind CSS 进行样式管理
    - 支持 Markdown 渲染（代码高亮、数学公式等）

### 3.3. 后端逻辑

### 3.4. 本地 Agent Skills（Anthropic 行业标准）

主进程对话会自动发现并挂载**本地端侧归档的 Agent Skills**，与内建应用工具集一起参与工具调用。格式对齐 **Anthropic 发布的 Agent Skills 行业标准**（[agentskills.io](https://agentskills.io/specification)）。

- **技能目录**：应用数据目录下的 `skills/`（如 Windows `%APPDATA%/OpenDesk/skills/`）。
- **单技能结构**：每个技能一个子目录，**目录名必须与 SKILL.md 中的 name 一致**；目录内必含 **SKILL.md**（YAML frontmatter + Markdown 正文），可选子目录 `scripts/`、`references/`、`assets/`。
- **SKILL.md 格式**：YAML 必填字段 `name`（1–64 字符，小写字母/数字/连字符，不可首尾或连续连字符）、`description`（1–1024 字符）；可选 `license`、`compatibility`（≤500 字符）、`metadata`、`allowed-tools`（实验性）。正文为 Markdown，供模型按需加载。
- **调用方式**：每个技能在主进程中暴露为一个 tool（name = 技能 name，description = 技能 description）。默认执行时返回 SKILL.md 正文；若在 frontmatter 中配置 OpenDesk 扩展 `OpenDesk.handler`（script/module/url），则执行对应脚本/模块并返回结果。
- **示例**：见 `src/main/applications/skills/resources/example/`（含 SKILL.md 与可选 handler.js），复制到应用数据目录 `skills/` 后即可被主进程检测并调用。
- **前端 API**：`window.skillRegistryAPI.list()`、`skillRegistryAPI.refresh()`、`skillRegistryAPI.getSkillsDirectory()`。

## 4. 后续开发规划

#### 版本节奏

- 在有新功能的前提下每天更新nightly版本
- 有部分新增完整功能的时候更新小版本(Minor version), e.g. 从`0.2.0`, `0.2.1`
- 在合适的时机(Who Knows?)推出大版本

#### 当前计划支持的功能

- 基础功能
    - [ ] 聊天界面
        - [ ] 支持tokens统计和费用统计
        - [ ] 支持发送图片
        - [ ] 支持接收图片模型收到的图片
- 系统服务
    - [ ] AI文件系统
        - [ ] 显示文件系统索引状态
        - [ ] 优化标题嵌入搜索效果
        - [ ] 文件内容分块嵌入和查找
            - [ ] ppt/doc格式处理
            - [ ] pdf格式处理
            - ...
    - [ ] AI工作空间
    - [ ] 生成式通知
    - [ ] 系统设置
        - [x] 设置刷新后自动重启对应服务
        - [ ] 设置接入AI，更加傻瓜化
- 独立智能体
    - [x] 基础对话
    - [ ] DeepResearch
- AI原生应用
    - [ ] AI 统一搜索
    - [ ] AI 收件箱
        - [ ] 基础邮件功能
            - [ ] 远端邮件协议
                - [x] pop3
                - [ ] imap
                - [ ] smtp
                - [ ] exchange
            - [ ] 邮件管理和操作
                - [x] 标记已读
                - [ ] 邮件回复
                - [ ] 邮件删除
                - [ ] 邮件列表显示
                    > 注：当前虽然已经支持了邮件列表，但是对于过多邮件的场景，我们是做了截断的，如果用户有几万封邮件，当前无法一次性显示，而且到底如何显示才具有更好的可用性也需要思考。
        - [ ] 邮件接入全局AI助手
            - [ ] 前端工具集
                - [x] 获取邮件列表
                - [x] 获取当前邮件内容
                - [x] 获取指定uid邮件内容
                - [ ] 邮件搜索
                - [ ] 邮件已读情况管理
            - [ ] 邮件与其他应用打通的体验设计
                - [ ] 邮件附件接入AI文件系统
            - [ ] 收到邮件时的智能化操作
        - [ ] 邮件接入统一搜索
    - [ ] AI 活动记录
        - [ ] 会议录制
        - [ ] 会议文本生成和摘要
        - [ ] 会议报告(PPT)输出？
    - [ ] AI 备忘录
    - [ ] AI 日历管理
    - [ ] AI PPT生成

## 5. 开发必读资料

### Electron前端开发相关

- Electron-Vite相关
    - [Vite资源处理](https://cn.electron-vite.org/guide/assets) 这部分详细讲述了如何在Electron Vite的打包框架之下应该如何引入静态资源

## 6. 本地依赖联调

当 OpenDesk 依赖的 npm 包需要在本地修改和调试时（如 `@kenhkl/agent-moss`、`@kenhkl/agent-gate`），
可以使用 [npm link](https://docs.npmjs.com/cli/v10/commands/npm-link) 将本地仓库链接到 `node_modules`，
使修改即时生效，无需反复发布和更新 npm 包。

### 6.1 前置条件

确保本地仓库已 clone 到同一父目录下，并且各仓库已完成至少一次 build：

```
/home/you/projects/
├── OpenDesk/           # 主项目
├── AgentMoss/          # @kenhkl/agent-moss 源码
│   └── ts/
│       └── dist/       # build 产物
└── AgentGate/          # @kenhkl/agent-gate 源码
    └── ts/
        └── dist/       # build 产物
```

### 6.2 链接本地仓库

**第一步**：在被依赖仓库中注册全局 link：

```bash
cd /path/to/AgentMoss/ts
npm link

cd /path/to/AgentGate/ts
npm link
```

**第二步**：在 OpenDesk 中将全局 link 关联到 `node_modules`：

```bash
cd /path/to/OpenDesk
npm link @kenhkl/agent-moss @kenhkl/agent-gate
```

> **注意**：如果需要链接多个包，请在一条命令中同时指定，不要分开执行。
> 分开执行 `npm link` 可能因为共享子依赖的 hoisting 导致前一个 link 被覆盖。
> 如果遇到 link 被覆盖的情况，先删除再一次性链接：
>
> ```bash
> rm -rf node_modules/@kenhkl/agent-moss node_modules/@kenhkl/agent-gate
> npm link @kenhkl/agent-moss @kenhkl/agent-gate
> ```

执行后 `node_modules/@kenhkl/agent-moss` 和 `node_modules/@kenhkl/agent-gate` 会变为符号链接，指向本地对应仓库。

### 6.3 启动与验证

正常启动 OpenDesk 即可，会自动加载本地仓库的代码：

```bash
npx electron-vite dev
```

修改 AgentMoss 或 AgentGate 的代码后，需在对应仓库重新 build，然后重启 OpenDesk：

```bash
# 在 AgentMoss 仓库中修改代码并 build
cd /path/to/AgentMoss/ts
npm run build

# 回到 OpenDesk 重启
cd /path/to/OpenDesk
npx electron-vite dev
```

### 6.4 恢复为 npm 包版本

联调完成后，恢复到 npm 发布的正式版本：

```bash
cd /path/to/OpenDesk
npm unlink @kenhkl/agent-moss @kenhkl/agent-gate
npm install
```

### 6.5 常见问题

**link 之后 npm install 会覆盖 link 吗？**
会。执行 `npm install` 会重新安装所有依赖，覆盖已有的 link。联调期间避免执行 `npm install`。

**如何确认当前是否处于 link 状态？**

```bash
ls -la node_modules/@kenhkl/agent-moss
# 如果是符号链接 (->)，说明处于 link 状态
```

**改了代码后不生效？**
npm link 链接的是仓库目录，但 OpenDesk 读取的是 `dist/cli.js` 产物，源码修改后必须在对应仓库重新 build。

**这个方式只适用于 AgentMoss 和 AgentGate 吗？**
不是。任何 `package.json` 中声明的 npm 依赖都可以用同样的方式 link，只需本地有对应源码仓库且 build 产物路径一致即可。
