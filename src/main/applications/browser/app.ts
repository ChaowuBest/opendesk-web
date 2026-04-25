/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BaseApplication } from '../base';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import {
    BrowserNavigateTool,
    BrowserGetCDPPortTool,
    BrowserGetStateTool,
    BrowserExecuteScriptTool,
    BrowserGoBackTool,
    BrowserGoForwardTool,
    BrowserRefreshTool
} from './tools';
import { BROWSER_SKILL } from './skills';
import chalk from 'chalk';

class BrowserApplication extends BaseApplication {
    constructor() {
        super('browser', '浏览器');
    }

    async getTUIStatusBlock() {
        try {
            return `🌐 ${chalk.cyan('浏览器就绪')}`;
        } catch {
            return null;
        }
    }

    static getConfigSchema() {
        return z.object({
            defaultHomepage: z.string().default('https://www.baidu.com').describe('浏览器默认主页'),
            enableCDP: z.boolean().default(true).describe('是否启用 Chrome DevTools Protocol'),
            cdpPort: z.number().default(9222).describe('CDP 监听端口')
        });
    }

    getCliSlashCommands(tui: any) {
        return [
            {
                name: 'browser',
                description: '显示浏览器信息',
                execute: async () => {
                    try {
                        tui.log('');
                        tui.log(chalk.cyan.bold('🌐 嵌入式浏览器'));
                        tui.log(chalk.dim('──────────────────────────────'));
                        tui.log('• 浏览器标签位于右侧栏 "浏览器" 选项');
                        tui.log('• CDP 端口: 9222 (用于 Playwright 自动化)');
                        tui.log('• 连接示例:');
                        tui.log(chalk.gray('  const browser = await chromium.connectOverCDP("ws://localhost:9222");'));
                        tui.log('');
                    } catch (err) {
                        logger.error(`浏览器命令执行失败: ${err}`);
                    }
                }
            }
        ];
    }

    async getSupportedEvents() {
        return [
            { eventName: 'navigate', eventDescription: '浏览器导航到指定URL' },
            { eventName: 'goBack', eventDescription: '浏览器后退' },
            { eventName: 'goForward', eventDescription: '浏览器前进' },
            { eventName: 'refresh', eventDescription: '浏览器刷新' },
            { eventName: 'executeScript', eventDescription: '在浏览器中执行JavaScript' }
        ];
    }

    async getSkills() {
        const skill = Skill.parseMd(BROWSER_SKILL);
        const toolset = new BaseToolset('browser');
        toolset.addTool(new BrowserNavigateTool(this));
        toolset.addTool(new BrowserGetCDPPortTool());
        toolset.addTool(new BrowserGetStateTool(this));
        toolset.addTool(new BrowserExecuteScriptTool(this));
        toolset.addTool(new BrowserGoBackTool(this));
        toolset.addTool(new BrowserGoForwardTool(this));
        toolset.addTool(new BrowserRefreshTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }
}

export { BrowserApplication };
