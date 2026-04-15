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

export class CliPlatform extends AbstractPlatform {
    getName(): string {
        return 'cli';
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
            DeviceMgrApplication
        ];
    }
}
