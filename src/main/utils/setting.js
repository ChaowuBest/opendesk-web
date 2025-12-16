const z = require("zod");
const { app } = require('electron');
const path = require('path');
const fs = require('fs');


const ProviderSchema = z.object({
    name: z.string().default('openrouter'),
    base_url: z.string().default('https://openrouter.ai/api/v1'),
    api_key: z.string().default('')
})

const ModelSchema = z.object({
    alias: z.string().default('model_alias'),
    provider_name: z.string().default('openrouter'),
    model_name: z.string().default('google/gemini-2.5-flash')
})

const FSEntrySchema = z.object({
    root: z.string().default('C:\\Users'),
    extnames: z.array(z.string()).default([
        'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
        'jpg', 'jpeg', 'png', 'webp', 'bmp',
        'c', 'cpp', 'h', 'hpp', 'js'
    ]),
    include_patterns: z.array(z.string()).default([]),
    exclude_patterns: z.array(z.string()).default([
        "C:\\Windows\\**",
        "C:\\Temp\\**",
        "**\\node_modules\\**"
    ]),
})

const SettingSchema = z.object({
    default_model: z.string().default(''),
    default_intent_parsing_model: z.string().default(''),
    default_embedding_model: z.string().default(''),
    providers: z.array(ProviderSchema).default([]),
    models: z.array(ModelSchema).default([]),
    filesystems: z.array(FSEntrySchema).default([]),
})

class ModelInstance {
    /**
     * @param {string} model_name
     * @param {string} base_url
     * @param {string} api_key
     */
    constructor(model_name, base_url, api_key) {
        /** @type {string} */
        this.model_name = model_name;
        /** @type {string} */
        this.base_url = base_url;
        /** @type {string} */
        this.api_key = api_key;
    }
}

class Setting {
    /**
     * @type {Setting | null}
     */
    static instance = null;

    constructor() {
        /** @type {z.core.output<SettingSchema>} */
        this.data = SettingSchema.parse({});
    }

    getData() {
        return this.data;
    }

    setData(data) {
        this.data = SettingSchema.parse(data);
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
            setting.setData(settingRawObject);
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
        return new ModelInstance(modelRef.model_name, provider.base_url, provider.api_key);
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
}

function getAppDirectory() {
    const userDataPath = app.getPath('userData');
    if (fs.existsSync(userDataPath)) {
        return userDataPath;
    } else {
        fs.mkdirSync(userDataPath, { recursive: true });
        return userDataPath;
    }
}

function getTaskDirectory() {
    const appDirectory = getAppDirectory();
    const taskDirectory = path.join(appDirectory, 'tasks');
    if (!fs.existsSync(taskDirectory)) {
        fs.mkdirSync(taskDirectory, { recursive: true });
    }
    return taskDirectory;
}

module.exports = { getAppDirectory, getTaskDirectory, Setting, ModelInstance }