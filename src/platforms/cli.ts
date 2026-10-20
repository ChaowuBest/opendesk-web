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

import { AbstractPlatform } from './base.js';
import { BaseApplication } from '../main/applications/base';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import type { PermissionPromptProvider } from '../main/aikernel/security/permission.js';
import type { AskUserProvider } from '../main/aikernel/interaction/tools.js';
import { createInteractionToolset } from '../main/aikernel/interaction/tools.js';
import type { ExitPlanModeProvider } from '../main/aikernel/interaction/exitPlanMode.js';
import type { InteractiveToolset } from '../main/aikernel/tool.js';
import { fetchWithResolvedProxy } from './proxy-fetch.js';
import type { PlatformFetchOptions, PlatformNetworkConfig } from './base.js';
import { Setting } from '../main/utils/setting.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import { MobileAccessApplication } from '../main/applications/mobileaccess/app.js';
import { MailboxApplication } from '../main/applications/mailbox/app.js';
import { FileMgrApplication } from '../main/applications/filemgr/app.js';
import { CalendarApplication } from '../main/applications/calendar/app.js';
import { SearchApplication } from '../main/applications/search/app';
import { TerminalApplication } from '../main/applications/terminal/app.js';
import { McpMgrApplication } from '../main/applications/mcpmgr/app.js';
import { TodoMgrApplication } from '../main/applications/todomgr/app.js';
import { SkillMgrApplication } from '../main/applications/skillmgr/app.js';
import { ChannelMgrApplication } from '../main/applications/channelmgr/app.js';
import { KnowledgeBaseApplication } from '../main/applications/knowledgebase/app.js';
import { DeviceMgrApplication } from '../main/applications/devicemgr/app.js';
import { BuiltinApplication } from '../main/applications/builtin/app.js';
import { AppMgrApplication } from '../main/applications/appmgr/app.js';
import { AgentOfficeApplication } from '../main/applications/agentoffice/app.js';
import { PluginMgrApplication } from '../main/applications/pluginmgr/app.js';
import { AcpMgrApplication } from '../main/applications/acpmgr/app.js';

/**
 * 平台注册的应用类元素类型。
 *
 * 注册表与 CLI 均以 `new ApplicationClass()` 无参实例化，而各应用的构造签名
 * 并不统一（如 AcpMgrApplication 接收 dependencies 对象、其余应用是
 * `(bundleName = 'xxx', showIcon = true)`）。因此这里只要求「可无参构造 +
 * 静态成员与 BaseApplication 一致」，仍然可以赋给基类声明的
 * `(typeof BaseApplication)[]`。
 */
export type ApplicationClass = Omit<typeof BaseApplication, 'prototype'> & (new () => BaseApplication);

export class CliPlatform extends AbstractPlatform {
    private _workspace: string = process.cwd();
    private _permissionPromptProvider: PermissionPromptProvider | null = null;
    private _askUserProvider: AskUserProvider | null = null;
    private _exitPlanModeProvider: ExitPlanModeProvider | null = null;

    getName(): string {
        return 'cli';
    }

    getNetworkConfig(): PlatformNetworkConfig {
        const nc = Setting.getInstance().getData().network_config;
        return {
            no_ssl: nc.no_ssl,
            use_proxy: nc.use_proxy,
            custom_proxy_addr: nc.custom_proxy_addr,
            no_proxy: nc.no_proxy
        };
    }

    getEffectiveWorkspace(): string {
        return this._workspace;
    }

    setWorkspace(workspace: string): void {
        this._workspace = workspace;
    }

    setPermissionPromptProvider(provider: PermissionPromptProvider): void {
        this._permissionPromptProvider = provider;
    }

    setAskUserProvider(provider: AskUserProvider): void {
        this._askUserProvider = provider;
    }

    setExitPlanModeProvider(provider: ExitPlanModeProvider): void {
        this._exitPlanModeProvider = provider;
    }

    async fetch(input: string | URL, init?: RequestInit, options?: PlatformFetchOptions): Promise<Response> {
        const url = input instanceof URL ? input.href : input;
        const globalSkipTlsVerification = Setting.getInstance().getData().network_config.no_ssl;
        return fetchWithResolvedProxy(url, init, {
            useEnvironmentProxy: !options?.bypassProxy,
            bypassProxy: options?.bypassProxy,
            skipTlsVerification: globalSkipTlsVerification || options?.skipTlsVerification
        });
    }

    async openPath(filePath: string): Promise<void> {
        await this._openWithSystem('openPath', filePath);
    }

    async openExternal(url: string): Promise<void> {
        await this._openWithSystem('openExternal', url);
    }

    async showItemInFolder(filePath: string): Promise<void> {
        await this._openWithSystem('showItemInFolder', filePath);
    }

    private _canOpenWithSystem(): boolean {
        return (process.platform as string) !== 'openharmony';
    }

    /**
     * 把目标交给系统默认处理器打开。target 可能携带用户或 AI 生成的路径 / URL，
     * 必须作为单个参数传给真实可执行文件，绝不能经 shell 拼接命令字符串，
     * 否则其中的引号 / & / $() 等元字符会构成命令注入（GitCode issue #188）。
     */
    private async _openWithSystem(
        kind: 'openPath' | 'openExternal' | 'showItemInFolder',
        target: string
    ): Promise<void> {
        if (!this._canOpenWithSystem()) return;
        if (process.platform === 'win32') {
            // 与 start 同为 ShellExecute 语义，但 explorer.exe 是普通可执行文件，target 作为单个
            // 参数传入不经 cmd 解析；而 start 是 cmd 内建命令，含双引号的 target 可逃逸引号注入命令。
            // explorer 即便成功派发也常以退出码 1 结束，因此 spawn 成功即返回，不等待退出。
            await new Promise<void>((resolve, reject) => {
                const child = spawn('explorer.exe', [kind === 'showItemInFolder' ? `/select,${target}` : target], {
                    stdio: 'ignore',
                    windowsHide: true,
                    shell: false
                });
                const onError = (error: Error): void => reject(error);
                child.once('error', onError);
                child.once('spawn', () => {
                    child.removeListener('error', onError);
                    child.unref();
                    resolve();
                });
            });
            return;
        }
        if (process.platform === 'darwin') {
            await execFileAsync('open', kind === 'showItemInFolder' ? ['-R', target] : [target], { windowsHide: true });
            return;
        }
        await execFileAsync('xdg-open', [target], { windowsHide: true });
    }

    async initPlatformHarness(task: TaskState): Promise<void> {
        task.harnessContext.permissionPrompt = this._permissionPromptProvider;
        task.interactionToolset = this.createInteractionToolset(task);
    }

    createInteractionToolset(_task: TaskState): InteractiveToolset | null {
        if (!this._askUserProvider) return null;
        return createInteractionToolset(this._askUserProvider, this._exitPlanModeProvider ?? undefined);
    }

    // 返回元素类型按 ApplicationClass（无参可构造 + 静态成员同 BaseApplication）声明：
    // 注册表统一以 `new ApplicationClass()` 实例化，而各应用构造签名并不统一
    // （如 AcpMgrApplication 接收 dependencies 对象），`typeof BaseApplication`
    // 的完整构造签名过窄。
    getApplicationClasses(): ApplicationClass[] {
        return [
            MobileAccessApplication,
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            SearchApplication,
            TerminalApplication,
            McpMgrApplication,
            AcpMgrApplication,
            TodoMgrApplication,
            SkillMgrApplication,
            PluginMgrApplication,
            AppMgrApplication,
            ChannelMgrApplication,
            KnowledgeBaseApplication,
            DeviceMgrApplication,
            BuiltinApplication,
            AgentOfficeApplication
        ];
    }
}
