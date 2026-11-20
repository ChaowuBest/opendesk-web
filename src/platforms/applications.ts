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

import type { BaseApplication } from '../main/applications/base.js';
import { MailboxApplication } from '../main/applications/mailbox/app.js';
import { FileMgrApplication } from '../main/applications/filemgr/app.js';
import { CalendarApplication } from '../main/applications/calendar/app.js';
import { BrowserApplication } from '../main/applications/browser/app.js';
import { SearchApplication } from '../main/applications/search/app.js';
import { TerminalApplication } from '../main/applications/terminal/app.js';
import { SkillMgrApplication } from '../main/applications/skillmgr/app.js';
import { McpMgrApplication } from '../main/applications/mcpmgr/app.js';
import { TodoMgrApplication } from '../main/applications/todomgr/app.js';
import { ChannelMgrApplication } from '../main/applications/channelmgr/app.js';
import { KnowledgeBaseApplication } from '../main/applications/knowledgebase/app.js';
import { DeviceMgrApplication } from '../main/applications/devicemgr/app.js';
import { BuiltinApplication } from '../main/applications/builtin/app.js';
import { NotesApplication } from '../main/applications/notes/app.js';
import { AppMgrApplication } from '../main/applications/appmgr/app.js';
import { AgentGateApplication } from '../main/applications/agentgate/app.js';
import { AdminConsoleApplication } from '../main/applications/adminconsole/app.js';
import { AgentOfficeApplication } from '../main/applications/agentoffice/app.js';
import { AcpMgrApplication } from '../main/applications/acpmgr/app.js';
import { WorkflowMgrApplication } from '../main/applications/workflowMgr/app.js';
import { PluginMgrApplication } from '../main/applications/pluginmgr/app.js';
import { BenchmarkApplication } from '../main/applications/benchmark/app.js';

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

/** Common GUI applications; native-only providers may append their own applications. */
export function getGuiApplicationClasses(): ApplicationClass[] {
    return [
        MailboxApplication,
        FileMgrApplication,
        CalendarApplication,
        NotesApplication,
        BrowserApplication,
        SearchApplication,
        TerminalApplication,
        SkillMgrApplication,
        PluginMgrApplication,
        AppMgrApplication,
        McpMgrApplication,
        AcpMgrApplication,
        TodoMgrApplication,
        ChannelMgrApplication,
        KnowledgeBaseApplication,
        DeviceMgrApplication,
        BuiltinApplication,
        AgentGateApplication,
        AdminConsoleApplication,
        AgentOfficeApplication,
        WorkflowMgrApplication,
        BenchmarkApplication
    ];
}
