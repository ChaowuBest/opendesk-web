import { z } from '../../assets/scripts/zod.min.js';
import { BaseTool, BaseToolset } from '../agents/tool.js';

export { z };


/**
 * 运行在渲染进程的工具，可以通过后端的Agent调用
 */
export class RendererTool extends BaseTool {
    constructor(name, description) {
        super(name, description, z.object({}));
        this.executor = null;
    }

    /**
     * 设置工具的执行器
     * @param {(args: z.output<this.params>) => Promise<string>} executor 工具的执行器
     * @returns {RendererTool} 工具
     */
    setExecutor(executor) {
        this.executor = executor;
        return this;
    }

    setParams(params) {
        this.params = params.toJSONSchema();
        return this;
    }

    async execute(args) {
        return this.executor(args);
    }
}

export class RendererToolset extends BaseToolset {
    constructor(name) {
        super(name);
    }
}