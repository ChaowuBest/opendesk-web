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

export function isGoalRunningInput(taskStatus, goalStatus) {
    return taskStatus === 'running' && goalStatus === 'active';
}

export function canSubmitAsGoalSupplement(taskStatus, goalStatus, detail) {
    return isGoalRunningInput(taskStatus, goalStatus) && isTextOnlyGoalSupplementDetail(detail);
}

export function isTextOnlyGoalSupplementDetail(detail) {
    return (
        typeof detail?.message === 'string' &&
        detail.message.trim().length > 0 &&
        (detail.attachedFilePaths?.length ?? 0) === 0 &&
        (detail.attachedImages?.length ?? 0) === 0
    );
}

export function getGoalSummaryFromStatusResult(result) {
    const statusView = result?.data?.summary ? result.data : result;
    return statusView?.summary;
}
