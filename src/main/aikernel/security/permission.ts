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

// ─── ResourcePath：统一的权限客体路径抽象 ────────────────────────

/**
 * 统一的权限客体路径抽象。
 *
 * 为文件、网络、技能等不同类型的资源提供统一的路径表示和前缀计算。
 * 核心能力：
 * - `getPrefixes()`: 返回从精确路径到最宽泛父级的逐层前缀列表，
 *   用于权限授权时让用户选择授权范围。
 * - `toGlobPattern()`: 将一个前缀转换为可匹配其下所有子路径的 glob 模式。
 */
export abstract class ResourcePath {
    /** 资源类别 */
    abstract readonly resourceType: PermissionResourceType;
    /** 规范化后的原始路径 */
    abstract readonly normalized: string;

    /**
     * 返回从最精确到最宽泛的前缀层级列表。
     * 每一层都是一个 { label, pattern } 对：
     * - label: 展示给用户看的可读路径
     * - pattern: 用于写入权限规则的 glob pathPattern
     *
     * 示例（文件路径 C:/Projects/OpenDesk/src/a.txt）：
     * [
     *   { label: 'C:/Projects/OpenDesk/src/a.txt', pattern: 'C:/Projects/OpenDesk/src/a.txt' },
     *   { label: 'C:/Projects/OpenDesk/src/',       pattern: 'C:/Projects/OpenDesk/src/**' },
     *   { label: 'C:/Projects/OpenDesk/',            pattern: 'C:/Projects/OpenDesk/**' },
     *   { label: 'C:/Projects/',                     pattern: 'C:/Projects/**' },
     * ]
     */
    abstract getPrefixes(): { label: string; pattern: string }[];

    /**
     * 将自身路径转换为 glob 模式，用于写入权限规则。
     * 对于精确路径直接返回自身，对于目录型（以 /** 结尾）返回 glob 模式。
     */
    abstract toGlobPattern(): string;
}

/**
 * 文件资源路径。前缀按父目录逐层展开。
 */
export class FileResourcePath extends ResourcePath {
    readonly resourceType = 'file' as const;
    readonly normalized: string;

    constructor(normalizedPath: string) {
        super();
        this.normalized = normalizedPath;
    }

    getPrefixes(): { label: string; pattern: string }[] {
        const prefixes: { label: string; pattern: string }[] = [];
        const p = this.normalized;

        // 如果路径自身是 glob 模式（如 searchPath/**），先提取 concrete 部分
        const concreteBase = p.includes('*') ? p.split('*')[0].replace(/\/+$/, '') : null;
        // 以 '/' 结尾的路径视为目录路径
        const isDirectory = !concreteBase && p.endsWith('/');

        if (isDirectory) {
            // 目录路径：第一项直接用 dir/** 作为 pattern
            const dirPath = p.replace(/\/+$/, '');
            prefixes.push({ label: dirPath + '/', pattern: dirPath + '/**' });
        } else if (!concreteBase) {
            // 精确文件路径：先加自身
            prefixes.push({ label: p, pattern: p });
        }

        // 从父目录开始逐层向上
        let dir = concreteBase || (isDirectory ? parentDir(p.replace(/\/+$/, '')) : parentDir(p));
        const seen = new Set<string>();
        while (dir && !seen.has(dir)) {
            seen.add(dir);
            prefixes.push({ label: dir + '/', pattern: dir + '/**' });
            const next = parentDir(dir);
            if (next === dir) break;
            dir = next;
        }

        return prefixes;
    }

    toGlobPattern(): string {
        return this.normalized;
    }
}

/**
 * 网络资源路径。前缀按 URL 层级展开。
 * 例如 https://api.example.com/v1/users → [精确URL, https://api.example.com/v1/**, https://api.example.com/**]
 */
export class NetworkResourcePath extends ResourcePath {
    readonly resourceType = 'network' as const;
    readonly normalized: string;

    constructor(normalizedUrl: string) {
        super();
        this.normalized = normalizedUrl;
    }

    getPrefixes(): { label: string; pattern: string }[] {
        const prefixes: { label: string; pattern: string }[] = [];
        prefixes.push({ label: this.normalized, pattern: this.normalized });

        try {
            const url = new URL(this.normalized);
            const origin = url.origin;
            const pathParts = url.pathname.split('/').filter(Boolean);

            for (let i = pathParts.length - 1; i >= 0; i--) {
                if (i > 0) {
                    const subPath = pathParts.slice(0, i).join('/');
                    prefixes.push({ label: origin + '/' + subPath + '/', pattern: origin + '/' + subPath + '/**' });
                } else {
                    prefixes.push({ label: origin + '/', pattern: origin + '/**' });
                }
            }
        } catch {
            // URL 解析失败，只返回精确路径
        }
        return prefixes;
    }

    toGlobPattern(): string {
        return this.normalized;
    }
}

/**
 * 技能资源路径。前缀为 bundleName/skillName → bundleName/**。
 */
export class SkillResourcePath extends ResourcePath {
    readonly resourceType = 'skill' as const;
    readonly normalized: string;

    constructor(normalizedPath: string) {
        super();
        this.normalized = normalizedPath;
    }

    getPrefixes(): { label: string; pattern: string }[] {
        const prefixes: { label: string; pattern: string }[] = [];
        prefixes.push({ label: this.normalized, pattern: this.normalized });

        const slashIdx = this.normalized.indexOf('/');
        if (slashIdx > 0) {
            const bundle = this.normalized.slice(0, slashIdx);
            prefixes.push({ label: bundle + '/', pattern: bundle + '/**' });
        }
        return prefixes;
    }

    toGlobPattern(): string {
        return this.normalized;
    }
}

/**
 * 工厂函数：根据资源类型创建对应的 ResourcePath 实例。
 */
export function createResourcePath(resourceType: PermissionResourceType, path: string): ResourcePath {
    switch (resourceType) {
        case 'file':
            return new FileResourcePath(path);
        case 'network':
            return new NetworkResourcePath(path);
        case 'skill':
            return new SkillResourcePath(path);
        default:
            return new FileResourcePath(path);
    }
}

function parentDir(p: string): string {
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash <= 0) return '';
    // Windows 盘符根目录：D:/foo → D: （下一轮 parentDir('D:') 返回 '' 终止递归）
    if (lastSlash === 2 && p[1] === ':') return p.slice(0, 2);
    return p.slice(0, lastSlash);
}

// ─── 权限请求与规则 ────────────────────────────────────────────

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

/** 权限拒绝原因 */
export type PermissionDenyReason = 'user_denied' | 'timeout' | 'no_prompt_provider';

/**
 * 用户对权限 ask 请求做出的响应
 */
export interface PermissionUserResponse {
    /** 用户的选择 */
    decision: 'allow' | 'deny';
    /**
     * 记住范围：
     * - 'none': 仅本次允许
     * - 'prefix': 始终允许选中的前缀范围（由 selectedPrefixPattern 指定具体 glob）
     * - 'type': 允许所有同类操作（如所有"写入技能"操作）
     */
    rememberScope: 'none' | 'prefix' | 'type';
    /**
     * 当 rememberScope='prefix' 时，用户选择的授权 glob pattern。
     * 由 PermissionPromptProvider 根据 ResourcePath.getPrefixes() 的选项设定。
     */
    selectedPrefixPattern?: string;
    /**
     * 当 decision='deny' 时，拒绝的原因。
     */
    denyReason?: PermissionDenyReason;
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
     * @param prefixOptions 所有请求路径的共同前缀选项（用于让用户选择授权范围）
     * @returns 用户的响应
     */
    prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[]
    ): Promise<PermissionUserResponse>;
}
