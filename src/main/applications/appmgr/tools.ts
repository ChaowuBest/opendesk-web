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
import { BaseTool } from '../../aikernel/tool.js';
import type { AppMgrApplication } from './app.js';

const InstallAppArgsSchema = z.object({
    zipPath: z.string().describe('本地 OpenDesk 应用 zip 文件路径')
});

export class InstallAppTool extends BaseTool<typeof InstallAppArgsSchema> {
    private app: AppMgrApplication;

    constructor(app: AppMgrApplication) {
        super('installApp', '从本地 zip 文件安装一个 OpenDesk 后装应用', InstallAppArgsSchema, undefined, {
            'zh-CN': '安装应用',
            'en-US': 'Install App'
        });
        this.app = app;
        this.executor = this.install.bind(this);
    }

    private async install(args: z.output<typeof InstallAppArgsSchema>): Promise<string> {
        return JSON.stringify(await this.app.installFromZip(args.zipPath));
    }
}

const ListAppsArgsSchema = z.object({});

export class ListAppsTool extends BaseTool<typeof ListAppsArgsSchema> {
    private app: AppMgrApplication;

    constructor(app: AppMgrApplication) {
        super('listApps', '获取 OpenDesk 应用列表，包括用户安装应用和系统内置应用', ListAppsArgsSchema, undefined, {
            'zh-CN': '应用列表',
            'en-US': 'List Apps'
        });
        this.app = app;
        this.executor = this.list.bind(this);
    }

    private async list(): Promise<string> {
        return JSON.stringify(await this.app.listAllApps());
    }
}

const GetAppInfoArgsSchema = z.object({
    bundleName: z.string().describe('应用包名 bundleName')
});

export class GetAppInfoTool extends BaseTool<typeof GetAppInfoArgsSchema> {
    private app: AppMgrApplication;

    constructor(app: AppMgrApplication) {
        super('getAppInfo', '获取指定应用的详细信息、版本列表和当前版本', GetAppInfoArgsSchema, undefined, {
            'zh-CN': '应用信息',
            'en-US': 'App Info'
        });
        this.app = app;
        this.executor = this.get.bind(this);
    }

    private async get(args: z.output<typeof GetAppInfoArgsSchema>): Promise<string> {
        return JSON.stringify(await this.app.getAppInfo(args.bundleName));
    }
}
