export const STOP_RUN_TOKEN = 'rt1_3YtHhT1g7w4a8mFJQhR3zG2x5c6n9p0sVbKdLeNuWqE';

export const sessionStopVectors = {
    runningInfo: {
        schemaVersion: 1,
        cwd: '/work',
        taskStatus: 'running',
        completionStatus: null,
        runToken: STOP_RUN_TOKEN
    },
    stoppedInfo: {
        schemaVersion: 1,
        cwd: '/work',
        taskStatus: 'stopped',
        completionStatus: null,
        runToken: null
    },
    cancel: {
        sessionId: 's1',
        _meta: {
            opendesk: {
                schemaVersion: 1,
                runToken: STOP_RUN_TOKEN
            }
        }
    }
} as const;
