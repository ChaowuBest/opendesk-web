import z from 'zod';
import path from 'path';
import fs from 'fs';
import { workerData, isMainThread } from 'worker_threads';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let electronApp = null;

try {
    const electron = require('electron');
    electronApp = electron.app;
} catch (error) {
    console.info('electron is not loaded in the worker thread');
}

const ProviderSchema = z.object({
    name: z.string().default('openrouter').describe('模型提供商名称'),
    base_url: z.string().default('https://openrouter.ai/api/v1').describe('模型提供商的 API 地址'),
    api_key: z.string().default('').describe('模型提供商的 API 密钥'),
    no_proxy: z.boolean().default(false).describe('是否禁用代理')
})

const ModelSchema = z.object({
    alias: z.string().default('model_alias').describe('模型别名(在本地配置中使用的名称)'),
    provider_name: z.string().default('openrouter').describe('模型提供商'),
    model_name: z.string().default('google/gemini-2.5-flash').describe('模型名称(在提供商一侧的名称)')
})

var defaultExcludePatterns = [
    "C:/Windows/**",
    "C:/Temp/**",
    "**/node_modules/**",
    "**/.git/**",
    "**/.DS_Store/**",
    "**/.idea/**",
    "**/.vscode/**",
    "**/.pytest_cache/**",
    "**/.mypy_cache/**",
    "**/.hvigor/**",
    "**/site-packages/**",
]

function getHomeDirectory() {
    return process.env.HOME || process.env.USERPROFILE || "";
}

if (process.platform === 'darwin') {
    defaultExcludePatterns.push(`${getHomeDirectory()}/Library/**`);
}

const FSEntrySchema = z.object({
    root: z.string().default(getHomeDirectory()),
    include_patterns: z.array(z.string()).default([
        "**/*.{txt,md}",
        "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx,csv}",
        "**/*.{json,yaml,yml,xml,html,css,js}",
    ]),
    exclude_patterns: z.array(z.string()).default(defaultExcludePatterns),
})

var ApplicationConfigSchema = z.object({});

function getSettingSchema() {
    return z.object({
        default_model: z.string()
            .describe('在对话等场景中使用的默认模型')
            .default(''),
        default_intent_parsing_model: z.string().describe('在意图解析中使用的多模态模型').default(''),
        default_embedding_model: z.string().describe('知识库，检索使用的中使用的向量嵌入模型').default(''),
        providers: z.array(ProviderSchema).describe('可用AI模型提供商').default([]),
        models: z.array(ModelSchema)
            .describe('可用AI模型')
            .default([]),
        filesystems: z.array(FSEntrySchema).describe('AI文件系统相关配置').default([]),
        applications: ApplicationConfigSchema.describe('FillipDesk应用相关配置').default({})
    })
}

class ModelInstance {
    /**
     * @param {string} model_name
     * @param {string} base_url
     * @param {string} api_key
     * @param {boolean} no_proxy
     */
    constructor(model_name, base_url, api_key, no_proxy) {
        /** @type {string} */
        this.model_name = model_name;
        /** @type {string} */
        this.base_url = base_url;
        /** @type {string} */
        this.api_key = api_key;
        /** @type {boolean} */
        this.no_proxy = no_proxy;
    }
}

class Setting {
    /**
     * @type {Setting | null}
     */
    static instance = null;

    constructor() {
        /** @type {z.core.output<SettingSchema>} */
        this.data = getSettingSchema().parse({});
    }

    getData() {
        return this.data;
    }

    setData(data) {
        this.data = getSettingSchema().parse(data);
        this.save();
    }

    /**
     * Get the unique setting instance
     * @returns {Setting}
     */
    static getInstance() {
        if (Setting.instance === null) {
            Setting.instance = Setting.load();
            if (Setting.instance === null) {
                Setting.instance = new Setting();
            }
        }
        return Setting.instance;
    }

    /**
     * Register the application settings so that they can be managed and
     * edited from the system setting editor.
     * @param {BaseApplication} application
     */
    static registerApplicationSettings(application) {
        ApplicationConfigSchema = ApplicationConfigSchema.extend({
            [application.bundleName]: application.getConfigSchema().optional()
        });
    }

    /**
     * Load the setting from the file system
     * @returns {Setting | null}
     */
    static load() {
        const settingDirectory = getAppDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        if (!fs.existsSync(settingFile)) {
            return null;
        }
        const settingRawObject = JSON.parse(fs.readFileSync(settingFile, 'utf8'));
        let setting = new Setting();
        try {
            setting.data = getSettingSchema().parse(settingRawObject);
            return setting;
        } catch (error) {
            console.error('error loading setting', error);
            return null;
        }
    }

    /**
     * Save the setting to the file system
     */
    save() {
        const settingDirectory = getAppDirectory();
        const settingFile = path.join(settingDirectory, 'setting.json');
        fs.writeFileSync(settingFile, JSON.stringify(this.data, null, 4), { encoding: 'utf8' });
    }

    /**
     * Get the model instance by the model alias
     * @param {string} model_alias
     * @returns {ModelInstance | null}
     */
    getModelInstance(model_alias) {
        let modelRef = this.data.models.find(model => model.alias === model_alias);
        if (modelRef === undefined) {
            return null;
        }
        let provider = this.data.providers.find(provider => provider.name === modelRef.provider_name);
        if (provider === undefined) {
            return null;
        }
        return new ModelInstance(modelRef.model_name, provider.base_url, provider.api_key, provider.no_proxy);
    }

    /**
     * Get the default model instance
     * @returns {ModelInstance}
     */
    getDefaultModelInstance() {
        let model = this.getModelInstance(this.data.default_model);
        if (model === null) {
            throw new Error(`default model ${this.data.default_model} not found`);
        }
        return model;
    }

    getDefaultEmbeddingModelInstance() {
        let model = this.getModelInstance(this.data.default_embedding_model);
        if (model === null) {
            throw new Error(`default embedding model ${this.data.default_embedding_model} not found`);
        }
        return model;
    }

    /**
     * Get the default intent parsing model instance
     * @returns {ModelInstance}
     */
    getDefaultIntentParsingModelInstance() {
        let model = this.getModelInstance(this.data.default_intent_parsing_model);
        if (model === null) {
            throw new Error(`default intent parsing model ${this.data.default_intent_parsing_model} not found`);
        }
        return model;
    }

    static getSettingSchema() {
        return getSettingSchema();
    }
}

/**
 * 获取应用数据目录
 * @returns {string}
 */
function getAppDirectory() {
    if (!isMainThread) {
        return workerData.paths.appDirectory;
    }

    const userDataPath = electronApp.getPath('userData');
    if (fs.existsSync(userDataPath)) {
        return userDataPath;
    } else {
        fs.mkdirSync(userDataPath, { recursive: true });
        return userDataPath;
    }
}

/**
 * 获取应用日志目录
 * @returns {string}
 */
function getLogDirectory() {
    const appDirectory = getAppDirectory();
    const logDirectory = path.join(appDirectory, 'logs');
    if (!fs.existsSync(logDirectory)) {
        fs.mkdirSync(logDirectory, { recursive: true });
    }
    return logDirectory;
}

/**
 * 获取应用任务目录
 * @returns {string}
 */
function getTaskDirectory() {
    const appDirectory = getAppDirectory();
    const taskDirectory = path.join(appDirectory, 'tasks');
    if (!fs.existsSync(taskDirectory)) {
        fs.mkdirSync(taskDirectory, { recursive: true });
    }
    return taskDirectory;
}

export {
    getAppDirectory, getLogDirectory, getTaskDirectory,
    Setting, ModelInstance, getSettingSchema, FSEntrySchema
};