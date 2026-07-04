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
