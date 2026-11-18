import { jest } from '@jest/globals';
import {
    registerServerSubTaskLifecycle,
    SessionRoutes,
    publishChunkEvents,
    getServerDefaultModel,
    setServerDefaultModel
} from '../../../main/server/opencode/routes/session.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { Setting, type SettingData } from '../../../main/utils/setting.js';
import { MainAgentDecl } from '../../../main/aikernel/agents/main/agent.js';
import { ServerPermissionBroker } from '../../../main/server/opencode/permission-broker.js';
import { ServerQuestionBroker } from '../../../main/server/opencode/question-broker.js';
import { EventBus } from '../../../main/server/opencode/event-bus.js';
import {
    AssistantMessage,
    CompactSeparatorMessage,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { ConfigPermissionRuntime } from '../../../main/server/opencode/config-permission-runtime.js';

jest.mock('../../../main/server/opencode/mcp.js', () => ({
    ensureMcpWorkspace: jest.fn(async () => undefined)
}));

function baseSettingData(): SettingData {
    return {
        locale: 'auto',
        default_model: '',
        default_intent_parsing_model: '',
        default_embedding_model: '',
        default_reranker_model: '',
        default_vision_model: '',
        default_workspace: '',
        providers: [
            {
                name: 'openai',
                base_url: 'https://openai.example/v1',
                api_key: 'test-key',
                no_proxy: false
            }
        ],
        models: [
            {
                alias: 'gpt4o',
                provider_name: 'openai',
                model_name: 'gpt-4o',
                reasoning_effort: ''
            }
        ],
        gui_config: {
            scale_factor: 1,
            font_preset: 'default',
            ctrl_enter_send: false,
            recent_workspaces: [],
            gui_reason_display: 'inline'
        },
        cli_config: {
            use_isolated_python: true,
            inherit_venv: true,
            reason_display: 'full',
            shortcuts: {
                switch_mode: 'ctrl+k',
                switch_model: 'f2',
                clear_input: 'ctrl+c',
                endline: 'ctrl+j',
                show_help: 'ctrl+h',
                list_tasks: 'ctrl+l'
            }
        },
        applications: {}
    };
}

function mockSetting(data = baseSettingData()) {
    jest.spyOn(Setting, 'getInstance').mockReturnValue({
        getData: jest.fn(() => data),
        getModelInstance: jest.fn((alias: string) => data.models.find((model) => model.alias === alias) ?? null),
        data
    } as unknown as Setting);
}

function makeTask(workspace: string) {
    const compactBoundary = new CompactSeparatorMessage('compact summary', {
        boundary_id: 'boundary-session-route',
        created_at: '2026-07-24T10:00:00.000Z',
        trigger: 'manual'
    });
    return {
        task_id: 'task_model',
        parent_id: null,
        task_name: null,
        task_status: 'waiting',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        started_at: undefined as Date | undefined,
        updated_at: undefined as Date | undefined,
        agentId: 'main',
        model: undefined as string | undefined,
        chat_context: {
            system_prompt: { content: 'system' },
            messages: []
        },
        harnessContext: {
            workspace,
            permission: {}
        },
        workspace,
        getWorkspace: jest.fn(() => workspace),
        getExecutionHost: jest.fn(() => ({ type: 'local' })),
        getAgent: jest.fn(() => new MainAgentDecl()),
        getAgentMode: jest.fn(() => ({
            id: 'standard',
            name: 'Standard',
            description: '',
            icon: '',
            color: '',
            permissionFactory: () => []
        })),
        rebuildSystemPrompt: jest.fn(async () => undefined),
        setSystemPrompt: jest.fn(),
        persistLater: jest.fn(),
        compactTaskContext: jest.fn(async () => ({
            compacted: true,
            boundary: compactBoundary,
            summary: 'compact summary'
        })),
        submitUserMessage: jest.fn(async () => undefined),
        waitUntilFinished: jest.fn(async () => undefined)
    };
}

function mockGlobalTaskManager(task: ReturnType<typeof makeTask>) {
    const taskManagerState = {
        tasks: [task],
        createTask: jest.fn(() => task),
        getTask: jest.fn((taskId: string) => (taskId === task.task_id ? task : undefined)),
        initHarness: jest.fn(async () => undefined),
        save: jest.fn()
    };
    jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState } as any);
    return taskManagerState;
}

describe('opencode session routes', () => {
    const workspace = '/tmp/opendesk-session-model-test';

    afterEach(() => {
        jest.restoreAllMocks();
        setServerDefaultModel(undefined);
    });

    function mockSessionDependencies() {
        jest.spyOn(MainAgentDecl.prototype, 'supportedModes').mockReturnValue([
            { id: 'standard', name: 'Standard', description: '', icon: '', color: '', permissionFactory: () => [] }
        ]);
        jest.spyOn(MainAgentDecl.prototype, 'defaultModeId').mockReturnValue('standard');
        jest.spyOn(MainAgentDecl.prototype, 'createSystemPrompt').mockResolvedValue('system prompt');
        jest.spyOn(ServerPermissionBroker, 'getInstance').mockReturnValue({
            setActiveAssistantMessage: jest.fn()
        } as any);
        jest.spyOn(ServerQuestionBroker, 'getInstance').mockReturnValue({
            setActiveAssistantMessage: jest.fn()
        } as any);
    }

    test('POST /session sets task model from opencode model string', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        const taskManagerState = mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(`/?directory=${encodeURIComponent(workspace)}`, {
            method: 'POST',
            body: JSON.stringify({ model: 'openai/gpt-4o' }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(taskManagerState.createTask).toHaveBeenCalledTimes(1);
        expect(task.model).toBe('gpt4o');
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.created',
                properties: expect.objectContaining({
                    sessionID: 'ses_model',
                    info: expect.objectContaining({ id: 'ses_model' })
                })
            })
        );
    });

    test('POST /session reuses the latest explicit model as the runtime default', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);
        const routes = SessionRoutes();

        const firstResponse = await routes.request(`/?directory=${encodeURIComponent(workspace)}`, {
            method: 'POST',
            body: JSON.stringify({ model: 'openai/gpt-4o' }),
            headers: { 'content-type': 'application/json' }
        });
        task.model = undefined;
        const secondResponse = await routes.request(`/?directory=${encodeURIComponent(workspace)}`, {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'content-type': 'application/json' }
        });

        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);
        expect(getServerDefaultModel()).toBe('gpt4o');
        expect(task.model).toBe('gpt4o');
    });

    test('wraps newly initialized server tasks with the config permission runtime', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);
        const permissionRuntime = {
            wrapTask: jest.fn()
        } as unknown as ConfigPermissionRuntime;

        const response = await SessionRoutes(permissionRuntime).request(
            `/?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({}),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(permissionRuntime.wrapTask).toHaveBeenCalledWith(task);
    });

    test('GET /session exposes stable task lifecycle timestamps for historical tasks', async () => {
        const task = makeTask(workspace);
        task.created_at = new Date('2026-01-01T08:00:00.000Z');
        task.started_at = new Date('2026-02-02T09:30:00.000Z');
        task.updated_at = undefined;
        mockGlobalTaskManager(task);

        const firstResponse = await SessionRoutes().request(`/?directory=${encodeURIComponent(workspace)}`);
        const secondResponse = await SessionRoutes().request(`/?directory=${encodeURIComponent(workspace)}`);

        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);
        const [firstSession] = (await firstResponse.json()) as Array<{ time: { created: number; updated: number } }>;
        const [secondSession] = (await secondResponse.json()) as Array<{ time: { created: number; updated: number } }>;
        expect(firstSession.time).toEqual({
            created: task.created_at.getTime(),
            updated: task.started_at.getTime()
        });
        expect(secondSession.time).toEqual(firstSession.time);
    });

    test('PATCH /session/:id persists title and model changes', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(`/ses_model?directory=${encodeURIComponent(workspace)}`, {
            method: 'PATCH',
            body: JSON.stringify({
                title: 'Renamed session',
                model: 'openai/gpt-4o'
            }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(200);
        expect(task.task_name).toBe('Renamed session');
        expect(task.model).toBe('gpt4o');
        expect(task.persistLater).toHaveBeenCalledTimes(1);
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.updated',
                properties: expect.objectContaining({
                    sessionID: 'ses_model',
                    info: expect.objectContaining({ id: 'ses_model', title: 'Renamed session' })
                })
            })
        );
    });

    test('POST /session/:id/summarize compacts with the requested model without changing the task model', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        task.model = 'existing-model';
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/summarize?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    providerID: 'openai',
                    modelID: 'gpt-4o'
                }),
                headers: {
                    'content-type': 'application/json',
                    cookie: 'sid=compact',
                    'x-tracerId': 'trace-compact'
                }
            }
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(task.model).toBe('existing-model');
        expect(task.compactTaskContext).toHaveBeenCalledWith({
            model: 'gpt4o',
            modelRequestOptions: {
                extraHeaders: {
                    cookie: 'sid=compact',
                    trace_id: 'trace-compact'
                }
            }
        });
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.status',
                properties: { sessionID: 'ses_model', status: { type: 'busy' } }
            })
        );
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.compacted',
                properties: { sessionID: 'ses_model' }
            })
        );
        const events = publishSpy.mock.calls.map(([event]) => event as any);
        const compactionUser = events.find(
            (event) => event.type === 'message.updated' && event.properties.info.role === 'user'
        );
        const summaryAssistant = events.find(
            (event) => event.type === 'message.updated' && event.properties.info.summary === true
        );
        const compactionPart = events.find(
            (event) => event.type === 'message.part.updated' && event.properties.part.type === 'compaction'
        );
        const summaryPart = events.find(
            (event) =>
                event.type === 'message.part.updated' &&
                event.properties.part.type === 'text' &&
                event.properties.part.text === 'compact summary'
        );
        expect(compactionUser.properties.info.model).toEqual({
            providerID: 'openai',
            modelID: 'gpt-4o',
            id: 'gpt-4o'
        });
        expect(compactionPart.properties.part).toEqual(
            expect.objectContaining({
                messageID: compactionUser.properties.info.id,
                type: 'compaction',
                auto: false
            })
        );
        expect(summaryAssistant.properties.info).toEqual(
            expect.objectContaining({
                parentID: compactionUser.properties.info.id,
                providerID: 'openai',
                modelID: 'gpt-4o',
                mode: 'compaction',
                agent: 'compaction',
                summary: true,
                finish: 'stop'
            })
        );
        expect(summaryPart.properties.part).toEqual(
            expect.objectContaining({
                messageID: summaryAssistant.properties.info.id,
                text: 'compact summary'
            })
        );
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.status',
                properties: { sessionID: 'ses_model', status: { type: 'idle' } }
            })
        );
    });

    test('POST /session/:id/summarize reports completion when context is below the compaction threshold', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        task.compactTaskContext.mockResolvedValue({ compacted: false });
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/summarize?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    providerID: 'openai',
                    modelID: 'gpt-4o'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        const events = publishSpy.mock.calls.map(([event]) => event as any);
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'session.status',
                    properties: { sessionID: 'ses_model', status: { type: 'busy' } }
                }),
                expect.objectContaining({
                    type: 'session.compacted',
                    properties: { sessionID: 'ses_model' }
                }),
                expect.objectContaining({
                    type: 'session.status',
                    properties: { sessionID: 'ses_model', status: { type: 'idle' } }
                })
            ])
        );
        expect(events.some((event) => event.type === 'message.updated')).toBe(false);
        expect(events.some((event) => event.type === 'message.part.updated')).toBe(false);
    });

    test('POST /session/:id/summarize rejects an unknown model', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/summarize?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    providerID: 'openai',
                    modelID: 'missing-model'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(400);
        expect(task.compactTaskContext).not.toHaveBeenCalled();
    });

    test('POST /session/:id/summarize rejects auto continuation until it is supported', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/summarize?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    providerID: 'openai',
                    modelID: 'gpt-4o',
                    auto: true
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'auto=true is not supported yet' });
        expect(task.compactTaskContext).not.toHaveBeenCalled();
    });

    test('POST /session/:id/message uses requested opencode model object for the submitted turn', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    model: { providerID: 'openai', modelID: 'gpt-4o' },
                    parts: [{ type: 'text', text: 'hello' }]
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(task.model).toBe('gpt4o');
        expect(task.submitUserMessage).toHaveBeenCalledWith(
            'hello',
            expect.objectContaining({
                instrumentationContext: expect.objectContaining({
                    metadata: expect.objectContaining({
                        sessionID: 'ses_model',
                        route: 'POST /session/:sessionID/message'
                    })
                })
            })
        );
    });

    describe.each(['message', 'prompt_async'])('%s model telemetry', (route) => {
        test.each([
            ['openai', 'gpt-4o', 'https://api.example.org/v1', true],
            ['openai', 'gpt-4o', 'http://192.168.1.20/v1', false],
            ['myagent', '模型（外部）', 'https://api.huawei.com/v1', true],
            ['myagent', '内部模型', 'https://api.huawei.com/v1', false],
            ['prefix-replacemodelmyagent', 'model', 'http://localhost/v1', true]
        ])('classifies the selected provider %s / %s', async (providerID, modelID, baseUrl, isExternal) => {
            mockSessionDependencies();
            const data = baseSettingData();
            data.providers.push({ ...data.providers[0], name: providerID, base_url: baseUrl });
            data.providers = data.providers.filter((provider, index) => index > 0 || provider.name !== providerID);
            data.models.push({
                ...data.models[0],
                alias: 'selected-model',
                provider_name: providerID,
                model_name: modelID
            });
            mockSetting(data);
            jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
            const task = makeTask(workspace);
            mockGlobalTaskManager(task);

            const response = await SessionRoutes().request(
                `/ses_model/${route}?directory=${encodeURIComponent(workspace)}`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        model: { providerID, modelID: 'selected-model' },
                        message: 'classify model'
                    }),
                    headers: { 'content-type': 'application/json' }
                }
            );

            expect(response.status).toBe(route === 'message' ? 200 : 204);
            expect(task.submitUserMessage).toHaveBeenCalledWith(
                'classify model',
                expect.objectContaining({
                    instrumentationContext: expect.objectContaining({
                        observationName: 'opencode.request',
                        input: expect.objectContaining({
                            modelLake: expect.objectContaining({ modelName: modelID, isExternal })
                        })
                    })
                })
            );
        });
    });

    test('POST /session/:id/message rebuilds the main prompt after a missing agent fallback', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        task.agentId = 'agentoffice:removed';
        task.chat_context.system_prompt = { content: 'custom prompt' };
        task.getAgent = jest.fn(() => {
            task.agentId = 'main';
            return new MainAgentDecl();
        });
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({ message: 'hello after fallback' }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(task.agentId).toBe('main');
        expect(task.rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    });

    test('POST /session/:id/message passes opencode request headers to the submitted turn', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message: 'hello headers'
                }),
                headers: {
                    'content-type': 'application/json',
                    cookie: 'sid=abc',
                    'x-tracerId': 'trace-123'
                }
            }
        );

        expect(response.status).toBe(200);
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello headers', {
            interactive: true,
            modelRequestOptions: {
                extraHeaders: {
                    cookie: 'sid=abc',
                    trace_id: 'trace-123'
                }
            },
            instrumentationContext: {
                traceId: 'trace-123',
                observationName: 'opencode.request',
                input: expect.objectContaining({ message: 'hello headers' }),
                metadata: expect.objectContaining({
                    sessionID: 'ses_model',
                    route: 'POST /session/:sessionID/message',
                    recordGenerations: true
                }),
                output: {
                    sessionID: 'ses_model',
                    event: 'done',
                    mode: 'standard',
                    agent: 'main',
                    cost: 0
                }
            }
        });
    });

    test('POST /session/:id/message passes each available model header independently', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message: 'hello without complete headers'
                }),
                headers: {
                    'content-type': 'application/json',
                    cookie: 'sid=abc'
                }
            }
        );

        expect(response.status).toBe(200);
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello without complete headers', {
            interactive: true,
            modelRequestOptions: {
                extraHeaders: {
                    cookie: 'sid=abc'
                }
            },
            instrumentationContext: expect.any(Object)
        });
    });

    test('POST /session/:id/message publishes busy and idle session events', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message: 'hello status'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.status',
                properties: { sessionID: 'ses_model', status: { type: 'busy' } }
            })
        );
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.status',
                properties: { sessionID: 'ses_model', status: { type: 'idle' } }
            })
        );
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.idle',
                properties: { sessionID: 'ses_model' }
            })
        );
    });

    test('POST /session/:id/message publishes retry session status for LLM retry chunks', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        task.waitUntilFinished = jest.fn(async (callback?: any) => {
            callback?.({
                type: 'retry',
                task_id: task.task_id,
                task_status: 'running',
                attempt: 2,
                delay_ms: 10000,
                next_retry_at: 123456789,
                error_message: 'request timeout',
                status: 'scheduled'
            });
        });
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message: 'hello retry'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        expect(publishSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'session.status',
                properties: {
                    sessionID: 'ses_model',
                    status: {
                        type: 'retry',
                        attempt: 2,
                        message: 'request timeout',
                        next: 123456789
                    }
                }
            })
        );
    });

    test('GET /session/:id/message returns chronological messages with assistant parent links', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const firstUser = new UserMessage('first');
        firstUser.message_id = 'internal-user-1';
        firstUser.timestamp = 1000;
        const firstAssistant = new AssistantMessage();
        firstAssistant.message_id = 'internal-assistant-1';
        firstAssistant.appendText('first answer');
        const secondUser = new UserMessage('second');
        secondUser.message_id = 'internal-user-2';
        secondUser.timestamp = 2000;
        const secondAssistant = new AssistantMessage();
        secondAssistant.message_id = 'internal-assistant-2';
        secondAssistant.appendText('second answer');
        task.chat_context.messages = [firstUser, firstAssistant, secondUser, secondAssistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'GET'
            }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages.map((message: any) => message.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(messages.map((message: any) => message.info.id)).toEqual(
            [...messages.map((message: any) => message.info.id)].sort()
        );
        expect(messages[1].info.parentID).toBe(messages[0].info.id);
        expect(messages[3].info.parentID).toBe(messages[2].info.id);
        expect(messages[0].parts[0].messageID).toBe(messages[0].info.id);
        expect(messages[1].parts[0].messageID).toBe(messages[1].info.id);
    });

    test('GET /session/:id/message hides internal user messages from the listing', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const reminder = new UserMessage('<system-reminder>locale reminder text</system-reminder>');
        reminder.message_id = 'locale-reminder-1';
        reminder.timestamp = 500;
        reminder.internal = true;
        const realUser = new UserMessage('real question');
        realUser.message_id = 'real-user-1';
        realUser.timestamp = 1000;
        const assistant = new AssistantMessage();
        assistant.message_id = 'real-assistant-1';
        assistant.appendText('real answer');
        task.chat_context.messages = [reminder, realUser, assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'GET'
            }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages.map((message: any) => message.info.role)).toEqual(['user', 'assistant']);
        expect(JSON.stringify(messages)).not.toContain('locale reminder text');
        // assistant 的父消息链接到最近一条可见用户消息，而不是被隐藏的 internal 消息
        expect(messages[1].info.parentID).toBe(messages[0].info.id);
    });

    test('DELETE /session/:id/message/:messageID accepts the public message id and persists removal', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const userMessage = new UserMessage('remove me');
        userMessage.message_id = 'internal-message-to-delete';
        task.chat_context.messages = [userMessage];
        mockGlobalTaskManager(task);

        const listResponse = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );
        const messages = await listResponse.json();
        const publicMessageID = messages[0].info.id;

        const deleteResponse = await SessionRoutes().request(
            `/ses_model/message/${publicMessageID}?directory=${encodeURIComponent(workspace)}`,
            { method: 'DELETE' }
        );

        expect(deleteResponse.status).toBe(200);
        expect(task.chat_context.messages).toEqual([]);
        expect(task.persistLater).toHaveBeenCalledTimes(1);
    });

    test('GET /session/:id/message exposes a compact boundary as OpenCode compaction messages', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        task.chat_context.messages = [
            new CompactSeparatorMessage('persisted compact summary', {
                boundary_id: 'persisted-boundary',
                created_at: '2026-07-24T11:00:00.000Z',
                trigger: 'manual'
            })
        ];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages).toHaveLength(2);
        expect(messages[0].info.role).toBe('user');
        expect(messages[0].parts).toEqual([
            expect.objectContaining({
                messageID: messages[0].info.id,
                type: 'compaction',
                auto: false
            })
        ]);
        expect(messages[1].info).toEqual(
            expect.objectContaining({
                role: 'assistant',
                parentID: messages[0].info.id,
                mode: 'compaction',
                agent: 'compaction',
                summary: true,
                finish: 'stop'
            })
        );
        expect(messages[1].parts).toEqual([
            expect.objectContaining({
                messageID: messages[1].info.id,
                type: 'text',
                text: 'persisted compact summary'
            })
        ]);

        const singleResponse = await SessionRoutes().request(
            `/ses_model/message/${messages[1].info.id}?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );
        expect(singleResponse.status).toBe(200);
        expect(await singleResponse.json()).toEqual(messages[1]);
    });

    test('GET /session/:id/message includes assistant error text', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-error';
        assistant.appendError('Stream Completion Failed', 'request timeout');
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'GET'
            }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0].text).toBe('Error: Stream Completion Failed: request timeout');
    });

    test('GET /session/:id/message returns opencode-compatible tool state output', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-tool';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(0, 'call_read', 'filemgr-readFile', '{"file_path":"README.md"}');
        toolCall.status = 'success';
        toolCall.result = 'file content';
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'GET'
            }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'tool',
                callID: 'call_read',
                tool: 'read',
                state: expect.objectContaining({
                    status: 'completed',
                    input: { filePath: 'README.md' },
                    output: 'file content',
                    title: 'README.md',
                    metadata: {
                        originalTool: 'filemgr-readFile',
                        originalInput: { file_path: 'README.md' }
                    },
                    time: expect.objectContaining({
                        start: expect.any(Number),
                        end: expect.any(Number)
                    })
                })
            })
        );
        expect(messages[0].parts[0].output).toBeUndefined();
        expect(messages[0].parts[0].input).toBeUndefined();
    });

    test('GET /session/:id/message maps OpenDesk subtasks to opencode task parts', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-subtask';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(
            0,
            'call_subtask',
            'planning-createSubTask',
            JSON.stringify({
                title: 'Inspect logs',
                objective: 'Find the failure',
                criteria: 'Return the root cause',
                isAsync: false,
                agentName: 'explore'
            })
        );
        toolCall.status = 'success';
        toolCall.result = JSON.stringify({
            success: true,
            result: 'Found the root cause',
            subtask_id: 'task_child'
        });
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'tool',
                callID: 'call_subtask',
                tool: 'task',
                state: expect.objectContaining({
                    status: 'completed',
                    input: {
                        description: 'Inspect logs',
                        prompt: 'Find the failure\n\nReturn the root cause',
                        subagent_type: 'explore',
                        background: false,
                        task_id: 'ses_child'
                    },
                    metadata: expect.objectContaining({
                        parentSessionId: 'ses_model',
                        sessionId: 'ses_child',
                        background: false,
                        originalTool: 'planning-createSubTask'
                    })
                })
            })
        );
    });

    test('renders internal subtask completion calls as final text instead of tool acknowledgements', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        task.task_id = 'task_child';
        task.parent_id = 'task_parent';
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-completion';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(
            0,
            'call_completion',
            'planning-attemptCompletion',
            JSON.stringify({ type: 'success', message: 'The child finished successfully' })
        );
        toolCall.status = 'success';
        toolCall.result = JSON.stringify({ accepted: true, type: 'success' });
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_child/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'text',
                text: 'The child finished successfully'
            })
        );
        expect(messages[0].parts[0].tool).toBeUndefined();
        expect(JSON.stringify(messages[0].parts[0])).not.toContain('"accepted":true');
    });

    test('keeps an unfinished subtask completion call as a tool part', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        task.task_id = 'task_child';
        task.parent_id = 'task_parent';
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-completion-running';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(
            0,
            'call_completion_running',
            'planning-attemptCompletion',
            JSON.stringify({ type: 'success', message: 'Not final yet' })
        );
        toolCall.status = 'running';
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_child/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'tool',
                tool: 'planning-attemptCompletion',
                state: expect.objectContaining({ status: 'running' })
            })
        );
    });

    test('renders an accepted subtask completion update as text before its status callback settles', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        task.task_id = 'task_child';
        task.parent_id = 'task_parent';
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-completion-accepted';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(
            0,
            'call_completion_accepted',
            'planning-attemptCompletion',
            JSON.stringify({ type: 'success', message: 'Accepted child result' })
        );
        toolCall.status = 'running';
        toolCall.result = JSON.stringify({ accepted: true, type: 'success' });
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_child/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'text',
                text: 'Accepted child result'
            })
        );
        expect(JSON.stringify(messages[0].parts[0])).not.toContain('"accepted":true');
    });

    test('publishes a complete opencode session lifecycle for child tasks', async () => {
        mockSessionDependencies();
        mockSetting();
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task_parent';
        parent.task_name = 'parent';
        parent.workspace = workspace;
        parent.harnessContext.workspace = workspace;
        manager.tasks.push(parent);
        registerServerSubTaskLifecycle(parent);

        const child = manager.createSubTask(parent.task_id);
        child.task_id = 'task_child';
        child.task_name = 'child';
        child.workspace = workspace;
        child.harnessContext.workspace = workspace;
        parent.notifySubTaskCreated(child);

        expect(child.harnessContext.permissionPrompt).toBe(ServerPermissionBroker.getInstance());

        child.task_status = 'running';
        const user = new UserMessage('child prompt');
        user.message_id = 'child-user';
        child.chat_context.appendMessage(user);
        child.publishTaskUpdate(
            {
                type: 'user',
                task_id: child.task_id,
                task_status: 'running',
                message_id: user.message_id,
                last_part_index: 0,
                last_part: user.content[0],
                timestamp: user.timestamp
            } as any,
            'test child user'
        );

        const assistant = new AssistantMessage();
        assistant.message_id = 'child-assistant';
        assistant.content.push(new TextMessagePart('child result'));
        child.chat_context.appendMessage(assistant);
        child.publishTaskUpdate(
            {
                type: 'assistant',
                task_id: child.task_id,
                task_status: 'running',
                message_id: assistant.message_id,
                last_part_index: 0,
                last_part: assistant.content[0]
            } as any,
            'test child assistant'
        );
        child.task_status = 'stopped';
        child.finished_at = new Date();
        child.publishTaskUpdate(
            {
                type: 'assistant',
                task_id: child.task_id,
                task_status: 'stopped',
                message_id: assistant.message_id,
                last_part_index: 0,
                last_part: assistant.content[0]
            } as any,
            'test child finished'
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        const events = publishSpy.mock.calls.map(([event]) => event as any);
        expect(events).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'session.created',
                    properties: expect.objectContaining({
                        sessionID: 'ses_child',
                        info: expect.objectContaining({ id: 'ses_child', parentID: 'ses_parent' })
                    })
                }),
                expect.objectContaining({
                    type: 'session.status',
                    properties: expect.objectContaining({ sessionID: 'ses_child', status: { type: 'busy' } })
                }),
                expect.objectContaining({
                    type: 'session.updated',
                    properties: expect.objectContaining({
                        sessionID: 'ses_child',
                        info: expect.objectContaining({ id: 'ses_child', parentID: 'ses_parent' })
                    })
                }),
                expect.objectContaining({
                    type: 'session.idle',
                    properties: expect.objectContaining({ sessionID: 'ses_child', parentID: 'ses_parent' })
                })
            ])
        );
        const childMessages = events.filter(
            (event) => event.type === 'message.updated' && event.properties.info.sessionID === 'ses_child'
        );
        expect(childMessages.some((event) => event.properties.info.role === 'user')).toBe(true);
        expect(childMessages.some((event) => event.properties.info.role === 'assistant')).toBe(true);
        expect(
            events.some(
                (event) => event.type === 'message.part.updated' && event.properties.part.sessionID === 'ses_child'
            )
        ).toBe(true);
    });

    test('completed child assistant parent link skips internal user messages', async () => {
        mockSessionDependencies();
        mockSetting();
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task_parent';
        parent.task_name = 'parent';
        parent.workspace = workspace;
        parent.harnessContext.workspace = workspace;
        manager.tasks.push(parent);
        registerServerSubTaskLifecycle(parent);

        const child = manager.createSubTask(parent.task_id);
        child.task_id = 'task_child';
        child.task_name = 'child';
        child.workspace = workspace;
        child.harnessContext.workspace = workspace;
        parent.notifySubTaskCreated(child);

        // internal 用户消息紧邻 assistant（如 goal/workflow 内部 prompt），完成后发布的
        // assistant 消息 parentID 应跳过它，落到最近一条可见用户消息上
        const earlierUser = new UserMessage('earlier question');
        earlierUser.message_id = 'child-earlier-user';
        const internalPrompt = new UserMessage('internal continuation prompt');
        internalPrompt.message_id = 'child-internal-prompt';
        internalPrompt.internal = true;
        const assistant = new AssistantMessage();
        assistant.message_id = 'child-assistant';
        assistant.content.push(new TextMessagePart('child result'));
        child.chat_context.messages = [earlierUser, internalPrompt, assistant];

        child.task_status = 'stopped';
        child.finished_at = new Date();
        child.publishTaskUpdate(
            {
                type: 'assistant',
                task_id: child.task_id,
                task_status: 'stopped',
                message_id: assistant.message_id,
                last_part_index: 0,
                last_part: assistant.content[0]
            } as any,
            'test child finished'
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState: manager } as any);
        const listResponse = await SessionRoutes().request(
            `/ses_child/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );
        const messages = await listResponse.json();
        expect(messages.map((message: any) => message.info.role)).toEqual(['user', 'assistant']);
        expect(JSON.stringify(messages)).not.toContain('internal continuation prompt');

        const assistantUpdates = publishSpy.mock.calls
            .map(([event]) => event as any)
            .filter(
                (event) =>
                    event.type === 'message.updated' &&
                    event.properties?.info?.sessionID === 'ses_child' &&
                    event.properties.info.role === 'assistant'
            );
        const completed = assistantUpdates[assistantUpdates.length - 1];
        expect(completed.properties.info.parentID).toBe(messages[0].info.id);
    });

    test('queries and aborts child sessions by their public session id', async () => {
        const parent = makeTask(workspace);
        parent.task_id = 'task_parent';
        const child = makeTask(workspace);
        child.task_id = 'task_child';
        child.parent_id = parent.task_id;
        child.task_name = 'child';
        child.task_status = 'running';
        child.stop = jest.fn(() => {
            child.task_status = 'stopped';
        });
        const taskManagerState = {
            tasks: [parent, child],
            getTask: jest.fn((taskId: string) => [parent, child].find((candidate) => candidate.task_id === taskId))
        };
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState } as any);

        const childrenResponse = await SessionRoutes().request(
            `/ses_parent/children?directory=${encodeURIComponent(workspace)}`
        );
        const childResponse = await SessionRoutes().request(`/ses_child?directory=${encodeURIComponent(workspace)}`);
        const abortResponse = await SessionRoutes().request(
            `/ses_child/abort?directory=${encodeURIComponent(workspace)}`,
            { method: 'POST' }
        );

        expect(await childrenResponse.json()).toEqual([
            expect.objectContaining({ id: 'ses_child', parentID: 'ses_parent' })
        ]);
        expect(await childResponse.json()).toEqual(
            expect.objectContaining({ id: 'ses_child', parentID: 'ses_parent' })
        );
        expect(abortResponse.status).toBe(200);
        expect(child.stop).toHaveBeenCalledWith('user');
    });

    test('GET /session/:id/message expands every tool call in a shared OpenDesk part', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-parallel-tools';
        const toolPart = new ToolCallMessagePart();
        const firstCall = new ToolCall(0, 'call_first', 'firstTool', '{"value":1}');
        const secondCall = new ToolCall(1, 'call_second', 'secondTool', '{"value":2}');
        firstCall.status = 'success';
        secondCall.status = 'success';
        toolPart.push(firstCall);
        toolPart.push(secondCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            { method: 'GET' }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts.map((part: any) => part.callID)).toEqual(['call_first', 'call_second']);
        expect(messages[0].parts[0].id).not.toBe(messages[0].parts[1].id);
    });

    test('opencode chunk events expand shared tool-call parts with stable ids', () => {
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const toolPart = new ToolCallMessagePart();
        const firstCall = new ToolCall(0, 'call_stream_first', 'firstTool', '{"value":1}');
        const secondCall = new ToolCall(1, 'call_stream_second', 'secondTool', '{"value":2}');
        toolPart.push(firstCall);
        toolPart.push(secondCall);

        const chunk = {
            type: 'assistant',
            task_id: 'task-stream-tools',
            task_status: 'running',
            message_id: 'internal-message-stream-tools',
            last_part_index: 0,
            last_part: toolPart
        } as any;
        publishChunkEvents('ses_stream_tools', chunk, 'msg_parent', workspace);
        firstCall.status = 'success';
        secondCall.status = 'success';
        publishChunkEvents('ses_stream_tools', chunk, 'msg_parent', workspace);

        const toolEvents = publishSpy.mock.calls
            .map(([event]) => event as any)
            .filter((event) => event.type === 'message.part.updated' && event.properties.part.type === 'tool');
        expect(toolEvents.map((event) => event.properties.part.callID)).toEqual([
            'call_stream_first',
            'call_stream_second',
            'call_stream_first',
            'call_stream_second'
        ]);
        expect(toolEvents[0].properties.part.id).toBe(toolEvents[2].properties.part.id);
        expect(toolEvents[1].properties.part.id).toBe(toolEvents[3].properties.part.id);
        expect(toolEvents[0].properties.part.id).not.toBe(toolEvents[1].properties.part.id);
    });

    test('GET /session/:id/message maps skill load tool to opencode skill rendering shape', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        const assistant = new AssistantMessage();
        assistant.message_id = 'internal-assistant-skill';
        const toolPart = new ToolCallMessagePart();
        const toolCall = new ToolCall(
            0,
            'call_skill',
            'skill-manager-LoadSkill',
            '{"bundleName":"mailbox","skillName":"manage-mailbox"}'
        );
        toolCall.status = 'success';
        toolCall.result = '# 邮箱账号管理';
        toolPart.push(toolCall);
        assistant.appendToolCallPart(toolPart);
        task.chat_context.messages = [assistant];
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'GET'
            }
        );

        expect(response.status).toBe(200);
        const messages = await response.json();
        expect(messages[0].parts[0]).toEqual(
            expect.objectContaining({
                type: 'tool',
                callID: 'call_skill',
                tool: 'skill',
                state: expect.objectContaining({
                    status: 'completed',
                    input: { name: 'manage-mailbox' },
                    output: '# 邮箱账号管理',
                    title: 'manage-mailbox',
                    metadata: {
                        originalTool: 'skill-manager-LoadSkill',
                        originalInput: { bundleName: 'mailbox', skillName: 'manage-mailbox' }
                    }
                })
            })
        );
    });

    test('POST /session/:id/message publishes text part deltas for assistant streaming updates', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const task = makeTask(workspace);
        task.waitUntilFinished = jest.fn(async (callback?: any) => {
            const firstAssistant = new AssistantMessage();
            firstAssistant.message_id = 'internal-assistant-delta';
            firstAssistant.appendText('hel');
            callback?.({
                type: 'assistant',
                task_id: task.task_id,
                task_status: 'running',
                message_id: firstAssistant.message_id,
                last_part_index: 0,
                last_part: firstAssistant.content[0]
            });

            const secondAssistant = new AssistantMessage();
            secondAssistant.message_id = 'internal-assistant-delta';
            secondAssistant.appendText('hello');
            callback?.({
                type: 'assistant',
                task_id: task.task_id,
                task_status: 'stopped',
                message_id: secondAssistant.message_id,
                last_part_index: 0,
                last_part: secondAssistant.content[0]
            });
            task.chat_context.messages = [secondAssistant];
        });
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/message?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    message: 'hello streaming'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(200);
        const updatedEvent = publishSpy.mock.calls
            .map(([event]) => event as any)
            .find((event) => event.type === 'message.part.updated' && event.properties.part.type === 'text');
        const updatedEvents = publishSpy.mock.calls
            .map(([event]) => event as any)
            .filter((event) => event.type === 'message.part.updated' && event.properties.part.type === 'text');
        const deltaEvent = publishSpy.mock.calls
            .map(([event]) => event as any)
            .find((event) => event.type === 'message.part.delta');

        expect(updatedEvent).toBeDefined();
        expect(deltaEvent).toBeDefined();
        if (!updatedEvent || !deltaEvent) {
            throw new Error('expected message part update and delta events');
        }
        expect(updatedEvent.properties.part.text).toBe('hel');
        expect(updatedEvents[updatedEvents.length - 1]?.properties.part.text).toBe('hello');
        expect(deltaEvent).toEqual(
            expect.objectContaining({
                type: 'message.part.delta',
                properties: {
                    sessionID: 'ses_model',
                    messageID: updatedEvent.properties.part.messageID,
                    partID: updatedEvent.properties.part.id,
                    field: 'text',
                    delta: 'lo'
                }
            })
        );
    });

    test('POST /session/:id/prompt_async uses requested top-level provider and model ids', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
        const task = makeTask(workspace);
        mockGlobalTaskManager(task);

        const response = await SessionRoutes().request(
            `/ses_model/prompt_async?directory=${encodeURIComponent(workspace)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    providerID: 'openai',
                    modelID: 'gpt-4o',
                    message: 'hello async'
                }),
                headers: { 'content-type': 'application/json' }
            }
        );

        expect(response.status).toBe(204);
        expect(task.model).toBe('gpt4o');
        expect(task.submitUserMessage).toHaveBeenCalledWith(
            'hello async',
            expect.objectContaining({
                instrumentationContext: expect.objectContaining({
                    metadata: expect.objectContaining({
                        route: 'POST /session/:sessionID/prompt_async'
                    })
                })
            })
        );
    });

    test('opencode chunk events keep a stable part id when text is rebased to reasoning', () => {
        const publishSpy = jest.spyOn(EventBus, 'publish').mockImplementation(() => undefined);
        const parentUserMsgId = 'msg_user_rebase';

        publishChunkEvents(
            'ses_rebase',
            {
                type: 'assistant',
                task_id: 'task-rebase',
                task_status: 'running',
                message_id: 'internal-message-rebase',
                last_part_index: 0,
                provisional: 'implicit_think_close_candidate',
                last_part: { type: 'text', text: 'hidden' }
            } as any,
            parentUserMsgId,
            workspace
        );
        publishChunkEvents(
            'ses_rebase',
            {
                type: 'assistant_replace',
                task_id: 'task-rebase',
                task_status: 'running',
                message_id: 'internal-message-rebase',
                parts: [
                    { type: 'reasoning', content: 'hidden' },
                    { type: 'text', text: 'visible' }
                ]
            } as any,
            parentUserMsgId,
            workspace
        );

        const partEvents = publishSpy.mock.calls
            .map(([event]) => event as any)
            .filter((event) => event.type === 'message.part.updated');
        const assistantMsgId = partEvents[0]?.properties?.part?.messageID;

        expect(partEvents).toHaveLength(3);
        expect(typeof assistantMsgId).toBe('string');
        expect(partEvents.every((event) => event.properties.part.messageID === assistantMsgId)).toBe(true);
        expect(partEvents[0].properties.part.type).toBe('text');
        expect(partEvents[1].properties.part.type).toBe('reasoning');
        expect(partEvents[1].properties.part.id).toBe(partEvents[0].properties.part.id);
        expect(partEvents[2].properties.part.type).toBe('text');
        expect(partEvents[2].properties.part.id).not.toBe(partEvents[0].properties.part.id);
    });
});
