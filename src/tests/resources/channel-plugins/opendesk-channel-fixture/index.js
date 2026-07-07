const CHANNEL_ID = 'opendesk-test-channel';
const ACCOUNT_ID = 'fixture-account';

export function register(api) {
    api.registerChannel({
        id: CHANNEL_ID,
        meta: {
            label: 'OpenDesk Fixture Channel',
            description: 'Local no-network channel fixture for pi-tui migration E2E'
        },
        capabilities: {
            chatTypes: ['direct'],
            media: false,
            threading: false,
            reactions: false,
            editing: false,
            mentionGating: false
        },
        config: {
            listAccountIds: () => [ACCOUNT_ID],
            resolveAccount: () => ({
                accountId: ACCOUNT_ID,
                displayName: 'Fixture Account'
            }),
            defaultAccountId: () => ACCOUNT_ID,
            isConfigured: async () => true
        },
        outbound: {
            deliveryMode: 'direct',
            sendText: async ({ text }) => ({
                ok: true,
                messageId: `fixture-${Date.now()}`,
                text
            })
        },
        status: {
            buildChannelSummary: async () => ({
                channelId: CHANNEL_ID,
                accountId: ACCOUNT_ID,
                online: true,
                statusText: 'fixture-ready',
                accountName: 'Fixture Account'
            })
        }
    });
}

export default { register };
