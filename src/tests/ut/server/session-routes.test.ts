import { jest } from '@jest/globals';
import { SessionRoutes } from '../../../main/server/routes/session.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { Setting, type SettingData } from '../../../main/utils/setting.js';

function baseSettingData(): SettingData {
    return {
        locale: 'auto',
        default_model: '',
        default_intent_parsing_model: '',
        default_embedding_model: '',
        default_reranker_model: '',
        default_vision_model: '',
        default_workspace: '',
        reason_display: 'full',
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
            recent_workspaces: []
        },
        cli_config: {
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
        getData: jest.fn(() => data)
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

    test('POST /session sets task model from opencode model string', async () => {
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

    test('POST /session/:id/prompt_async uses requested top-level provider and model ids', async () => {
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
});
