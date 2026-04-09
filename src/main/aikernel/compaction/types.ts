import type { ChatMessage, CompactSeparatorMessage } from '../messages.js';
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
    executeCompact?: () => Promise<void> | void;
    enableToolResultBudget?: boolean;
    taskId?: string;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetChars?: number;
    toolResultBudgetPreviewOptions?: ToolResultPreviewOptions;
    skipToolNames?: Iterable<string>;
}

export interface PreparedContextResult {
    activeContext: ActiveContextView;
    shouldCompact: boolean;
    compacted: boolean;
    budgetApplied: boolean;
    toolResultOverrides: Map<string, string>;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetStats?: ToolResultBudgetProjectionStats;
    toolResultStateChanged: boolean;
}
