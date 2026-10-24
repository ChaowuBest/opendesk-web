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

export const ADMIN_CONSOLE_SKILL = `
---
name: admin
description: OpenDesk 官网管理后台：查询最近提交的用户需求与缺陷反馈、查看完整详情、下载反馈附件，用于自动分析用户反馈与调试排障
---

# OpenDesk 管理后台

本技能提供 OpenDesk 官网管理后台（opendesk.matrix.openharmony.cn）的数据查询能力，
需求（feature）与缺陷（bug）同源，均为用户提交的反馈记录，按 type 区分。

可用能力：
- listRecentRequirements(limit, offset)：分页列出用户需求（feature 类型反馈），按时间倒序，响应含 total 总数
- getRequirementDetails(id)：按 id 查看某条需求的完整详情（正文、联系方式、附件清单）
- listRecentBugs(limit, offset)：分页列出用户缺陷反馈（bug 类型），按时间倒序，响应含 total 总数
- getBugDetails(id)：按 id 查看某条缺陷的完整详情（正文、联系方式、附件清单）
- downloadAttachment(attachmentId, path)：把附件下载到本地路径，便于分析用户回传的日志/截图

典型工作流（分析用户反馈）：
1. 用 listRecentBugs / listRecentRequirements 拉取最近的反馈列表，挑选要处理的问题；
   需要更早的记录时用 offset 翻页（offset += limit，直到取满 total）；
2. 用 getBugDetails / getRequirementDetails 查看正文与 attachments 中的 attachment_id；
3. 需要附件（如用户日志）时，用 downloadAttachment 下载到工作区路径后再读取分析。

注意：
- 所有接口需要管理后台已配置并校验通过 admin token，未授权时调用会返回 unauthorized；
- downloadAttachment 写入目标路径需要 file/write 权限，会先经权限审批。
`;
