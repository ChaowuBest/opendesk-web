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
