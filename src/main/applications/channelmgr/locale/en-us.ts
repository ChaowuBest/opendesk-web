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

export const enUs: Record<string, string> = {
    'app.name': 'Channels',
    'channel.event.connected': 'Channel connected',
    'channel.event.disconnected': 'Channel disconnected',
    'channel.event.message': 'Channel message received',
    'channel.event.contactsUpdated': 'Channel contacts updated',
    'channel.event.error': 'Channel error',
    'channel.event.loginStatus': 'Channel QR login progress',
    'channel.event.interaction': 'Channel user interaction (permission/ask)',
    'channel.permission.approvalTitle': 'Permission confirmation',
    'channel.permission.confirm': 'Allow',
    'channel.permission.deny': 'Deny',
    'channel.permission.askTitle': 'Question',
    'channel.permission.cancelAsk': 'Cancel',
    'channel.command.newSessionStarted': 'Started a new session. Your next message will go to a new task',
    'channel.command.executeFailed': 'Command failed',
    'channel.command.listHeader': 'Recent conversations',
    'channel.command.listHint':
        'Tip: send /list N to view up to N recent conversations (max 100); send /switch <index> to switch to a conversation',
    'channel.command.switchedTo': 'Successfully switched to task: ',
    'channel.command.listEmpty': 'No conversations to switch to yet',
    'channel.command.listCurrentMark': ' (current)',
    'channel.command.invalidSwitchIndex': 'Invalid index. Run /list first to see available conversations',
    'channel.command.invalidSwitchTarget': 'That conversation no longer exists. Run /list again',
    'channel.task.unnamed': 'Unnamed task'
};
