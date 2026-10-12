import assert from 'node:assert/strict';
import test from 'node:test';
import { setRuntimeLocale } from '../../../../locale/index.js';
import { buildFlowTaskPrompt } from '../../../../main/applications/agentoffice/app.js';
import type { FlowHistorySnapshot } from '../../../../main/applications/agentoffice/flow/context.js';
import { t } from '../../../../main/applications/agentoffice/locale/index.js';
import { createAgentOfficeTaskToolset } from '../../../../main/applications/agentoffice/tools.js';

const snapshot: FlowHistorySnapshot = {
    flow: {
        schemaVersion: 1,
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        name: '模拟结果交接',
        goal: '提取、判断、建议',
        status: 'active',
        memberIds: [],
        members: [],
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z'
    },
    messages: [],
    messageRefs: {}
};

for (const locale of ['zh-CN', 'en-US']) {
    test(`${locale}: group and single-chat tools keep localized display names and their own descriptions`, () => {
        setRuntimeLocale(locale);
        for (const flowReply of [false, true]) {
            const toolset = createAgentOfficeTaskToolset({
                flowReply,
                sendReply: async () => {},
                getHistory: async () => ({ messages: [] })
            });
            const reply = toolset.getTool('sendReply')!;
            const history = toolset.getTool('getHistoryMessages')!;
            assert.equal(reply.getResolvedDisplayName(locale), locale === 'zh-CN' ? '发送回复' : 'Send Reply');
            assert.equal(history.getResolvedDisplayName(locale), locale === 'zh-CN' ? '历史消息' : 'History Messages');
            assert.equal(
                reply.toJSON().description,
                t(flowReply ? 'agentoffice.flow.tool.sendReplyDescription' : 'agentoffice.tool.sendReply.description')
            );
            assert.equal(
                history.toJSON().description,
                t(flowReply ? 'agentoffice.flow.tool.historyDescription' : 'agentoffice.tool.getHistory.description')
            );
        }
    });

    test(`${locale}: app prompt includes all 205 messages and long bodies without a recent-message cap`, () => {
        setRuntimeLocale(locale);
        const messages: FlowHistorySnapshot['messages'] = Array.from({ length: 205 }, (_, index) => ({
            id: `fixture-${index}`,
            flowId: snapshot.flow.id,
            sequence: index + 1,
            sender: { type: 'user' },
            kind: 'message',
            mentions: [],
            content: [{ type: 'text', text: `BEGIN-${index}|${'完整正文'.repeat(100)}|END-${index}` }],
            createdAt: '2026-10-02T00:00:00.000Z'
        }));
        const history = {
            ...snapshot,
            messages,
            messageRefs: Object.fromEntries(messages.map((m) => [m.id, `m${m.sequence}`]))
        };
        const prompt = buildFlowTaskPrompt(
            history,
            { name: '员工', title: '分析', specialties: [], agents_md: '' },
            [messages[0].id, messages[204].id],
            '/fixture'
        );
        assert.ok(prompt.length > 32000);
        for (const message of messages) {
            const text = message.content[0];
            assert.equal(text.type, 'text');
            if (text.type === 'text') assert.equal(prompt.split(text.text).length - 1, 1);
        }
        assert.ok(prompt.includes('"unreadMessageRefs":["m1","m205"]'));
        assert.equal(prompt.includes('fixture-0'), false);
    });

    test(`${locale}: rendered group prompt, system rule and reply tool all require silent dependencies and snapshot awareness`, () => {
        setRuntimeLocale(locale);
        const toolset = createAgentOfficeTaskToolset({
            flowReply: true,
            sendReply: async () => {},
            getHistory: async () => ({ messages: [] })
        });
        const prompt = buildFlowTaskPrompt(
            snapshot,
            {
                name: '分析员',
                title: '分析',
                specialties: [],
                agents_md: '根据上游结果分析。'
            },
            [],
            '/fixture/read-only'
        );
        const channels = [
            prompt,
            t('agentoffice.flow.task.systemRule'),
            toolset.getTool('sendReply')!.toJSON().description
        ];
        for (const channel of channels) {
            if (locale === 'zh-CN') {
                assert.match(channel, /上游产物尚未到达时静默完成/);
                assert.match(channel, /冻结快照/);
                assert.match(channel, /不要纠正.*时间线/);
                assert.match(channel, /需要用户.*决策/);
                assert.doesNotMatch(channel, /一次明确依赖|等待他人产物可说明一次/);
            } else {
                assert.match(channel, /Finish silently when an upstream deliverable is missing/);
                assert.match(channel, /frozen snapshots/);
                assert.match(channel, /Do not correct.*timelines/);
                assert.match(channel, /requires a user decision/);
                assert.doesNotMatch(channel, /one specific dependency|You may explain once/);
            }
        }
    });

    test(`${locale}: valuable results containing waiting words and single-chat replies remain supported`, async () => {
        setRuntimeLocale(locale);
        let delivered: string | undefined;
        const tools = createAgentOfficeTaskToolset({
            flowReply: true,
            sendReply: async (text) => {
                delivered = text;
            },
            getHistory: async () => ({ messages: [] })
        });
        const result = '实测结果：队列等待时间从 10 秒降至 2 秒。Measured waiting time fell from 10s to 2s.';
        assert.equal((await tools.getTool('sendReply')!.execute({ text: result, replyTo: 'm1' })).status, 'success');
        assert.equal(delivered, result);
        const single = createAgentOfficeTaskToolset({
            sendReply: async () => {},
            getHistory: async () => ({ messages: [] })
        });
        assert.equal(single.getTool('sendReply')!.toJSON().description, t('agentoffice.tool.sendReply.description'));
        assert.notEqual(
            single.getTool('sendReply')!.toJSON().description,
            tools.getTool('sendReply')!.toJSON().description
        );
    });
}

test.after(() => setRuntimeLocale(null));
