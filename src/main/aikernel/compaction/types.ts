import type { ChatMessage, CompactSeparatorMessage } from '../messages.js';

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
}

export interface PreparedContextResult {
    activeContext: ActiveContextView;
    shouldCompact: boolean;
    compacted: boolean;
}
