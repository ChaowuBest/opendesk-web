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
    'app.name': '管理后台',
    'tool.listRecentRequirements.name': '列出最近需求',
    'tool.listRecentRequirements.desc':
        '从 OpenDesk 官网管理后台分页拉取用户需求（feature 类型反馈）列表，按提交时间倒序返回，' +
        '每条含 id、content、contact、time 与 attachments 清单；响应含 total 总条数，可用 offset 翻页。' +
        '需要已完成管理令牌授权。',
    'tool.getRequirementDetails.name': '需求详情',
    'tool.getRequirementDetails.desc':
        '按 id 查询单条用户需求（feature 类型反馈）的完整详情，含正文与附件元信息（attachment_id、filename），' +
        '不受列表分页范围限制。id 取自 listRecentRequirements 结果。',
    'tool.listRecentBugs.name': '列出最近缺陷',
    'tool.listRecentBugs.desc':
        '从 OpenDesk 官网管理后台分页拉取用户缺陷反馈（bug 类型）列表，按提交时间倒序返回，' +
        '每条含 id、content、contact、time 与 attachments 清单；响应含 total 总条数，可用 offset 翻页。' +
        '需要已完成管理令牌授权。',
    'tool.getBugDetails.name': '缺陷详情',
    'tool.getBugDetails.desc':
        '按 id 查询单条用户缺陷反馈（bug 类型）的完整详情，含正文与附件元信息（attachment_id、filename），' +
        '不受列表分页范围限制。id 取自 listRecentBugs 结果。',
    'tool.downloadAttachment.name': '下载附件',
    'tool.downloadAttachment.desc':
        '将指定 attachment_id 的反馈附件下载到本地路径（绝对路径或相对工作区路径），目标目录不存在时自动创建。' +
        '写入目标路径需要 file/write 权限，会先经权限审批；attachment_id 取自列表或详情结果的 attachments 字段。'
};
