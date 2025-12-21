const { z } = require("zod");
const { logger } = require("../utils/logger");
const { Setting } = require("../utils/setting");
const { BaseTool } = require("../agents/tool");


class BaseService {

    static getInstance() {
        throw new Error('not implemented');
    }

}

class BaseApplication {

    constructor(bundleName) {
        /** @type {string} */
        this.bundleName = bundleName;
    }

    /**
     * 返回应用的配置 schema，用于在设置界面中显示和编辑配置。如果不需要配置，则返回空对象。
     * @returns {z.ZodObject<any>}
     */
    getConfigSchema() {
        return z.object({});
    }

    /**
     * 获取应用的配置
     * @returns {z.output<z.ZodObject<any>>}
     */
    getConfig() {
        return Setting.getInstance().data.applications[this.bundleName];
    }

    /**
     * 返回 BaseService 的一个子类。
     * @returns {typeof BaseService | null}
     */
    getService() {
        throw new Error('not implemented');
    }

    /**
     * 获取应用提供的工具
     * @returns {BaseTool[]}
     */
    getTools() {
        throw new Error('not implemented');
    }
}

class ApplicationRegistry {
    /** @type {Map<string, BaseApplication>} */
    static applications = new Map();

    /**
     *
     * @param {BaseApplication} application
     */
    static registerApplication(application) {
        logger.info(`registering application ${application.bundleName}`);
        ApplicationRegistry.applications.set(application.bundleName, application);
        Setting.registerApplicationSettings(application);
    }

    /**
     * @returns {Map<string, BaseTool>}
     */
    static listAvailableTools() {
        let result = new Map();
        for (let application of ApplicationRegistry.applications.values()) {
            for (let tool of application.getTools()) {
                let tool_id = `${application.bundleName}-${tool.name}`;
                result.set(tool_id, tool);
            }
        }
        return result;
    }
}

module.exports = {
    BaseApplication,
    BaseService,
    ApplicationRegistry
}