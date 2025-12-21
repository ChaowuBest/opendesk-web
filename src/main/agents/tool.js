const { z } = require('zod');


class BaseTool {
    /**
     * @param {string} name 工具的名称
     * @param {string} description 工具的描述
     * @param {z.ZodSchema} params 工具的参数
     */
    constructor(name, description, params) {
        /** @type {string} */
        this.name = name;
        /** @type {string} */
        this.description = description;
        /** @type {z.ZodSchema} */
        this.params = params;
    }

    /**
     *
     * @param {z.output<this.params>} args 工具的参数
     * @returns {string} 工具的标题
     */
    getTitle(args) {
        return this.name;
    }

    /**
     * 执行工具
     * @param {z.output<this.params>} args 工具的参数
     * @returns {Promise<string>} 工具的执行结果
     */
    async execute(args) {
        throw new Error('not implemented');
    }
}

module.exports = {
    BaseTool
}