import type { ChatMessage, CompactSeparatorMessage } from '../messages.js';
import type { MicrocompactAnalysisResult, MicrocompactCandidate, MicrocompactStats } from './microcompact.js';
import type { AutoCompactDecision, AutoCompactState } from './auto-compact.js';
import type {
    SessionMemoryCompactOptions,
    SessionMemoryCompactRunResult,
    SessionMemoryState
} from './session-memory-compact.js';
import type {
    ToolResultReplacementState,
    ToolResultPreviewOptions,
    ToolResultBudgetProjectionStats
} from './tool-results.js';

export interface CompactBoundaryRef {
    index: number;
    message: CompactSeparatorMessage;
}

export interface ActiveContextView {
    startIndex: number;
    messages: ChatMessage[];
    boundary?: CompactBoundaryRef;
}

export interface PrepareContextOptions {
    beforeCompact?: () => void;
    executeCompact?: () => Promise<boolean | void> | boolean | void;
    enableToolResultBudget?: boolean;
    enableMicrocompact?: boolean;
    enableSessionMemoryCompact?: boolean;
    autoCompactState?: AutoCompactState;
    sessionMemoryState?: SessionMemoryState;
    sessionMemoryCompactOptions?: SessionMemoryCompactOptions;
    /** 可选的自动压缩决策注入，主要用于单元测试稳定控制 pipeline 分支。 */
    autoCompactDecisionOverride?: AutoCompactDecision;
    taskId?: string;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetChars?: number;
    toolResultBudgetPreviewOptions?: ToolResultPreviewOptions;
    skipToolNames?: Iterable<string>;
    microcompactTailAssistantMessages?: number;
    microcompactSkipToolNames?: Iterable<string>;
}

export interface PreparedContextResult {
    activeContext: ActiveContextView;
    autoCompactDecision: AutoCompactDecision;
    autoCompactState?: AutoCompactState;
    autoCompactStateChanged: boolean;
    shouldCompact: boolean;
    compacted: boolean;
    sessionMemoryCompacted: boolean;
    budgetApplied: boolean;
    microcompactApplied: boolean;
    toolResultOverrides: Map<string, string>;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetStats?: ToolResultBudgetProjectionStats;
    sessionMemoryCompactResult?: SessionMemoryCompactRunResult;
    sessionMemoryState?: SessionMemoryState;
    microcompactAnalysis?: MicrocompactAnalysisResult;
    microcompactAppliedCandidates: MicrocompactCandidate[];
    microcompactStats?: MicrocompactStats;
    toolResultStateChanged: boolean;
    microcompactStateChanged: boolean;
    sessionMemoryStateChanged: boolean;
}
