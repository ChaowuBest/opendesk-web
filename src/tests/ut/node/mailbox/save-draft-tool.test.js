import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApplicationRegistry } from '../../../../main/applications/registry.ts';
import { SaveDraftTool } from '../../../../main/applications/mailbox/tools.ts';

function parseResult(result) {
    return JSON.parse(result.result ?? '{}');
}

async function withWorkerStub(stub, run) {
    const originalCallWorker = ApplicationRegistry.callWorker;
    const calls = [];
    ApplicationRegistry.callWorker = async (...args) => {
        calls.push(args);
        return stub(...args);
    };
    try {
        await run(calls);
    } finally {
        ApplicationRegistry.callWorker = originalCallWorker;
    }
}

test('saveDraft maps recipients and content to the worker payload', async () => {
    await withWorkerStub(
        async () => ({ status: 'ok', data: 'draft_123' }),
        async (calls) => {
            const tool = new SaveDraftTool();
            const result = await tool.execute({
                to: ['alice@example.com'],
                cc: 'bob@example.com',
                subject: '会议通知',
                content: '明天下午三点开会\n请准时参加'
            });

            assert.deepEqual(calls, [
                [
                    'mailbox',
                    'saveDraft',
                    {
                        uid: undefined,
                        to: ['alice@example.com'],
                        cc: ['bob@example.com'],
                        bcc: undefined,
                        subject: '会议通知',
                        text: '明天下午三点开会\n请准时参加',
                        html: '明天下午三点开会<br>请准时参加',
                        attachments: []
                    }
                ]
            ]);
            assert.deepEqual(parseResult(result), {
                success: true,
                uid: 'draft_123',
                message: '草稿已保存到草稿箱'
            });
        }
    );
});

test('saveDraft allows an incomplete draft without recipients, subject or content', async () => {
    await withWorkerStub(
        async () => ({ status: 'ok', data: 'draft_empty' }),
        async (calls) => {
            const tool = new SaveDraftTool();
            const result = await tool.execute({});

            assert.deepEqual(calls[0][2], {
                uid: undefined,
                to: [],
                cc: undefined,
                bcc: undefined,
                subject: '',
                text: '',
                html: '',
                attachments: []
            });
            assert.equal(parseResult(result).success, true);
        }
    );
});

test('saveDraft updates an existing draft when uid is provided', async () => {
    await withWorkerStub(
        async () => ({ status: 'ok', data: 'draft_existing' }),
        async (calls) => {
            const tool = new SaveDraftTool();
            await tool.execute({ uid: 'draft_existing', subject: '更新后的主题' });

            assert.equal(calls[0][2].uid, 'draft_existing');
            assert.equal(calls[0][2].subject, '更新后的主题');
        }
    );
});

test('saveDraft resolves attachment paths into filename/path objects', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-save-draft-'));
    const attachment = path.join(directory, 'report.txt');
    fs.writeFileSync(attachment, 'report', 'utf8');

    try {
        await withWorkerStub(
            async () => ({ status: 'ok', data: 'draft_attachment' }),
            async (calls) => {
                const tool = new SaveDraftTool();
                await tool.execute({ subject: '带附件', content: '见附件', attachments: [attachment] });

                assert.deepEqual(calls[0][2].attachments, [{ filename: 'report.txt', path: attachment }]);
            }
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('saveDraft reports a missing attachment without saving the draft', async () => {
    await withWorkerStub(
        async () => ({ status: 'ok', data: 'unused' }),
        async (calls) => {
            const tool = new SaveDraftTool();
            const result = await tool.execute({ subject: '坏附件', attachments: ['/not/exist/report.txt'] });

            assert.equal(calls.length, 0);
            assert.deepEqual(parseResult(result), {
                success: false,
                error: '附件文件不存在: /not/exist/report.txt'
            });
        }
    );
});

test('saveDraft reports worker failures as an unsuccessful result', async () => {
    await withWorkerStub(
        async () => {
            throw new Error('No active profile');
        },
        async () => {
            const tool = new SaveDraftTool();
            const result = await tool.execute({ subject: '失败草稿' });

            assert.deepEqual(parseResult(result), { success: false, error: 'No active profile' });
        }
    );
});