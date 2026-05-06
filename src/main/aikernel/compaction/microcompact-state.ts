export const MICROCOMPACT_STATE_VERSION = 1;

export type PersistedMicrocompactMode = 'noop' | 'request_override' | 'local_clear';

export interface MicrocompactState {
    version: number;
    lastAssistantCompletedAt?: string;
    lastDecisionAt?: string;
    lastDecisionMode?: PersistedMicrocompactMode;
    lastLocalClearAt?: string;
    lastLocalClearResultIds?: string[];
}

export interface SerializedMicrocompactState {
    version: number;
    last_assistant_completed_at?: string;
    last_decision_at?: string;
    last_decision_mode?: PersistedMicrocompactMode;
    last_local_clear_at?: string;
    last_local_clear_result_ids?: string[];
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(1, Math.floor(value));
}

function normalizeOptionalTimestamp(value: unknown): string | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return undefined;
    }

    return parsed.toISOString();
}

function normalizeOptionalMode(value: unknown): PersistedMicrocompactMode | undefined {
    return value === 'noop' || value === 'request_override' || value === 'local_clear' ? value : undefined;
}

function normalizeOptionalResultIds(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const normalized = Array.from(
        new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))
    );

    return normalized.length > 0 ? normalized : undefined;
}

function createDefaultMicrocompactState(): MicrocompactState {
    return {
        version: MICROCOMPACT_STATE_VERSION
    };
}

function normalizeMicrocompactState(raw: unknown): MicrocompactState {
    const defaults = createDefaultMicrocompactState();
    if (!raw || typeof raw !== 'object') {
        return { ...defaults };
    }

    const candidate = raw as {
        version?: unknown;
        last_assistant_completed_at?: unknown;
        lastAssistantCompletedAt?: unknown;
        last_decision_at?: unknown;
        lastDecisionAt?: unknown;
        last_decision_mode?: unknown;
        lastDecisionMode?: unknown;
        last_local_clear_at?: unknown;
        lastLocalClearAt?: unknown;
        last_local_clear_result_ids?: unknown;
        lastLocalClearResultIds?: unknown;
    };

    return {
        version: normalizePositiveInteger(candidate.version, MICROCOMPACT_STATE_VERSION),
        lastAssistantCompletedAt: normalizeOptionalTimestamp(
            candidate.last_assistant_completed_at ?? candidate.lastAssistantCompletedAt
        ),
        lastDecisionAt: normalizeOptionalTimestamp(candidate.last_decision_at ?? candidate.lastDecisionAt),
        lastDecisionMode: normalizeOptionalMode(candidate.last_decision_mode ?? candidate.lastDecisionMode),
        lastLocalClearAt: normalizeOptionalTimestamp(candidate.last_local_clear_at ?? candidate.lastLocalClearAt),
        lastLocalClearResultIds: normalizeOptionalResultIds(
            candidate.last_local_clear_result_ids ?? candidate.lastLocalClearResultIds
        )
    };
}

export class MicrocompactStates {
    static create(): MicrocompactState {
        return createDefaultMicrocompactState();
    }

    static clone(source: MicrocompactState): MicrocompactState {
        return normalizeMicrocompactState(source);
    }

    static normalize(raw: unknown): MicrocompactState {
        return normalizeMicrocompactState(raw);
    }

    static serialize(state: MicrocompactState): SerializedMicrocompactState {
        const normalized = normalizeMicrocompactState(state);
        return {
            version: normalized.version,
            last_assistant_completed_at: normalized.lastAssistantCompletedAt,
            last_decision_at: normalized.lastDecisionAt,
            last_decision_mode: normalized.lastDecisionMode,
            last_local_clear_at: normalized.lastLocalClearAt,
            last_local_clear_result_ids: normalized.lastLocalClearResultIds
        };
    }

    static deserialize(raw: unknown): MicrocompactState {
        return normalizeMicrocompactState(raw);
    }

    static recordAssistantCompleted(state: MicrocompactState, at: Date = new Date()): MicrocompactState {
        const normalized = normalizeMicrocompactState(state);
        return {
            ...normalized,
            lastAssistantCompletedAt: at.toISOString()
        };
    }

    static recordDecision(
        state: MicrocompactState,
        decision: PersistedMicrocompactMode | { mode: PersistedMicrocompactMode },
        at: Date = new Date()
    ): MicrocompactState {
        const normalized = normalizeMicrocompactState(state);
        const mode = typeof decision === 'string' ? decision : decision.mode;

        return {
            ...normalized,
            lastDecisionAt: at.toISOString(),
            lastDecisionMode: mode
        };
    }

    static recordLocalClear(state: MicrocompactState, resultIds: string[], at: Date = new Date()): MicrocompactState {
        const normalized = normalizeMicrocompactState(state);
        return {
            ...normalized,
            lastLocalClearAt: at.toISOString(),
            lastLocalClearResultIds: normalizeOptionalResultIds(resultIds)
        };
    }
}
