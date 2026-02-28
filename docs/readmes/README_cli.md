<p align="center">
  <img src="../images/cli-logo.png" alt="Fillip Desk" style="max-width: 100%; height: 70px; object-fit: cover;" />
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

## 主要功能

- **完善的Agent机能**：支持自由接入第三方模型，MCP Server, 以及A2A Agent(开发中)。通过复合索引构造的面向Agent的文件系统让你轻松管理各种本地文件，支持Bash, Zsh, Powershell等多种终端的命令执行，自带的规划能力帮你轻松完成复杂任务；
- **友好的配置方式**：只有第一次使用的默认模型需要自己配置，后续的搜索引擎，邮箱，待办事项的配置；MCP，Skills的搜索和下载……一切都在自由的对话中完成，远离繁琐的配置界面和JSON文件；
- **人机协同的设计理念**：我们不仅希望设计一个应用，而是由一组 **适合用户和Agent共同使用的** 应用集合；传统的应用过于复杂而难以与Agent有效融合，而完全基于对话流在很多场景下效率有限；

## 常用场景

*tba*

## 使用指南

在[这里](https://gitcode.com/openharmony-robot/OpenDesk/blob/main/docs/cliguide.md)查看完整的Opendesk CLI使用手册。

## 如何贡献?

#### 发现并提出问题

如果你在使用Opendesk或Opendesk CLI的时候发现任何问题，请在[Issue](https://gitcode.com/openharmony-robot/OpenDesk/issues)界面提出。对我们的设计或者新特性如果有好的想法和建议，可以在[讨论区](https://gitcode.com/openharmony-robot/OpenDesk/discussions)进行反馈。

---

<p align="center">
  <i>让 Agent 解放你的双手, 享受生活，Let's Rock! </i>
</p>
