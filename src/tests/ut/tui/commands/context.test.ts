import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatContext, SystemMessage, UserMessage } from '../../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';

const inspectContextForDiagnosticsMock = jest.fn();
const analyzeContextDiagnosticsMock = jest.fn();
const generateContextSuggestionsMock = jest.fn();
const formatContextDiagnosticsReportMock = jest.fn();
const openContextVisualPageMock = jest.fn();
const openContextDataPageMock = jest.fn();

jest.unstable_mockModule('../../../../main/aikernel/context/inspect', () => ({
    inspectContextForDiagnostics: inspectContextForDiagnosticsMock
}));

jest.unstable_mockModule('../../../../main/aikernel/context/analyze', () => ({
    analyzeContextDiagnostics: analyzeContextDiagnosticsMock
}));

jest.unstable_mockModule('../../../../main/aikernel/context/suggestions', () => ({
    generateContextSuggestions: generateContextSuggestionsMock
}));

jest.unstable_mockModule('../../../../main/aikernel/context/format', () => ({
    formatContextDiagnosticsReport: formatContextDiagnosticsReportMock
}));

jest.unstable_mockModule('../../../../main/tui/components/context', () => ({
    openContextVisualPage: openContextVisualPageMock,
    openContextDataPage: openContextDataPageMock
}));

function createTask(): TaskState {
    const taskManagerState = new TaskManagerState();
    const task = new TaskState(taskManagerState);
    task.task_id = 'task-context-1';
    task.model = 'demo-model';
    task.chat_context = new ChatContext();
    task.chat_context.system_prompt = new SystemMessage('system prompt');
    task.chat_context.appendMessage(new UserMessage('hello context'));
    return task;
}

async function loadCommandRegistry() {
    const { setRuntimeLocale } = await import('../../../../locale/index.js');
    setRuntimeLocale('en-US');
    const { registerAllCommands } = await import('../../../../main/tui/commands/index.js');
    return { registerAllCommands, setRuntimeLocale };
}

describe('/context command', () => {
    beforeEach(() => {
        inspectContextForDiagnosticsMock.mockReset();
        analyzeContextDiagnosticsMock.mockReset();
        generateContextSuggestionsMock.mockReset();
        formatContextDiagnosticsReportMock.mockReset();
        openContextVisualPageMock.mockReset();
        openContextDataPageMock.mockReset();
    });

    afterEach(async () => {
        const { setRuntimeLocale } = await import('../../../../locale/index.js');
        setRuntimeLocale(null);
    });

    test('shows the visual diagnostics page by default without mutating context', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-context-command-'));
        const { registerAllCommands } = await loadCommandRegistry();
        const task = createTask();
        task.harnessContext.workspace = tempRoot;
        const originalChatContext = JSON.stringify(task.chat_context.toJSON());
        const inspection = {
            activeContext: {
                startIndex: 0,
                messages: [],
                projectedItems: []
            },
            autoCompactDecision: {
                shouldCompact: false,
                reason: 'below_threshold',
                estimatedContextTokens: 100,
                baseUsageTokens: 0,
                tailEstimatedTokens: 0,
                assistantInternalTailTokens: 0,
                contextWindow: 10_000,
                reservedSummaryOutput: 100,
                effectiveWindow: 9_900,
                buffer: 0,
                autoCompactThreshold: 9_900,
                windowUsageRatio: 0.01,
                marginTokens: 9_800
            },
            contextTokenEstimate: {
                estimatedContextTokens: 100,
                baseUsageTokens: 0,
                tailEstimatedTokens: 0,
                assistantInternalTailTokens: 0,
                source: 'rough_estimate_only'
            },
            toolResultOverrides: new Map<string, string>(),
            toolResultBudgetStats: undefined,
            microcompactDecision: {
                mode: 'noop',
                reason: 'view_only',
                selectedResultIds: [],
                keptRecentResultIds: [],
                estimatedCharsBefore: 0,
                estimatedCharsAfter: 0,
                estimatedCharsSaved: 0
            },
            shouldCompact: false,
            compacted: false,
            sessionMemoryCompacted: false,
            budgetApplied: false,
            microcompactApplied: false,
            microcompactAppliedCandidates: [],
            toolResultStateChanged: false,
            microcompactStateChanged: false,
            sessionMemoryStateChanged: false,
            toolsetCategories: [],
            assistantRounds: []
        } as any;

        inspectContextForDiagnosticsMock.mockResolvedValueOnce(inspection);
        analyzeContextDiagnosticsMock.mockReturnValueOnce({ report: true });
        generateContextSuggestionsMock.mockReturnValueOnce([{ id: 's1' }]);

        const showTextPage = jest.fn();
        const showComponentPage = jest.fn();
        const registry = new SlashCommandRegistry();
        const tui = {
            commandRegistry: registry,
            activeTaskId: task.task_id,
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            taskView: {
                taskState: task
            },
            model: 'demo-model',
            showTextPage,
            showComponentPage
        } as any;

        registerAllCommands(tui);

        expect(registry.has('context')).toBe(true);

        const executed = await registry.execute('/context');

        expect(executed).toBe(true);
        expect(task.chat_context.toJSON()).toEqual(JSON.parse(originalChatContext));
        expect(inspectContextForDiagnosticsMock).toHaveBeenCalledTimes(1);
        expect(inspectContextForDiagnosticsMock).toHaveBeenCalledWith(
            task.chat_context,
            'demo-model',
            expect.objectContaining({
                taskId: task.task_id,
                readonlyOnly: true,
                enableToolResultBudget: true,
                enableMicrocompact: false,
                microcompactRequestKind: 'view_only',
                microcompactTaskRole: 'main',
                autoCompactState: task.auto_compact_state,
                microcompactState: task.microcompact_state,
                toolResultReplacementState: task.tool_result_replacement_state
            })
        );
        expect(analyzeContextDiagnosticsMock).toHaveBeenCalledWith({
            chatContext: task.chat_context,
            inspection,
            modelName: 'demo-model'
        });
        expect(generateContextSuggestionsMock).toHaveBeenCalledWith({ report: true });
        expect(openContextVisualPageMock).toHaveBeenCalledWith(tui, { report: true }, [{ id: 's1' }]);
        expect(openContextDataPageMock).not.toHaveBeenCalled();
        expect(showComponentPage).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(tempRoot, 'artifacts', task.task_id, 'tool-results'))).toBe(false);
    });

    test('shows raw diagnostics data when --data is passed', async () => {
        const { registerAllCommands } = await loadCommandRegistry();
        const task = createTask();
        const originalChatContext = JSON.stringify(task.chat_context.toJSON());
        const inspection = {
            activeContext: {
                startIndex: 0,
                messages: [],
                projectedItems: []
            },
            autoCompactDecision: {
                shouldCompact: false,
                reason: 'below_threshold',
                estimatedContextTokens: 100,
                baseUsageTokens: 0,
                tailEstimatedTokens: 0,
                assistantInternalTailTokens: 0,
                contextWindow: 10_000,
                reservedSummaryOutput: 100,
                effectiveWindow: 9_900,
                buffer: 0,
                autoCompactThreshold: 9_900,
                windowUsageRatio: 0.01,
                marginTokens: 9_800
            },
            contextTokenEstimate: {
                estimatedContextTokens: 100,
                baseUsageTokens: 0,
                tailEstimatedTokens: 0,
                assistantInternalTailTokens: 0,
                source: 'rough_estimate_only'
            },
            toolResultOverrides: new Map<string, string>(),
            toolResultBudgetStats: undefined,
            microcompactDecision: {
                mode: 'noop',
                reason: 'view_only',
                selectedResultIds: [],
                keptRecentResultIds: [],
                estimatedCharsBefore: 0,
                estimatedCharsAfter: 0,
                estimatedCharsSaved: 0
            },
            shouldCompact: false,
            compacted: false,
            sessionMemoryCompacted: false,
            budgetApplied: false,
            microcompactApplied: false,
            microcompactAppliedCandidates: [],
            toolResultStateChanged: false,
            microcompactStateChanged: false,
            sessionMemoryStateChanged: false,
            toolsetCategories: [],
            assistantRounds: []
        } as any;

        inspectContextForDiagnosticsMock.mockResolvedValueOnce(inspection);
        analyzeContextDiagnosticsMock.mockReturnValueOnce({ report: true });
        generateContextSuggestionsMock.mockReturnValueOnce([{ id: 's1' }]);
        formatContextDiagnosticsReportMock.mockReturnValueOnce('formatted context report');

        const showTextPage = jest.fn();
        const showComponentPage = jest.fn();
        const registry = new SlashCommandRegistry();
        const tui = {
            commandRegistry: registry,
            activeTaskId: task.task_id,
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            taskView: {
                taskState: task
            },
            model: 'demo-model',
            showTextPage,
            showComponentPage
        } as any;

        registerAllCommands(tui);

        const executed = await registry.execute('/context --data');

        expect(executed).toBe(true);
        expect(task.chat_context.toJSON()).toEqual(JSON.parse(originalChatContext));
        expect(openContextDataPageMock).toHaveBeenCalledWith(tui, { report: true }, [{ id: 's1' }]);
        expect(openContextVisualPageMock).not.toHaveBeenCalled();
        expect(formatContextDiagnosticsReportMock).not.toHaveBeenCalled();
        expect(showTextPage).not.toHaveBeenCalled();
        expect(showComponentPage).not.toHaveBeenCalled();
    });

    test('shows a no-task page when there is no active task', async () => {
        const { registerAllCommands } = await loadCommandRegistry();
        const showTextPage = jest.fn();
        const registry = new SlashCommandRegistry();
        const tui = {
            commandRegistry: registry,
            activeTaskId: undefined,
            taskManagerState: {
                getTask: jest.fn(() => undefined)
            },
            taskView: {
                taskState: undefined
            },
            model: 'demo-model',
            showTextPage
        } as any;

        registerAllCommands(tui);

        const executed = await registry.execute('/context');

        expect(executed).toBe(true);
        expect(inspectContextForDiagnosticsMock).not.toHaveBeenCalled();
        expect(showTextPage).toHaveBeenCalledWith('Context Diagnostics', 'No active task');
    });
});
