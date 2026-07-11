import { jest } from '@jest/globals';
import { SessionRoutes, publishChunkEvents } from '../../../main/server/opencode/routes/session.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { Setting, type SettingData } from '../../../main/utils/setting.js';
import { MainAgentDecl } from '../../../main/aikernel/agents/main/agent.js';
import { ServerPermissionBroker } from '../../../main/server/opencode/permission-broker.js';
import { ServerQuestionBroker } from '../../../main/server/opencode/question-broker.js';
import { EventBus } from '../../../main/server/opencode/event-bus.js';
import { AssistantMessage, ToolCall, ToolCallMessagePart, UserMessage } from '../../../main/aikernel/messages.js';

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
        data
    } as unknown as Setting);
}

function makeTask(workspace: string) {
    return {
        task_id: 'task_model',
        parent_id: null,
        task_name: null,
        task_status: 'waiting',
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
        setSystemPrompt: jest.fn(),
        persistLater: jest.fn(),
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
        jest.spyOn(ServerQuestionBroker, 'getInstance').mockReturnValue({} as any);
    }

    test('POST /session sets task model from opencode model string', async () => {
        mockSessionDependencies();
        mockSetting();
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);
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
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello');
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
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello headers', undefined, {
            extraHeaders: {
                cookie: 'sid=abc',
                trace_id: 'trace-123'
            }
        });
    });

    test('POST /session/:id/message does not pass model headers when cookie or trace is missing', async () => {
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
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello without complete headers');
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
        expect(task.submitUserMessage).toHaveBeenCalledWith('hello async');
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
