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

export const zhCn: Record<string, string> = {
    'app.name': '消息频道',
    'channel.event.connected': '渠道连接成功',
    'channel.event.disconnected': '渠道连接断开',
    'channel.event.message': '渠道收到消息',
    'channel.event.contactsUpdated': '渠道联系人更新',
    'channel.event.error': '渠道错误',
    'channel.event.loginStatus': '渠道扫码登录进度',
    'channel.event.interaction': '渠道用户交互（权限审批/提问）',
    'channel.permission.approvalTitle': '权限确认',
    'channel.permission.confirm': '允许',
    'channel.permission.deny': '拒绝',
    'channel.permission.askTitle': '向你提问',
    'channel.permission.cancelAsk': '取消提问',
    'channel.command.newSessionStarted': '已开启新会话，下一条消息将进入新任务',
    'channel.command.executeFailed': '命令执行失败',
    'channel.command.listHeader': '最近的对话',
    'channel.command.listHint':
        '提示：发送 /list N 可查看最近 N 条对话（最多 100）；发送 /switch 编号 可切换到对应对话',
    'channel.command.switchedTo': '成功切换到任务：',
    'channel.command.listEmpty': '暂无可切换的历史对话',
    'channel.command.listCurrentMark': '（当前）',
    'channel.command.invalidSwitchIndex': '无效的编号，请先用 /list 查看可切换的对话',
    'channel.command.invalidSwitchTarget': '该对话已不存在，请重新执行 /list',
    'channel.task.unnamed': '未命名任务'
};
