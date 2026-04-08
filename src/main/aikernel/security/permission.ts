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
 * 权限系统的公共类型定义与声明接口。
 *
 * 设计原则：
 * - 本文件只包含纯类型定义和接口，不依赖任何具体的权限引擎实现
 * - 所有需要权限检查的模块只需引用本文件即可，无需感知引擎实现细节
 */

/** 权限判定结果 */
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** 权限资源类别 */
export type PermissionResourceType = 'file' | 'network' | 'skill';

/** 权限操作类型 */
export type PermissionAction = 'read' | 'write' | 'execute' | 'access';

/**
 * 描述一条具体的权限声明——某个主体对某类资源的某个操作
 *
 * 示例：
 *   { resourceType: 'file', action: 'read', resourcePath: '/home/user/docs/readme.md' }
 *   { resourceType: 'file', action: 'write', resourcePath: '/home/user/project/src/index.ts' }
 *   { resourceType: 'network', action: 'access', resourcePath: 'https://api.example.com' }
 *   { resourceType: 'skill', action: 'read', resourcePath: 'my-skill-name' }
 *   { resourceType: 'skill', action: 'write', resourcePath: 'my-skill-name' }
 */
export interface PermissionRequest {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    /** 具体的资源路径（文件路径或 URL） */
    resourcePath: string;
}

/**
 * 权限检查结果
 */
export interface PermissionCheckResult {
    /** 判定结果 */
    effect: PermissionEffect;
    /** 可读的原因说明 */
    reason?: string;
    /** 原始的权限请求 */
    request: PermissionRequest;
}

/**
 * 一条权限规则定义（用于初始化和动态添加规则）
 *
 * pathPattern 支持 glob 风格匹配：
 *   - "/workspace/**" 匹配 workspace 下所有路径
 *   - "/tmp/*" 匹配 /tmp 下的直接子路径
 *   - "*" 匹配任意路径
 */
export interface PermissionRule {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    /** glob 风格的资源路径模式 */
    pathPattern: string;
    /** 该规则的判定结果 */
    effect: PermissionEffect;
}

/**
 * 权限引擎的抽象接口。
 * 具体实现（如 GlobPermissionEnforcer）需要实现此接口。
 */
export interface PermissionEnforcer {
    /**
     * 检查单条权限请求
     */
    check(request: PermissionRequest): Promise<PermissionCheckResult>;

    /**
     * 批量检查权限请求，返回第一条不是 allow 的结果，如果全部 allow 则返回 null
     */
    checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null>;

    /**
     * 批量检查权限请求，返回所有非 allow 的结果列表。
     * 全部 allow 时返回空数组。
     */
    checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]>;

    /**
     * 动态添加一条权限规则
     */
    addRule(rule: PermissionRule): Promise<void>;

    /**
     * 动态移除匹配的权限规则
     */
    removeRule(rule: PermissionRule): Promise<void>;
}

/**
 * 用户对权限 ask 请求做出的响应
 */
export interface PermissionUserResponse {
    /** 用户的选择 */
    decision: 'allow' | 'deny';
    /**
     * 记住范围：
     * - 'none': 仅本次允许
     * - 'exact': 该任务中始终允许这些具体路径
     * - 'type': 允许所有同类操作（如所有"写入技能"操作）
     */
    rememberScope: 'none' | 'exact' | 'type';
}

/**
 * 权限确认回调接口。
 * TUI 和 Electron 各自实现此接口来展示权限确认 UI。
 *
 * prompt 接收一组同类型的权限请求（已合并），向用户展示并获取响应。
 */
export interface PermissionPromptProvider {
    /**
     * 向用户展示权限确认请求（支持合并后的多个同类请求）
     * @param requests 被询问的权限请求列表（同一 resourceType + action）
     * @param toolName 触发此权限请求的工具名称
     * @returns 用户的响应
     */
    prompt(requests: PermissionRequest[], toolName: string): Promise<PermissionUserResponse>;
}
