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

import { BaseApplication } from '../base';
import { t } from './locale/index.js';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { MailboxConfigSchema } from './common.js'; // 引入新的 Schema
import { logger } from '../../utils/logger.js';
import MailboxWorker from './service/worker';
import { MANAGE_MAILBOX_SKILL, OPERATE_MAILBOX_SKILL } from './skills';
import {
    AddMailAccountTool,
    ListMailAccountsTool,
    RemoveMailAccountTool,
    SwitchMailAccountTool,
    GetMailSyncStatusTool,
    GetEmailListTool,
    GetEmailContentTool,
    SearchEmailsTool,
    SendEmailTool,
    ReplyEmailTool,
    MarkEmailReadTool,
    StarEmailTool,
    DeleteEmailTool
} from './tools';
import { MailOverlay } from './tui.js';
import chalk from 'chalk';

class MailboxApplication extends BaseApplication {
    constructor() {
        super('mailbox');
    }

    getName() {
        return t('app.name');
    }

    needAgentBar() {
        return true;
    }

    async getTUIStatusBlock() {
        try {
            const [accountsRes, countsRes] = await Promise.allSettled([
                this.callWorker('getAccountList'),
                this.callWorker('getAllNewEmailCounts')
            ]);
            const accounts =
                accountsRes.status === 'fulfilled' && accountsRes.value?.status === 'ok'
                    ? accountsRes.value.data || []
                    : [];
            const counts =
                countsRes.status === 'fulfilled' && countsRes.value?.status === 'ok' ? countsRes.value.data || {} : {};
            const totalUnread = Object.values(counts).reduce((s, n) => s + n, 0);

            if (accounts.length === 0) return null;
            if (totalUnread > 0) {
                return `📬 ${chalk.hex('#FFAB00')(`${totalUnread} 封新邮件`)}`;
            }
            return null;
        } catch {
            return null;
        }
    }

    static getWorkerClass() {
        return MailboxWorker;
    }

    // 【重要】这里必须返回包含 profiles 数组的 Schema
    static getConfigSchema() {
        return MailboxConfigSchema;
    }

    onConfigChanged() {
        logger.info(`mailbox application config changed`);
    }

    onEmailListUpdated() {
        this.noticeTUIStatusUpdate();
    }

    async getSkills() {
        const manageSkill = Skill.parseMd(MANAGE_MAILBOX_SKILL);
        const manageToolset = new BaseToolset('mailbox-manage');
        manageToolset.addTool(new AddMailAccountTool(this));
        manageToolset.addTool(new ListMailAccountsTool(this));
        manageToolset.addTool(new RemoveMailAccountTool(this));
        manageToolset.addTool(new SwitchMailAccountTool(this));
        manageToolset.addTool(new GetMailSyncStatusTool());
        manageSkill.toolsets = [manageToolset];

        const operateSkill = Skill.parseMd(OPERATE_MAILBOX_SKILL);
        const operateToolset = new BaseToolset('mailbox-operate');
        operateToolset.addTool(new GetEmailListTool());
        operateToolset.addTool(new GetEmailContentTool());
        operateToolset.addTool(new SearchEmailsTool());
        operateToolset.addTool(new SendEmailTool());
        operateToolset.addTool(new ReplyEmailTool());
        operateToolset.addTool(new MarkEmailReadTool());
        operateToolset.addTool(new StarEmailTool());
        operateToolset.addTool(new DeleteEmailTool());
        operateSkill.toolsets = [operateToolset];

        return [manageSkill, operateSkill];
    }

    async getSupportedEvents() {
        return [
            {
                eventName: 'newEmailCountsUpdated',
                eventDescription: '新邮件数量更新（各账户未读邮件计数发生变化时触发）'
            },
            {
                eventName: 'emailListUpdated',
                eventDescription: '当前账户的邮件列表已更新（收到新邮件或同步完成时触发）'
            },
            {
                eventName: 'accountsUpdated',
                eventDescription: '邮箱账户列表已更新（账户增删或配置重载时触发）'
            }
        ];
    }

    /**
     * 获取邮箱应用提供的 CLI 斜杠命令
     * @param tui TUI 实例
     * @returns SlashCommandHandler 数组
     */
    getCliSlashCommands(tui) {
        return [
            {
                name: 'mail',
                description: '打开邮箱',
                execute: async () => {
                    try {
                        const mailOverlay = new MailOverlay(tui);
                        await mailOverlay.show();
                    } catch (err) {
                        logger.error(`打开邮箱失败: ${err}`);
                    }
                }
            }
        ];
    }
}

export { MailboxApplication };
