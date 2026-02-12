import { BaseApplication } from "../base.js";
import { z } from 'zod';
import A2AWorker from "./service/worker";


class A2AApplication extends BaseApplication {
    constructor() {
        super('a2a', '智能体中心');
    }

    static getWorkerClass() {
        return A2AWorker;
    }

    static getConfigSchema() {
        return z.object({
            default_a2a_model: z.string()
                .describe('在 A2A Agent 选择中使用的专用模型（留空则使用默认模型）')
                .default('')
        });
    }

}

export { A2AApplication };
