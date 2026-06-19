import { QuestionRoutes } from '../../../main/server/opencode/routes/question.js';
import { ServerQuestionBroker } from '../../../main/server/opencode/question-broker.js';

describe('opencode question routes', () => {
    let broker: ServerQuestionBroker;

    beforeEach(() => {
        broker = new ServerQuestionBroker();
    });

    afterEach(() => {
        broker.dispose();
    });

    test('lists pending question requests', async () => {
        void broker.prompt({
            requestId: 'ask_1',
            taskId: 'task_abc',
            taskName: 'test',
            workspace: 'D:/repo',
            questions: [
                {
                    question: 'Which mode should be used?',
                    header: 'Mode',
                    options: [
                        { label: 'Fast', description: 'Use the faster path' },
                        { label: 'Safe', description: 'Use the safer path' }
                    ],
                    multiple: false
                }
            ]
        });

        const response = await QuestionRoutes(broker).request('/question');
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({
            sessionID: 'ses_abc',
            questions: [
                {
                    question: 'Which mode should be used?',
                    header: 'Mode',
                    custom: true,
                    options: [
                        { label: 'Fast', description: 'Use the faster path' },
                        { label: 'Safe', description: 'Use the safer path' }
                    ]
                }
            ]
        });
        expect(body[0].id).toMatch(/^que_/);
    });

    test('resolves reply answers', async () => {
        const prompt = broker.prompt({
            requestId: 'ask_1',
            taskId: 'task_abc',
            taskName: null,
            questions: [
                {
                    question: 'Pick one',
                    header: 'Pick',
                    options: [
                        { label: 'A', description: 'Option A' },
                        { label: 'B', description: 'Option B' }
                    ]
                }
            ]
        });
        const request = broker.list()[0];

        const response = await QuestionRoutes(broker).request(`/question/${request.id}/reply`, {
            method: 'POST',
            body: JSON.stringify({ answers: [['A']] }),
            headers: { 'content-type': 'application/json' }
        });

        await expect(prompt).resolves.toEqual({ answers: { 0: ['A'] } });
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(broker.list()).toEqual([]);
    });

    test('resolves reject as cancelled askUser response', async () => {
        const prompt = broker.prompt({
            requestId: 'ask_1',
            taskId: 'task_abc',
            taskName: null,
            questions: [
                {
                    question: 'Pick one',
                    header: 'Pick',
                    options: [
                        { label: 'A', description: 'Option A' },
                        { label: 'B', description: 'Option B' }
                    ]
                }
            ]
        });
        const request = broker.list()[0];

        const response = await QuestionRoutes(broker).request(`/question/${request.id}/reject`, {
            method: 'POST'
        });

        await expect(prompt).resolves.toEqual({ cancelled: true, answers: {} });
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(broker.list()).toEqual([]);
    });

    test('returns opencode not-found error shape for missing question reply', async () => {
        const response = await QuestionRoutes(broker).request('/question/que_missing/reply', {
            method: 'POST',
            body: JSON.stringify({ answers: [['A']] }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            _tag: 'QuestionNotFoundError',
            requestID: 'que_missing',
            message: 'Question request not found: que_missing'
        });
    });

    test('returns opencode not-found error shape for missing question reject', async () => {
        const response = await QuestionRoutes(broker).request('/question/que_missing/reject', {
            method: 'POST'
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            _tag: 'QuestionNotFoundError',
            requestID: 'que_missing',
            message: 'Question request not found: que_missing'
        });
    });

    test('rejects invalid reply payloads', async () => {
        const response = await QuestionRoutes(broker).request('/question/que_missing/reply', {
            method: 'POST',
            body: JSON.stringify({ answer: 'A' }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid question reply' });
    });
});
