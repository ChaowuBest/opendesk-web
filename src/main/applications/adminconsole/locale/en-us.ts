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
    'app.name': 'Admin Console',
    'tool.listRecentRequirements.name': 'List Requirements',
    'tool.listRecentRequirements.desc':
        'Page through user requirements (feature-type feedback) from the OpenDesk admin console, newest first; ' +
        'each item has id, content, contact, time and attachments. The response includes the total count for ' +
        'offset-based pagination. Requires an authorized admin token.',
    'tool.getRequirementDetails.name': 'Requirement Details',
    'tool.getRequirementDetails.desc':
        'Get full details of one user requirement (feature-type feedback) by id, including content and attachment ' +
        'metadata (attachment_id, filename), regardless of list pagination range. The id comes from listRecentRequirements.',
    'tool.listRecentBugs.name': 'List Bugs',
    'tool.listRecentBugs.desc':
        'Page through user bug feedback (bug-type) from the OpenDesk admin console, newest first; each item has ' +
        'id, content, contact, time and attachments. The response includes the total count for offset-based ' +
        'pagination. Requires an authorized admin token.',
    'tool.getBugDetails.name': 'Bug Details',
    'tool.getBugDetails.desc':
        'Get full details of one user bug feedback by id, including content and attachment metadata ' +
        '(attachment_id, filename), regardless of list pagination range. The id comes from listRecentBugs.',
    'tool.downloadAttachment.name': 'Download Attachment',
    'tool.downloadAttachment.desc':
        'Download a feedback attachment by attachment_id to a local path (absolute or workspace-relative); ' +
        'missing parent directories are created automatically. Writing the target path requires file/write ' +
        'permission and goes through permission approval first; attachment_id comes from the attachments field ' +
        'of list or detail results.'
};
