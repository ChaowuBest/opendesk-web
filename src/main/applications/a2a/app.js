import { BaseApplication, BaseGUIConfig } from "../base.js";
import { z } from 'zod';
import path from 'path';


const __dirname = import.meta.dirname;

class A2AApplication extends BaseApplication {
    constructor() {
        super('a2a', '智能体中心');
    }

    static getConfigSchema() {
        return z.object({
            default_a2a_model: z.string()
                .describe('在 A2A Agent 选择中使用的专用模型（留空则使用默认模型）')
                .default('')
        });
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'a2a-entry-widget',
            `/applications/a2a/icon.png`
        );
    }

}

export { A2AApplication };
