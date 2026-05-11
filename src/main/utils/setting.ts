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

import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { workerData, isMainThread } from 'worker_threads';
import type { BaseApplication } from '../applications/base.js';

const require = createRequire(import.meta.url);

function tryElectronUserDataPath(): string | undefined {
    try {
        const electron = require('electron') as typeof import('electron');
        const p = electron.app?.getPath?.('userData');
        return typeof p === 'string' && p.length > 0 ? p : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 解析可写的应用数据根目录（与主进程、Worker 通过 workerData 传入的路径一致）
 *
 * OpenHarmony 上 HOME / APPDATA 均不存在，优先使用 USER_DATA_PATH（由 main.js 在启动时
 * 通过 app.getPath('userData') 注入）。若该环境变量也未设置，则尝试 Electron API、
 * os.homedir()、os.tmpdir() 等作为回退。
 */
function resolveWritableUserDataRoot(): string {
    if (customAppDirectory) {
        return customAppDirectory;
    }
    if ((process.platform as string) === 'openharmony' && process.env.USER_DATA_PATH) {
        return process.env.USER_DATA_PATH;
    }
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'opendesk');
    }
    if (process.env.HOME) {
        return path.join(process.env.HOME, '.opendesk');
    }
    const fromElectron = tryElectronUserDataPath();
    if (fromElectron) {
        return fromElectron;
    }

    // OpenHarmony 回退：HOME/APPDATA 不存在时，尝试 os.homedir() 和 os.tmpdir()
    if ((process.platform as string) === 'openharmony') {
        try {
            const home = os.homedir();
            if (home && home !== '/' && fs.existsSync(home)) {
                return path.join(home, '.opendesk');
            }
        } catch {
            /* os.homedir() 可能在沙箱环境中不可用 */
        }
        return path.join(os.tmpdir(), '.opendesk');
    }

    return path.join(process.cwd(), '.opendesk');
}

const ProviderSchema = z.object({
    name: z.string().default('openrouter').describe('模型提供商名称'),
    base_url: z.string().default('https://openrouter.ai/api/v1').describe('模型提供商的 API 地址'),
    api_key: z.string().default('').describe('模型提供商的 API 密钥'),
    no_proxy: z.boolean().default(false).describe('是否禁用代理')
});

const ModelSchema = z.object({
    alias: z.string().default('model_alias').describe('模型别名(在本地配置中使用的名称)'),
    provider_name: z.string().default('openrouter').describe('模型提供商'),
    model_name: z.string().default('google/gemini-2.5-flash').describe('模型名称(在提供商一侧的名称)'),
    reasoning_effort: z
        .enum(['', 'none', 'low', 'medium', 'high'])
        .default('')
        .describe('模型默认推理模式(空字符串表示默认)'),
    context_length: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('模型上下文长度(token 数，0 或不填则由系统自动估算)')
});

/** 控制模型推理深度，空字符串表示使用模型默认值 */
type ReasoningEffort = '' | 'none' | 'low' | 'medium' | 'high';

const GUIConfigSchema = z.object({
    scale_factor: z.number().min(0.5).max(2.0).optional().default(1).describe('GUI 缩放系数 (0.5 ~ 2.0)'),
    ctrl_enter_send: z
        .boolean()
        .optional()
        .default(false)
        .describe('是否使用 Ctrl+Enter 发送消息（false 时按 Enter 发送）')
});

export const DEFAULT_SHORTCUTS = {
    switch_mode: 'ctrl+k',
    switch_model: 'f2',
    clear_input: 'ctrl+c',
    endline: 'ctrl+j',
    show_help: 'ctrl+h',
    list_tasks: 'ctrl+l'
} as const;

const ShortcutsSchema = z.object({
    switch_mode: z.string().default(DEFAULT_SHORTCUTS.switch_mode).describe('模式切换'),
    switch_model: z.string().default(DEFAULT_SHORTCUTS.switch_model).describe('模型切换'),
    endline: z.string().default(DEFAULT_SHORTCUTS.endline).describe('回车换行'),
    show_help: z.string().default(DEFAULT_SHORTCUTS.show_help).describe('打开帮助'),
    clear_input: z.string().default(DEFAULT_SHORTCUTS.clear_input).describe('删除输入内容'),
    list_tasks: z.string().default(DEFAULT_SHORTCUTS.list_tasks).describe('显示任务列表')
});

const TerminalCliSchema = z.object({
    shortcuts: ShortcutsSchema.default({
        switch_mode: DEFAULT_SHORTCUTS.switch_mode,
        switch_model: DEFAULT_SHORTCUTS.switch_model,
        endline: DEFAULT_SHORTCUTS.endline,
        show_help: DEFAULT_SHORTCUTS.show_help,
        clear_input: DEFAULT_SHORTCUTS.clear_input,
        list_tasks: DEFAULT_SHORTCUTS.list_tasks
    }).describe('快捷键配置')
});

type Provider = z.infer<typeof ProviderSchema>;
type Model = z.infer<typeof ModelSchema>;

/** 思考区显示模式；兼容旧配置 on/off */
const ReasonDisplaySchema = z.preprocess(
    (val: unknown) => {
        if (val === 'on') return 'full';
        if (val === 'off') return 'partial';
        return val;
    },
    z.enum(['full', 'partial']).default('partial')
);

let ApplicationConfigSchema: z.ZodObject<z.ZodRawShape> = z.object({});

function getSettingSchema(): z.ZodObject<z.ZodRawShape> {
    return z.object({
        locale: z
            .enum(['auto', 'zh-CN', 'en-US'])
            .default('auto')
            .describe('语言设置: auto=跟随系统, zh-CN=中文, en-US=英文'),
        default_model: z.string().describe('在对话等场景中使用的默认模型').default(''),
        default_intent_parsing_model: z.string().describe('在意图解析中使用的多模态模型').default(''),
        default_embedding_model: z.string().describe('知识库，检索使用的中使用的向量嵌入模型').default(''),
        default_reranker_model: z.string().describe('在检索结果重排序中使用的模型').default(''),
        default_vision_model: z.string().describe('在图片记忆提取中使用的多模态模型').default(''),
        default_workspace: z.string().describe('默认工作空间目录路径(为空时使用临时工作空间)').default(''),
        reason_display: ReasonDisplaySchema.describe(
            '思考内容显示模式: full=完整 Markdown, partial=仅显示末尾若干行(流式与结束后一致)'
        ).default('full'),
        providers: z.array(ProviderSchema).describe('可用AI模型提供商').default([]),
        models: z.array(ModelSchema).describe('可用AI模型').default([]),
        gui_config: GUIConfigSchema.describe('桌面 GUI 设置').default({ scale_factor: 1, ctrl_enter_send: false }),
        cli_config: TerminalCliSchema.describe('终端 CLI 设置').default({
            shortcuts: {
                switch_mode: DEFAULT_SHORTCUTS.switch_mode,
                switch_model: DEFAULT_SHORTCUTS.switch_model,
                endline: DEFAULT_SHORTCUTS.endline,
                show_help: DEFAULT_SHORTCUTS.show_help,
                clear_input: DEFAULT_SHORTCUTS.clear_input,
                list_tasks: DEFAULT_SHORTCUTS.list_tasks
            }
        }),
        applications: ApplicationConfigSchema.describe('OpenDesk应用相关配置').default({})
    });
}

export type SettingData = z.infer<ReturnType<typeof getSettingSchema>>;

export class ModelInstance {
    model_name: string;
    base_url: string;
    api_key: string;
    no_proxy: boolean;
    reasoning_effort: ReasoningEffort;
    context_length?: number;

    /**
     * @param model_name 模型名称
     * @param base_url API 地址
     * @param api_key API 密钥
     * @param no_proxy 是否禁用代理
     * @param reasoning_effort 模型默认推理模式
     * @param context_length 用户配置的上下文长度（>0 时覆盖系统估算）
     */
    constructor(
        model_name: string,
        base_url: string,
        api_key: string,
        no_proxy: boolean,
        reasoning_effort: ReasoningEffort = '',
        context_length?: number
    ) {
        this.model_name = model_name;
        this.base_url = base_url;
        this.api_key = api_key;
        this.no_proxy = no_proxy;
        this.reasoning_effort = reasoning_effort;
        this.context_length = context_length && context_length > 0 ? context_length : undefined;
    }
}

export class Setting {
    static instance: Setting | null = null;
    static applicationConfigChangedCallbacks = new Map<string, () => void>();

    data: SettingData;

    constructor() {
        this.data = getSettingSchema().parse({}) as SettingData;
    }

    getData(): SettingData {
        return this.data;
    }

    getApplicationConfig(applicationName: string): unknown {
        return this.data.applications[applicationName as keyof typeof this.data.applications];
    }

    setData(data: unknown): void {
        const newSettingData = getSettingSchema().parse(data) as SettingData;
        const settingChangedApplications: string[] = [];

        if (ApplicationConfigSchema && 'shape' in ApplicationConfigSchema && ApplicationConfigSchema.shape) {
            const applicationNames = Object.keys(ApplicationConfigSchema.shape);
            for (const applicationName of applicationNames) {
                const newConfig = (newSettingData.applications as Record<string, unknown>)[applicationName];
                const oldConfig = (this.data.applications as Record<string, unknown>)[applicationName];
                const isEqual = JSON.stringify(newConfig) === JSON.stringify(oldConfig);
                if (!isEqual) {
                    settingChangedApplications.push(applicationName);
                }
            }
        }

        this.data = newSettingData;
        this.save();

        if (settingChangedApplications.length > 0) {
            for (const applicationName of settingChangedApplications) {
                const callback = Setting.applicationConfigChangedCallbacks.get(applicationName);
                if (callback !== undefined) {
                    callback();
                }
            }
        }
    }

    /**
     * Get the unique setting instance
     */
    static getInstance(): Setting {
        if (Setting.instance === null) {
            Setting.instance = Setting.load();
            if (Setting.instance === null) {
                Setting.instance = new Setting();
            }
        }
        return Setting.instance;
    }

    static clearCache(): void {
        Setting.instance = null;
    }

    /**
     * Update the setting data directly (used by worker thread to sync settings from main thread)
     * @param data - The new setting data
     */
    static updateInstanceData(data: unknown): void {
        if (Setting.instance === null) {
            Setting.instance = new Setting();
        }
        Setting.instance.data = getSettingSchema().parse(data) as SettingData;
    }

    /**
     * Register the application settings so that they can be managed and
     * edited from the system setting editor.
     * @param application - 应用实例
     * @param configChangedCallback - 配置变更时的回调
     */
    static registerApplicationSettings(application: BaseApplication, configChangedCallback: () => void): void {
        const applicationConfigSchema = (
            Object.getPrototypeOf(application).constructor as typeof BaseApplication
        ).getConfigSchema();
        ApplicationConfigSchema = ApplicationConfigSchema.extend({
            [application.bundleName]: applicationConfigSchema.optional()
        }) as z.ZodObject<z.ZodRawShape>;
        Setting.applicationConfigChangedCallbacks.set(application.bundleName, configChangedCallback);
    }

    /**
     * Load the setting from the file system
     * @returns Setting 实例，若文件不存在或解析失败则返回 null
     */
    static load(): Setting | null {
        const settingDirectory = getAppDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        if (!fs.existsSync(settingFile)) {
            return null;
        }
        const settingRawObject = JSON.parse(fs.readFileSync(settingFile, 'utf8'));

        // Migration: rename legacy 'display' field to 'gui_config'
        if (settingRawObject.display && !settingRawObject.gui_config) {
            settingRawObject.gui_config = settingRawObject.display;
            delete settingRawObject.display;
        }

        const setting = new Setting();
        try {
            setting.data = getSettingSchema().parse(settingRawObject) as SettingData;
            return setting;
        } catch (error) {
            console.error('error loading setting', error);
            return null;
        }
    }

    /**
     * Save the setting to the file system
     */
    save(): void {
        const settingDirectory = getAppDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        fs.writeFileSync(settingFile, JSON.stringify(this.data, null, 4), { encoding: 'utf8' });
    }

    /**
     * Get the model instance by the model alias
     * @param model_alias - 模型别名
     * @returns ModelInstance 或 null
     */
    getModelInstance(model_alias: string): ModelInstance | null {
        const modelRef = this.data.models.find((model: Model) => model.alias === model_alias);
        if (modelRef === undefined) {
            return null;
        }
        const provider = this.data.providers.find((p: Provider) => p.name === modelRef.provider_name);
        if (provider === undefined) {
            return null;
        }
        return new ModelInstance(
            modelRef.model_name,
            provider.base_url,
            provider.api_key,
            provider.no_proxy,
            modelRef.reasoning_effort,
            modelRef.context_length
        );
    }

    /**
     * Get the default model instance
     */
    getDefaultModelInstance(): ModelInstance {
        const model = this.getModelInstance(this.data.default_model);
        if (model === null) {
            throw new Error(`default model ${this.data.default_model} not found`);
        }
        return model;
    }

    getDefaultEmbeddingModelInstance(): ModelInstance {
        const model = this.getModelInstance(this.data.default_embedding_model);
        if (model === null) {
            throw new Error(`default embedding model ${this.data.default_embedding_model} not found`);
        }
        return model;
    }

    getDefaultRerankerModelInstance(): ModelInstance {
        const model = this.getModelInstance(this.data.default_reranker_model);
        if (model === null) {
            throw new Error(`default reranker model ${this.data.default_reranker_model} not found`);
        }
        return model;
    }

    /**
     * Get the default intent parsing model instance
     */
    getDefaultIntentParsingModelInstance(): ModelInstance {
        const model = this.getModelInstance(this.data.default_intent_parsing_model);
        if (model === null) {
            throw new Error(`default intent parsing model ${this.data.default_intent_parsing_model} not found`);
        }
        return model;
    }

    static getSettingSchema(): ReturnType<typeof getSettingSchema> {
        return getSettingSchema();
    }

    getDefaultVisionModelInstance(): ModelInstance {
        const model = this.getModelInstance(this.data.default_vision_model);
        if (model === null) {
            throw new Error(`default vision model ${this.data.default_vision_model} not found`);
        }
        return model;
    }

    /**
     * 获取当前有效的工作空间路径。
     * 如果默认工作空间为空或目录不存在，则使用临时工作空间。
     */
    getEffectiveWorkspace(): string {
        const configuredPath = this.data.default_workspace as string;
        if (configuredPath && fs.existsSync(configuredPath)) {
            try {
                const stat = fs.statSync(configuredPath);
                if (stat.isDirectory()) {
                    return configuredPath;
                }
            } catch {
                // fall through to temp workspace
            }
        }
        return getTempWorkspaceDirectory();
    }
}

/** 用户通过 --config-directory 指定的自定义配置目录（主线程生效） */
let customAppDirectory: string | undefined;

/**
 * 设置自定义应用数据目录（由 CLI --config-directory 选项调用）
 */
function setCustomAppDirectory(dir: string): void {
    customAppDirectory = path.resolve(dir);
}

/**
 * 获取默认的应用数据目录路径（不创建目录），供 CLI help 提示使用
 */
function getDefaultAppDirectory(): string {
    if (process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'opendesk');
    } else if (process.env.HOME) {
        return path.join(process.env.HOME, '.opendesk');
    } else {
        return '<unknown>';
    }
}

/**
 * 获取应用数据目录
 */
function getAppDirectory(): string {
    if (!isMainThread) {
        return (workerData as { paths: { appDirectory: string } }).paths.appDirectory;
    }

    const userDataPath = resolveWritableUserDataRoot();

    if (fs.existsSync(userDataPath)) {
        return userDataPath;
    } else {
        fs.mkdirSync(userDataPath, { recursive: true });
        return userDataPath;
    }
}

/**
 * 获取应用日志目录
 */
const _ensuredDirCache = new Set<string>();
function ensureDirectoryExists(directory: string): string {
    if (!_ensuredDirCache.has(directory)) {
        fs.mkdirSync(directory, { recursive: true });
        _ensuredDirCache.add(directory);
    }
    return directory;
}

/**
 * 获取临时工作空间目录。
 * - Windows: $USERPROFILE/opendesk
 * - 类 Unix: $HOME/.opendesk/workspace
 */
function getTempWorkspaceDirectory(): string {
    let workspacePath: string;
    if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        workspacePath = path.join(userProfile, 'opendesk');
    } else {
        workspacePath = path.join(getAppDirectory(), 'workspace');
    }
    return ensureDirectoryExists(workspacePath);
}

function resolveArtifactDirectory(): string {
    return path.join(getAppDirectory(), 'artifacts');
}

function getLogDirectory(): string {
    return ensureDirectoryExists(path.join(getAppDirectory(), 'logs'));
}

/**
 * 获取应用任务目录
 */
function getTaskDirectory(): string {
    return ensureDirectoryExists(path.join(getAppDirectory(), 'tasks'));
}

/**
 * 获取应用产物目录
 */
function getArtifactDirectory(): string {
    return ensureDirectoryExists(resolveArtifactDirectory());
}

/**
 * 获取任务级产物目录。
 * 默认在访问时创建 `artifacts/<taskId>/`，清理等仅读场景可显式关闭创建。
 */
function getTaskArtifactDirectory(taskId: string, ensureExists: boolean = true): string {
    const artifactDirectory = resolveArtifactDirectory();
    const taskArtifactDirectory = path.join(artifactDirectory, taskId);

    if (ensureExists) {
        ensureDirectoryExists(artifactDirectory);
        ensureDirectoryExists(taskArtifactDirectory);
    }

    return taskArtifactDirectory;
}

/**
 * 获取任务级工具结果目录 `artifacts/<taskId>/tool-results/`。
 * 默认在访问时创建目录，仅读场景可显式关闭创建。
 */
function getTaskToolResultDirectory(taskId: string, ensureExists: boolean = true): string {
    const taskArtifactDirectory = getTaskArtifactDirectory(taskId, ensureExists);
    const toolResultDirectory = path.join(taskArtifactDirectory, 'tool-results');

    if (ensureExists) {
        ensureDirectoryExists(toolResultDirectory);
    }

    return toolResultDirectory;
}

/**
 * 获取任务级 session memory 目录 `artifacts/<taskId>/session-memory/`。
 * 默认在访问时创建目录，仅读场景可显式关闭创建。
 */
function getTaskSessionMemoryDirectory(taskId: string, ensureExists: boolean = true): string {
    const taskArtifactDirectory = getTaskArtifactDirectory(taskId, ensureExists);
    const sessionMemoryDirectory = path.join(taskArtifactDirectory, 'session-memory');

    if (ensureExists) {
        ensureDirectoryExists(sessionMemoryDirectory);
    }

    return sessionMemoryDirectory;
}

/**
 * 获取任务级 session memory 文件路径 `artifacts/<taskId>/session-memory/session-memory.md`。
 */
function getTaskSessionMemoryPath(taskId: string, ensureExists: boolean = true): string {
    return path.join(getTaskSessionMemoryDirectory(taskId, ensureExists), 'session-memory.md');
}

export type ShortcutsConfig = z.infer<typeof ShortcutsSchema>;

/**
 * 获取当前已配置的快捷键（带默认值回退）
 */
function getShortcuts(): ShortcutsConfig {
    const data = Setting.getInstance().getData();
    return (data as any).cli_config?.shortcuts ?? ShortcutsSchema.parse({});
}

export {
    getAppDirectory,
    getDefaultAppDirectory,
    setCustomAppDirectory,
    getLogDirectory,
    getTaskDirectory,
    getArtifactDirectory,
    getTaskArtifactDirectory,
    getTaskToolResultDirectory,
    getTaskSessionMemoryDirectory,
    getTaskSessionMemoryPath,
    getTempWorkspaceDirectory,
    getSettingSchema,
    getShortcuts,
    type ReasoningEffort
};
