export const interactionVectors = {
    capability: {
        schemaVersion: 1,
        askUser: 1,
        exitPlanMode: 1,
        permission: 1,
        closed: 1
    },
    ask: {
        request: {
            schemaVersion: 1,
            requestId: 'ask-1',
            sessionId: 'root-1',
            taskId: 'child-1',
            taskName: 'Refactor API',
            expiresAt: 1_777_777_777_000,
            questions: [
                {
                    question: 'Choose API?',
                    header: 'API',
                    multiple: false,
                    options: [
                        { label: 'REST', description: 'Use REST endpoints' },
                        { label: 'GraphQL', description: 'Use a GraphQL endpoint' }
                    ]
                }
            ]
        },
        answer: {
            answers: { 0: ['REST'] }
        }
    },
    exit: {
        request: {
            schemaVersion: 1,
            requestId: 'exit-1',
            sessionId: 'root-1',
            taskId: 'child-1',
            taskName: 'Refactor API',
            expiresAt: 1_777_777_777_000,
            planRelativePath: '.plan/refactor.md',
            planContent: '# Plan\nComplete content'
        },
        answer: {
            schemaVersion: 1,
            requestId: 'exit-1',
            action: 'execute-standard'
        }
    },
    permission: {
        request: {
            sessionId: 'root-1',
            toolCall: {
                toolCallId: '8abf53ac-e58f-4aa6-9d56-8bc4d090640f',
                title: 'shell',
                kind: 'other',
                status: 'pending',
                locations: []
            },
            options: [
                { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'allow-prefix-0', name: 'Always allow /workspace', kind: 'allow_always' },
                { optionId: 'allow-type', name: 'Always allow shell', kind: 'allow_always' },
                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
            ],
            _meta: {
                opendesk: {
                    schemaVersion: 1,
                    interactionType: 'permission',
                    requestId: 'permission-1',
                    taskId: 'child-1',
                    taskName: 'Refactor API'
                }
            }
        },
        answer: {
            schemaVersion: 1,
            requestId: 'permission-1',
            optionId: 'allow-once'
        }
    },
    closed: {
        schemaVersion: 1,
        requestId: 'ask-1',
        sessionId: 'root-1',
        interactionType: 'askUser',
        status: 'superseded'
    }
} as const;
