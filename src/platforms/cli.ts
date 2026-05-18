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

import { AbstractPlatform } from './base';
import { BaseApplication } from '../main/applications/base';
import type { TaskState } from '../main/aikernel/states/tasks.js';
import type { PermissionPromptProvider } from '../main/aikernel/security/permission.js';
import type { AskUserProvider } from '../main/aikernel/interaction/tools.js';
import { createInteractionToolset } from '../main/aikernel/interaction/tools.js';
import type { ExitPlanModeProvider } from '../main/aikernel/interaction/exitPlanMode.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { resolveProxyUrl } from '../main/utils/proxy.js';

import { MailboxApplication } from '../main/applications/mailbox/app.js';
import { FileMgrApplication } from '../main/applications/filemgr/app.js';
import { CalendarApplication } from '../main/applications/calendar/app.js';
import { SearchApplication } from '../main/applications/search/app';
import { NewsApplication } from '../main/applications/news/app.js';
import { TerminalApplication } from '../main/applications/terminal/app.js';
import { McpMgrApplication } from '../main/applications/mcpmgr/app.js';
import { TodoMgrApplication } from '../main/applications/todomgr/app.js';
import { SkillMgrApplication } from '../main/applications/skillmgr/app.js';
import { ChannelMgrApplication } from '../main/applications/channelmgr/app.js';
import { KnowledgeBaseApplication } from '../main/applications/knowledgebase/app.js';
import { DeviceMgrApplication } from '../main/applications/devicemgr/app.js';
import { BuiltinApplication } from '../main/applications/builtin/app.js';

export class CliPlatform extends AbstractPlatform {
    private _workspace: string = process.cwd();
    private _permissionPromptProvider: PermissionPromptProvider | null = null;
    private _askUserProvider: AskUserProvider | null = null;
    private _exitPlanModeProvider: ExitPlanModeProvider | null = null;

    getName(): string {
        return 'cli';
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

    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        const proxyUrl = await resolveProxyUrl();
        const fetchOpts: any = { ...init };
        if (proxyUrl) {
            fetchOpts.dispatcher = new ProxyAgent(proxyUrl);
        }
        const url = input instanceof URL ? input.href : input;
        return undiciFetch(url, fetchOpts) as unknown as Response;
    }

    async initPlatformHarness(task: TaskState): Promise<void> {
        task.harnessContext.permissionPrompt = this._permissionPromptProvider;
        if (this._askUserProvider) {
            task.interactionToolset = createInteractionToolset(
                this._askUserProvider,
                this._exitPlanModeProvider ?? undefined
            );
        }
    }

    getApplicationClasses(): (typeof BaseApplication)[] {
        return [
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            SearchApplication,
            NewsApplication,
            TerminalApplication,
            McpMgrApplication,
            TodoMgrApplication,
            SkillMgrApplication,
            ChannelMgrApplication,
            KnowledgeBaseApplication,
            DeviceMgrApplication,
            BuiltinApplication
        ];
    }
}
