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
 * 基于 picomatch 的权限引擎实现。
 *
 * 外部模块不应直接引用本文件——请通过 permission.ts 中的 PermissionEnforcer 接口交互。
 *
 * 三态权限策略（通过三组独立的规则列表实现）：
 * - denyRules: 匹配到即 deny
 * - askRules: 匹配到即 ask（显式保护规则，覆盖 allow）
 * - allowRules: 匹配到即 allow
 * - 三者都不匹配则为隐式 ask（默认行为）
 *
 * 规则优先级：deny > ask(显式保护) > allow > ask(隐式回退)
 *
 * 使用 picomatch 进行 glob 匹配，配置 dot: true 以正确匹配 dotfiles。
 * 在 Windows 上启用 nocase: true 以处理盘符大小写差异。
 */

import picomatch from 'picomatch';
import path from 'path';
import type { PermissionEnforcer, PermissionRequest, PermissionCheckResult, PermissionRule } from './permission.js';
import { logger } from '../../utils/logger.js';
import {
    createSensitivePathRules,
    createDeviceNodeRules,
    createInterpretersPermissionRules
} from '../../utils/permissionRules.js';
import { createAppPolicyRules } from './policies/index.js';
import { fromMsysPath, normalizePath } from '../../../utils/path.js';
import { getAllTempDirs } from '../../utils/temp.js';

interface CompiledRule {
    resourceType: string;
    action: string;
    pathPattern: string;
    matcher: (path: string) => boolean;
}

const IS_WINDOWS = process.platform === 'win32';

const PICO_OPTIONS: picomatch.PicomatchOptions = {
    dot: true,
    // Windows 文件系统不区分大小写，需要 nocase 处理盘符 C: vs c: 等差异
    nocase: IS_WINDOWS
};

function compileRule(rule: PermissionRule): CompiledRule {
    const patternNorm = normalizePath(rule.pathPattern);
    return {
        resourceType: rule.resourceType,
        action: rule.action,
        pathPattern: patternNorm,
        matcher: picomatch(patternNorm, PICO_OPTIONS)
    };
}

function matchesRule(compiled: CompiledRule, resourceType: string, objNorm: string, action: string): boolean {
    const typeMatch = compiled.resourceType === '*' || compiled.resourceType === resourceType;
    const actionMatch = compiled.action === '*' || compiled.action === action;
    return typeMatch && actionMatch && compiled.matcher(objNorm);
}

/**
 * 检查一组规则中是否有任何一条匹配给定的请求。
 * 对于以 '/' 结尾的目录路径，同时检查去掉尾部 '/' 的路径和子路径匹配（dir/**），
 * 使得 'workspace/**' 规则可以正确匹配对 workspace 子目录的权限请求。
 */
function matchesAny(rules: CompiledRule[], resourceType: string, objNorm: string, action: string): boolean {
    for (const rule of rules) {
        if (matchesRule(rule, resourceType, objNorm, action)) return true;
    }
    // 对于目录路径（以 / 结尾），还要检查去掉尾 / 的形式
    if (objNorm.endsWith('/')) {
        const withoutTrailing = objNorm.slice(0, -1);
        for (const rule of rules) {
            if (matchesRule(rule, resourceType, withoutTrailing, action)) return true;
        }
    }
    return false;
}

/**
 * 可读目录注册表（单例）。
 *
 * 应用层（如 skillmgr）在初始化时将自身管理的目录注册进来，
 * HarnessContext 创建权限引擎后会自动追加这些目录的 file:read allow 规则，
 * 从而在所有模式（包括 Plan Mode 等只读模式）下保持对这些目录的读取权限。
 *
 * 这一设计使 aikernel 不需要引用任何 application 模块。
 */
export class ReadableDirectoryRegistry {
    private static instance: ReadableDirectoryRegistry | null = null;
    private directories: Set<string> = new Set();
    private _registerListeners: Array<(dirPath: string) => void> = [];

    static getInstance(): ReadableDirectoryRegistry {
        if (!ReadableDirectoryRegistry.instance) {
            ReadableDirectoryRegistry.instance = new ReadableDirectoryRegistry();
        }
        return ReadableDirectoryRegistry.instance;
    }

    /**
     * 注册目录变更监听器。返回取消监听的函数。
     * 当新目录通过 register() 注册时，监听器会被调用。
     */
    onRegister(listener: (dirPath: string) => void): () => void {
        this._registerListeners.push(listener);
        return () => {
            const idx = this._registerListeners.indexOf(listener);
            if (idx >= 0) this._registerListeners.splice(idx, 1);
        };
    }

    /**
     * 注册一个可读目录（自动规范化为正斜杠路径）
     */
    register(dirPath: string): void {
        const norm = normalizePath(path.resolve(dirPath));
        this.directories.add(norm);
        logger.info(`readable directory registered: ${norm}`);
        for (const listener of this._registerListeners) {
            try {
                listener(norm);
            } catch {
                // 监听器异常不应中断 register 流程
            }
        }
    }

    /**
     * 取消注册一个可读目录
     */
    unregister(dirPath: string): void {
        const norm = normalizePath(path.resolve(dirPath));
        this.directories.delete(norm);
        logger.info(`readable directory unregistered: ${norm}`);
    }

    /**
     * 返回所有已注册目录的 file:read allow 权限规则
     */
    getReadRules(): PermissionRule[] {
        const rules: PermissionRule[] = [];
        for (const dir of this.directories) {
            rules.push({ resourceType: 'file', action: 'read', pathPattern: `${dir}{,/**}`, effect: 'allow' });
        }
        return rules;
    }

    /**
     * 返回已注册目录列表（用于调试）
     */
    getRegisteredDirectories(): string[] {
        return Array.from(this.directories);
    }
}

/**
 * 无条件放行权限执行器。
 *
 * Unlimited mode 的语义是完全跳过权限判定，因此不能用普通 allow glob 规则模拟：
 * 普通引擎中的显式 ask/deny 优先级更高，后续叠加规则时仍可能重新触发权限弹窗。
 */
export class AllowEverythingPermissionEnforcer implements PermissionEnforcer {
    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        return { effect: 'allow', request };
    }

    async checkAll(_requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        return null;
    }

    async checkAllDetailed(_requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        return [];
    }

    async addRule(_rule: PermissionRule): Promise<void> {}

    async removeRule(_rule: PermissionRule): Promise<void> {}

    getRules(): PermissionRule[] {
        return [{ resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' }];
    }
}

export class GlobPermissionEnforcer implements PermissionEnforcer {
    private rawRules: PermissionRule[] = [];
    private allowRules: CompiledRule[] = [];
    private denyRules: CompiledRule[] = [];
    private askRules: CompiledRule[] = [];
    private readonly inherited?: GlobPermissionEnforcer;

    private constructor(inherited?: GlobPermissionEnforcer) {
        this.inherited = inherited;
    }

    static async create(initialRules: PermissionRule[] = []): Promise<GlobPermissionEnforcer> {
        return GlobPermissionEnforcer.createSync(initialRules);
    }

    /**
     * 同步创建权限执行器。
     * picomatch 规则编译本身是同步操作；延迟任务初始化需要在 getTask() 返回前完成。
     */
    static createSync(initialRules: PermissionRule[] = []): GlobPermissionEnforcer {
        const instance = new GlobPermissionEnforcer();
        instance.initialize(initialRules);
        return instance;
    }

    /**
     * 创建继承当前基础规则的轻量任务级执行器。
     * inherited 中的已编译规则由多个任务共享，initialRules 和后续 addRule() 仅属于新实例。
     */
    createOverlay(initialRules: PermissionRule[] = []): GlobPermissionEnforcer {
        const instance = new GlobPermissionEnforcer(this);
        instance.initialize(initialRules);
        return instance;
    }

    inheritsFrom(enforcer: GlobPermissionEnforcer): boolean {
        return this.inherited === enforcer || this.inherited?.inheritsFrom(enforcer) === true;
    }

    private initialize(initialRules: PermissionRule[]): void {
        this.rawRules.push(...initialRules);
        for (const rule of initialRules) {
            const compiled = compileRule(rule);
            if (rule.effect === 'allow') {
                this.allowRules.push(compiled);
            } else if (rule.effect === 'deny') {
                this.denyRules.push(compiled);
            } else {
                this.askRules.push(compiled);
            }
        }
    }

    private matchesRules(
        ruleType: 'allowRules' | 'denyRules' | 'askRules',
        resourceType: string,
        objNorm: string,
        action: string
    ): boolean {
        return (
            matchesAny(this[ruleType], resourceType, objNorm, action) ||
            this.inherited?.matchesRules(ruleType, resourceType, objNorm, action) === true
        );
    }

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        const objNorm = normalizePath(request.resourcePath);

        // 空路径不是合法资源路径，直接 allow（避免 picomatch ** 不匹配空字符串导致隐式 ask）
        if (!objNorm) {
            return { effect: 'allow', request };
        }

        // 文件执行权限对所有 OpenDesk 模式开放。读写仍继续经过各模式
        // 的 deny/ask/allow 规则；执行请求不应触发额外授权弹窗。
        if (request.resourceType === 'file' && request.action === 'execute') {
            return { effect: 'allow', request };
        }

        // deny 优先
        if (this.matchesRules('denyRules', request.resourceType, objNorm, request.action)) {
            return {
                effect: 'deny',
                reason: `权限被拒绝: ${request.action} ${request.resourcePath}`,
                request
            };
        }

        // 显式 ask（保护规则）优先于 allow
        if (this.matchesRules('askRules', request.resourceType, objNorm, request.action)) {
            return {
                effect: 'ask',
                reason: `敏感路径需要用户确认: ${request.action} ${request.resourcePath}`,
                request
            };
        }

        // 然后检查 allow
        if (this.matchesRules('allowRules', request.resourceType, objNorm, request.action)) {
            return {
                effect: 'allow',
                request
            };
        }

        // 都不匹配则为隐式 ask
        return {
            effect: 'ask',
            reason: `需要用户确认: ${request.action} ${request.resourcePath}`,
            request
        };
    }

    async checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') {
                return result;
            }
        }
        return null;
    }

    /**
     * 批量检查权限请求，返回所有非 allow 的结果列表。
     * 全部 allow 时返回空数组。
     */
    async checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        const results: PermissionCheckResult[] = [];
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') {
                results.push(result);
            }
        }
        return results;
    }

    async addRule(rule: PermissionRule): Promise<void> {
        this.rawRules.push(rule);
        const compiled = compileRule(rule);

        if (rule.effect === 'allow') {
            this.allowRules.push(compiled);
        } else if (rule.effect === 'deny') {
            this.denyRules.push(compiled);
        } else {
            this.askRules.push(compiled);
        }

        logger.debug(
            `permission rule added: ${rule.effect} ${rule.resourceType}:${rule.action} ${compiled.pathPattern}`
        );
    }

    async removeRule(rule: PermissionRule): Promise<void> {
        const patternNorm = normalizePath(rule.pathPattern);

        const removeFrom = (list: CompiledRule[]): CompiledRule[] =>
            list.filter(
                (r) =>
                    !(r.resourceType === rule.resourceType && r.action === rule.action && r.pathPattern === patternNorm)
            );

        if (rule.effect === 'allow') {
            this.allowRules = removeFrom(this.allowRules);
        } else if (rule.effect === 'deny') {
            this.denyRules = removeFrom(this.denyRules);
        } else {
            this.askRules = removeFrom(this.askRules);
        }

        this.rawRules = this.rawRules.filter(
            (candidate) =>
                !(
                    candidate.resourceType === rule.resourceType &&
                    candidate.action === rule.action &&
                    candidate.pathPattern === rule.pathPattern &&
                    candidate.effect === rule.effect
                )
        );

        logger.info(`permission rule removed: ${rule.effect} ${rule.resourceType}:${rule.action} ${patternNorm}`);
    }

    getRules(): PermissionRule[] {
        return [...(this.inherited?.getRules() ?? []), ...this.rawRules];
    }
}

/**
 * 为指定的工作空间创建默认权限规则。
 *
 * 默认策略：
 * - 工作空间内的文件读写执行 → allow（包括 dotfiles，如 .gitignore、.eslintrc 等）
 * - 工作空间内的敏感路径（.ssh、.gnupg 等） → ask（显式保护，覆盖 allow）
 * - 工作空间外的文件读写执行 → ask（隐式回退）
 * - OpenDesk 自带 interpreters 目录（pip-global、npm-global 等包安装位置） → allow
 * - 网络访问 → allow
 * - 技能和插件读取 → allow
 * - 技能和插件的修改或执行 → ask（隐式回退，需用户确认）
 */
export function createDefaultPermissionRules(workspace: string, appPolicyHomeDir?: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(fromMsysPath(workspace)));

    // 使用 brace expansion 同时匹配工作空间根目录和子路径：{,/**} = 根目录自身 + 所有子路径
    const wsPattern = `${workspaceNorm}{,/**}`;

    // 所有临时目录（os.tmpdir() + 系统级 /tmp 等）始终允许读写执行
    const tempRules: PermissionRule[] = [];
    for (const dir of getAllTempDirs()) {
        const pattern = `${normalizePath(dir)}{,/**}`;
        tempRules.push(
            { resourceType: 'file', action: 'read', pathPattern: pattern, effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: pattern, effect: 'allow' },
            { resourceType: 'file', action: 'execute', pathPattern: pattern, effect: 'allow' }
        );
    }

    return [
        // 设备节点始终允许（/dev/stdin, /dev/null 等）
        ...createDeviceNodeRules(),
        // 工作空间内读写执行允许（dot: true 确保 .gitignore 等 dotfiles 也被匹配）
        { resourceType: 'file', action: 'read', pathPattern: wsPattern, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: wsPattern, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: wsPattern, effect: 'allow' },
        // 临时目录读写执行允许
        ...tempRules,
        // OpenDesk 自带 interpreters 目录（pip-global、npm-global 等）读写允许，
        // 沙箱内安装包不应反复触发授权
        ...createInterpretersPermissionRules(),
        // 网络访问放通：readImage/readFile 等工具把 http(s) URL 视为普通数据源，
        // 逐 URL 弹确认打扰过重（与 Solo 模式语义对齐）。
        // 显式 deny 规则仍优先于本规则，任务/插件运行时可按需收紧。
        { resourceType: 'network', action: 'access', pathPattern: '**', effect: 'allow' },
        // 所有技能读取允许（加载、查看等），写入/执行需用户确认（隐式 ask）
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        // 插件列表和详情读取允许，安装、卸载、启停和重载需用户确认（隐式 ask）
        { resourceType: 'plugin', action: 'read', pathPattern: '**', effect: 'allow' },
        // 常用 CLI 工具的 app 专属策略（git/python/node/uv 的运行时读放行与
        // 凭据 ask 保护；经引擎 check 与沙箱导出两端生效）。appPolicyHomeDir
        // 供测试注入固定家目录，保证沙箱导出断言不依赖宿主 os.homedir() 形态
        ...createAppPolicyRules(appPolicyHomeDir),
        // 敏感路径保护规则（即使在工作空间内也需要用户确认）
        ...createSensitivePathRules(workspace)
    ];
}
