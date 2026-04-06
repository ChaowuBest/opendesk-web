<p align="center">
  <img src="./resources/renderer/images/banner.png" alt="Fillip Desk" style="max-width: 100%; height: 70px; object-fit: cover;" />
</p>

<p align="center">
  <b>一站式 AI 办公生活空间</b>
  <br />
  <i>用智能重新定义生产力，让工作更高效、生活更便捷</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/平台-Windows%20%7C%20macOS%20%7C%20OpenHarmony-blue?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Intelli%20OS-子项目-orange?style=for-the-badge" alt="Subproject">
  <img src="https://img.shields.io/badge/版本-0.2.0-green?style=for-the-badge" alt="Version">
</p>

<p align="center">
  <a href="./README.md">中文</a> | <a href="./README_EN.md">English</a>
</p>

---

## 📖 项目简介

**Fillip Desk（弹指神通）** 是 **Intelli OS（智能世界操作系统）** 的战略子项目，是一个基于 Electron 构建的跨平台 AI 办公套件。它集成了多个智能应用模块，通过 AI 技术提升日常工作和生活的效率。

Fillip Desk 采用模块化的应用架构，每个功能模块都是独立的应用程序，可以灵活扩展和组合。无论是邮件管理、新闻阅读、活动录制，还是 AI 对话，都能在一个统一的界面中无缝切换使用。

---

## ✨ 核心功能

### 🤖 AI 智能体中心（A2A）

- 多智能体对话系统，支持创建和管理多个对话会话
- 集成 OpenAI API，支持流式响应
- 智能体可调用工具集，实现复杂任务自动化
- 支持对话历史管理和上下文保持

### 📧 智能邮箱

- 支持 POP3 邮件协议（IMAP、SMTP、Exchange 开发中）
- 邮件列表展示和内容查看
- 邮件标记已读功能
- 邮件内容接入 AI 助手，支持智能分析和处理
- 邮件附件可接入 AI 文件系统

### 📰 新闻快讯

- 实时新闻聚合和展示
- 支持 Hacker News 等新闻源
- 快速浏览和阅读体验

### 🎥 快速记录（Recall）

- 屏幕活动录制和回放
- 活动历史管理
- 窗口选择和多窗口支持
- 缩略图预览功能

### 📁 文件管理

- 智能文件浏览和管理
- 文件快速搜索

### 📅 日历管理

- 日程安排和事件管理
- 与邮件系统集成

### 🔍 统一搜索

- AI 驱动的智能搜索
- 跨应用内容搜索

### 🧠 AI 文件系统服务

- 基于向量数据库的智能文件索引
- 支持语义搜索和相似度匹配
- 文件标题和内容嵌入
- 支持多种文件格式（PDF、Office 文档等，开发中）

### 📋 任务管理系统

- 多任务并行处理
- 任务状态实时同步
- 任务工具集动态绑定
- 支持文件附件和上下文管理

### 🎯 意图解析服务

- 自然语言意图理解
- 快速启动应用和功能

---

## 🚀 快速开始

详细的安装、配置和构建说明请参考 [开发指南](./docs/devguide.md)。

---

## 🎯 核心特性

### 模块化应用架构

- 每个功能模块都是独立的应用程序
- 通过应用注册机制统一管理
- 支持应用间通信和资源共享
- 易于扩展和维护

### IPC 通信机制

- 安全的进程间通信
- 通过 `preload.js` 暴露 API
- 支持订阅/发布模式
- 流式数据传输支持

### 系统集成

- 系统托盘支持
- 全局快捷键（Alt+Space / Option+Space）
- 通知系统
- 单实例运行

### 开发友好

- 轻量级前端框架，易于 AI 辅助开发
- 清晰的代码结构
- 完善的日志系统
- 开发工具集成

---

## 📝 开发指南

详细的开发文档、项目结构说明和开发流程请参考 [开发指南](./docs/devguide.md)。

---

## 🔮 未来规划

### 近期计划

- [ ] 完善邮件功能（IMAP、SMTP、Exchange 支持）
- [ ] AI 文件系统内容分块嵌入
- [ ] 聊天界面功能增强（图片支持、费用统计）
- [ ] 邮件搜索和高级管理功能

### 长期目标

- [ ] DeepResearch 智能体
- [ ] AI 统一搜索
- [ ] 会议录制和自动摘要
- [ ] AI 备忘录
- [ ] AI PPT 生成
- [ ] 更多 AI 原生应用

---

## 📄 许可证

本项目采用 [BSD-3-Clause](./LICENSE) 许可证。

---

## 👥 贡献

欢迎贡献代码、报告问题或提出建议！请参考开发指南了解如何参与项目开发。

---

## 🔗 相关链接

- [中文版本](./README.md) | [English Version](./README_EN.md)
- [Intelli OS 项目](https://github.com/intelli-os)（如适用）
- [开发指南](./docs/devguide.md)
- [OpenHarmony 版本说明](./docs/FillipDesk-oh.md)

---

<p align="center">
  <i>让 AI 成为你的得力助手，让工作更智能、更高效</i>
</p>
