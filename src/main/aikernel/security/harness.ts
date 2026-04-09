/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * HarnessContext —— 除了聊天信息 (chatContext) 之外，由外部工程框架提供给 agent 的
 * 信息与约束的集合。
 *
 * 设计原则：
 * - harnessContext 不会被落盘（不参与 toJSON / 导入导出），因为其中的 environ 等字段
 *   可能包含用户的敏感数据（如 API key）
 * - 每次任务启动时由宿主环境（TUI / Electron）构建并注入
 */

import type { PermissionEnforcer, PermissionPromptProvider } from './permission.js';
import { GlobPermissionEnforcer, AllowEverythingEnforcer, createDefaultPermissionRules } from './enforcer.js';

export class HarnessContext {
    /**
     * 环境变量上下文：skill 的 .env 会合并到此处，终端类工具执行时注入到子进程
     * 按优先级合并：系统 env < skill .env（后加载的覆盖先加载的）
     */
    environ: Record<string, string> = {};

    /**
     * 权限引擎实例，用于检查工具调用的权限
     */
    permission: PermissionEnforcer | null = null;

    /**
     * 权限确认 UI 提供者（TUI / Electron 各自实现）
     * 当权限检查结果为 'ask' 时通过此接口向用户请求确认
     */
    permissionPrompt: PermissionPromptProvider | null = null;

    /**
     * 当前任务的工作空间路径
     */
    workspace?: string;

    /**
     * 创建带有默认权限的 HarnessContext
     * @param workspace 当前工作空间路径
     */
    static async createWithDefaults(workspace: string): Promise<HarnessContext> {
        const ctx = new HarnessContext();
        ctx.workspace = workspace;

        const rules = createDefaultPermissionRules(workspace);
        ctx.permission = await GlobPermissionEnforcer.create(rules);

        return ctx;
    }

    /**
     * 创建全放通模式的 HarnessContext（--allow-everything），所有权限检查自动通过。
     */
    static createAllowEverything(workspace: string): HarnessContext {
        const ctx = new HarnessContext();
        ctx.workspace = workspace;
        ctx.permission = new AllowEverythingEnforcer();
        return ctx;
    }

    /**
     * 创建不带权限引擎的空 HarnessContext（用于向后兼容或测试）
     */
    static createEmpty(): HarnessContext {
        return new HarnessContext();
    }
}
