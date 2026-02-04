<p align="center">
  <img src="./resources/renderer/images/banner.png" alt="Fillip Desk" style="max-width: 100%; height: 70px; object-fit: cover;" />
</p>

<p align="center">
  <b>The All-in-One, Cross-Platform AI Office Suite</b>
  <br />
  <i>Empowering productivity with intelligence on every desktop environment.</i>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20OpenHarmony-blue?style=for-the-badge" alt="Platform">
  <img src="https://img.shields.io/badge/Intelli%20OS-Subproject-orange?style=for-the-badge" alt="Subproject">
  <img src="https://img.shields.io/badge/Version-0.1.4-green?style=for-the-badge" alt="Version">
</p>

<p align="center">
  <a href="./README.md">中文</a> | <a href="./README_EN.md">English</a>
</p>

---

## 📖 Introduction

**Fillip Desk** is a strategic subproject of **Intelli OS (Intelligent World OS)**. It is a cross-platform AI office suite built on Electron, integrating multiple intelligent application modules to enhance productivity in daily work and life through AI technology.

Fillip Desk adopts a modular application architecture where each functional module is an independent application that can be flexibly extended and combined. Whether it's email management, news reading, activity recording, or AI conversations, everything can be seamlessly switched within a unified interface.

---

## ✨ Key Features

### 🤖 AI Agent Center (A2A)
- Multi-agent conversation system supporting creation and management of multiple chat sessions
- Integrated OpenAI API with streaming response support
- Agents can call tool sets to automate complex tasks
- Conversation history management and context preservation

### 📧 Smart Mailbox
- POP3 email protocol support (IMAP, SMTP, Exchange in development)
- Email list display and content viewing
- Mark as read functionality
- Email content integrated with AI assistant for intelligent analysis and processing
- Email attachments can be integrated with AI file system

### 📰 News Feed
- Real-time news aggregation and display
- Support for news sources like Hacker News
- Fast browsing and reading experience

### 🎥 Quick Record (Recall)
- Screen activity recording and playback
- Activity history management
- Window selection and multi-window support
- Thumbnail preview functionality

### 📁 File Manager
- Intelligent file browsing and management
- Fast file search

### 📅 Calendar Management
- Schedule and event management
- Integration with email system

### 🔍 Unified Search
- AI-driven intelligent search
- Cross-application content search

### 🧠 AI File System Service
- Intelligent file indexing based on vector database
- Semantic search and similarity matching support
- File title and content embedding
- Support for multiple file formats (PDF, Office documents, etc., in development)

### 📋 Task Management System
- Multi-task parallel processing
- Real-time task status synchronization
- Dynamic tool set binding for tasks
- File attachment and context management support

### 🎯 Intent Parsing Service
- Natural language intent understanding
- Quick application and feature launch

---

## 🚀 Getting Started

For detailed installation, configuration, and build instructions, please refer to the [Development Guide](./docs/devguide.md).

---

## 🎯 Core Features

### Modular Application Architecture
- Each functional module is an independent application
- Unified management through application registry mechanism
- Support for inter-application communication and resource sharing
- Easy to extend and maintain

### IPC Communication Mechanism
- Secure inter-process communication
- API exposure through `preload.js`
- Support for subscribe/publish pattern
- Streaming data transmission support

### System Integration
- System tray support
- Global hotkeys (Alt+Space / Option+Space)
- Notification system
- Single instance running

### Developer Friendly
- Lightweight frontend framework, AI-assisted development friendly
- Clear code structure
- Comprehensive logging system
- Development tools integration

---

## 📝 Development Guide

For detailed development documentation, project structure, and development workflow, please refer to the [Development Guide](./docs/devguide.md).

---

## 🔮 Roadmap

### Short-term Plans
- [ ] Complete email functionality (IMAP, SMTP, Exchange support)
- [ ] AI file system content chunking and embedding
- [ ] Chat interface enhancements (image support, cost statistics)
- [ ] Email search and advanced management features

### Long-term Goals
- [ ] DeepResearch agent
- [ ] AI unified search
- [ ] Meeting recording and automatic summarization
- [ ] AI memo
- [ ] AI PPT generation
- [ ] More AI-native applications

---

## 📄 License

This project is licensed under the [BSD-3-Clause](./LICENSE) License.

---

## 👥 Contributing

Contributions are welcome! Whether it's code, bug reports, or suggestions, please refer to the development guide to learn how to participate in project development.

---

## 🔗 Related Links

- [中文版本](./README.md) | [English Version](./README_EN.md)
- [Intelli OS Project](https://github.com/intelli-os) (if applicable)
- [Development Guide](./docs/devguide.md)
- [OpenHarmony Version Notes](./docs/FillipDesk-oh.md)

---

<p align="center">
  <i>Let AI be your powerful assistant, making work smarter and more efficient</i>
</p>
