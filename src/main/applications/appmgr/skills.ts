/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

export const MANAGE_APPS_SKILL = `
---
name: manage-apps
description: 管理 OpenDesk 后装应用，包括安装、查询应用列表和查看应用版本信息
---

# OpenDesk App Management

本技能提供 OpenDesk 后装应用管理工具。

可用能力：
- 从本地 zip 文件安装应用
- 查看用户安装应用和系统内置应用
- 查看指定应用的版本树、当前版本和激活状态

后装应用使用受控 AppSDK 清单模型，zip 根目录必须包含 \`opendesk-app.json\`。
`;
