import { BaseApplication, BaseGUIConfig } from "../base.js";
import { z } from 'zod';
import path from 'path';


const __dirname = import.meta.dirname;

class A2AApplication extends BaseApplication {
    constructor() {
        super('a2a', '智能体中心');
    }

    getConfigSchema() {
        return z.object({});
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
