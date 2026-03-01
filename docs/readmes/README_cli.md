<p align="center">
  <img src="https://raw.gitcode.com/user-images/assets/9176732/f7dc5a26-2855-4435-9c3f-0d3440635ef9/cli-logo.png" alt="OpenDesk CLI" style="max-width: 100%; height: 60px; object-fit: cover;" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-OpenHarmony%20%7C%20Windows%20%7C%20MacOS%20%7C%20Linux-blue?flat" alt="Platform">
  <img src="https://img.shields.io/badge/License-MulanPSL 2.0-green?logo=github" alt="Version">
</p>

<p align="center">
  OpenDesk CLI: 中文 | <a href="./README_cli_en.md">English</a>
</p>

OpenDesk CLI是运行在终端之中的AI助手，它基于OpenDesk的基础框架开发，旨在为开发者提供面向办公和生产力场景的一站式AI服务。


## 安装

运行下面的命令安装最新版本的OpenDesk CLI：
```shell
$ npm install -g @bitclub.ai/opendesk-cli
$ opendesk
```

或者安装每日构建的最新版本：
```shell
$ npm install -g @bitclub.ai/opendesk-cli@nightly
$ opendesk
```

> [!TIP]
> Nightly版本能够持续获取到最新的功能，但由于未经充分测试，可能会存在稳定性问题，欢迎您在本仓库的Issue和讨论区与我们互动，我们会在工作时间尽快响应您的问题 ;)

## 设计哲学

让智能体帮我们工作，不仅仅是取代我们的工作。更重要的是，人和智能体要能够充分协同，互相取长补短，共同完成复杂的任务，OpenDesk正是想要提供这样的一个协作平台。

在OpenDesk Cli中，我们遵循下述的设计思考：

- **终端优先的使用体验** OpenDesk CLI总是将开发者的终端使用体验放在第一顺位；
    - 基于[@mariozechner/pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui)构建的差分渲染体系，可以确保在数十分钟的超长程Agent任务中仍然保持顺畅的流式输出且不会产生闪烁的光污染;
    - 所有内部集成工具均支持在Shell中进行卡片式渲染，确保能够呈现你关注的信息;
- **易用但完善的Agent基础能力** 集成业界主流的Agent相关技术，但仍保持最大程度的易用性
    - 标准的Agentic Loop与丰富的内置工具;
    - 面向Agent的文件系统, 让你轻松管理各种本地文件。支持基于关键字, 向量索引, BM25索引等多种方式的混合文件搜索;
    - 在不同平台上支持Bash, Zsh, Powershell等多种终端的命令执行；
    - 无需切换模式，面向复杂任务的自适应规划能力帮你轻松完成复杂任务；
- **丰富的生态集成** 兼容Agent, Tools, LLM的各种主流标准
    - 支持市面主流大模型服务商，Coding Plan等的快速配置, 用户亦可使用自定义的OpenAI兼容的LLM服务；
    - 支持常见搜索API如Exa, Brave, Tavily，等快速接入，同时还默认支持Bing, Duckduckgo, Arxiv等免费搜索渠道；
    - MCP Server自动下载，安装，集成，支持从MCP.so等网站自动搜索下载；
    - 从Skill0.io等在线平台或本地路径快速安装技能(Skills)
- **友好的配置方式**：*有个功能不知道怎么用？那就直接问我吧 ；）*
    - 只有第一次使用的默认模型需要自己配置，后续的搜索引擎，邮箱，待办事项的配置；MCP，Skills的搜索和下载……一切都在自由的对话中完成，远离繁琐的配置界面和JSON文件；

    ![MCP Server 安装](https://raw.gitcode.com/user-images/assets/9176732/6ca614e1-c593-4eb2-91a6-742feeddf3ab/opendesk_mcpinstall.gif)

- **7 * 24小时主动服务** OpenDesk Cli运行在服务器上时，可以通过丰富的触发器系统持续执行后台任务，在你休息的时候帮你完成工作；

    ![全局任务触发器](https://raw.gitcode.com/user-images/assets/9176732/890a07d6-a2ce-4052-bead-bdb0727a56a0/opendesk_crontab.gif)

- **人机协同的应用设计**：我们不仅希望设计一个应用，而是由一组 **适合用户和Agent共同使用的** 应用集合；传统的应用过于复杂而难以与Agent有效融合，而完全基于对话流在很多场景下效率有限；

## 常用场景

### 文件管理

### 任务自动化

## 使用指南

在[这里](https://gitcode.com/openharmony-robot/OpenDesk/blob/main/docs/cliguide.md)查看完整的Opendesk CLI使用手册。

## 如何贡献?

#### 发现并提出问题

如果你在使用Opendesk或Opendesk CLI的时候发现任何问题，请在[Issue](https://gitcode.com/openharmony-robot/OpenDesk/issues)界面提出。对我们的设计或者新特性如果有好的想法和建议，可以在[讨论区](https://gitcode.com/openharmony-robot/OpenDesk/discussions)进行反馈。

---

<p align="center">
  <i>让 Agent 解放你的双手, 享受生活，Let's Rock! </i>
</p>
