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

import fs from 'fs';
import path from 'path';
import { runArxivSearchTests } from './ut/search/arxiv.test.js';
import { runTavilySearchTests } from './ut/search/tavily.test.js';
import { runBochaSearchTests } from './ut/search/bocha.test.js';

function getSettingPath(): string {
    const appData = process.env.APPDATA;
    if (!appData) {
        throw new Error('APPDATA environment variable not found');
    }
    return path.join(appData, 'opendesk', 'setting.json');
}

function loadRawSetting(): Record<string, any> {
    const settingPath = getSettingPath();
    if (!fs.existsSync(settingPath)) {
        throw new Error(`配置文件不存在: ${settingPath}`);
    }
    return JSON.parse(fs.readFileSync(settingPath, 'utf8'));
}

function cmdGetConfig(appName?: string) {
    const setting = loadRawSetting();

    if (appName) {
        const appConfig = setting.applications?.[appName];
        if (appConfig === undefined) {
            console.error(`未找到应用 "${appName}" 的配置`);
            process.exit(1);
        }
        console.log(JSON.stringify(appConfig, null, 2));
    } else {
        console.log(JSON.stringify(setting, null, 2));
    }
}

async function cmdUt() {
    console.log('运行单元测试...');

    // 运行arXiv搜索测试
    const arxivTestsPassed = await runArxivSearchTests();

    // 运行Tavily搜索测试
    const tavilyTestsPassed = await runTavilySearchTests();

    // 运行博查搜索测试
    const bochaTestsPassed = await runBochaSearchTests();

    if (arxivTestsPassed && tavilyTestsPassed && bochaTestsPassed) {
        console.log('\n✅ 所有单元测试通过');
        process.exit(0);
    } else {
        console.log('\n❌ 部分单元测试失败');
        process.exit(1);
    }
}

const commands: Record<string, (...args: string[]) => void | Promise<void>> = {
    'get-config': cmdGetConfig,
    'ut': cmdUt,
};

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === '--help') {
        console.log('用法: npm run test-cli -- <command> [args...]');
        console.log('可用命令:');
        console.log('  get-config [app-name]  获取配置（可选指定应用名）');
        console.log('  ut                     运行单元测试');
        process.exit(0);
    }

    const handler = commands[command];
    if (!handler) {
        console.error(`未知命令: ${command}`);
        console.error('可用命令: ' + Object.keys(commands).join(', '));
        process.exit(1);
    }

    await handler(...args.slice(1));
}

main();
