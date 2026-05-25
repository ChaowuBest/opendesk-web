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
import { BaseApplication } from '../base';
import { AgentGateBridge } from '../../services/agent-gate-bridge';

class AgentGateApplication extends BaseApplication {
    constructor() {
        super('agentgate', '安全网关');
    }

    static getConfigSchema() {
        return z.object({
            enableLLM: z.boolean().default(true).describe('启用 LLM 深度分析（Layer 3）'),
            llmModel: z.string().default('').describe('分析模型（留空使用默认模型）'),
            customRules: z
                .array(
                    z.object({
                        pattern: z.string().describe('匹配模式（正则表达式）'),
                        action: z.enum(['Allow', 'Deny']).describe('匹配后执行的动作'),
                        severity: z.enum(['low', 'medium', 'high', 'critical']).describe('风险等级')
                    })
                )
                .default([])
                .describe('自定义安全规则')
        });
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        // 配置变更后通知 AgentMoss
        const { Setting } = require('../../utils/setting') as typeof import('../../utils/setting');
        AgentGateBridge.getInstance().updateConfig(Setting.getInstance());
    }
}

export { AgentGateApplication };
