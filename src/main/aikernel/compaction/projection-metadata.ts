import {
    isCompactBoundaryMessage,
    type ChatMessage,
    type CompactBoundaryProjectionMetadata,
    type CompactProjectionScope,
    type CompactSummarySegment
} from '../messages.js';

function addScope(scopes: Set<CompactProjectionScope>, scope: CompactProjectionScope): void {
    scopes.add(scope);
}

function addGoalId(goalIds: Set<string>, goalId: unknown): void {
    if (typeof goalId === 'string' && goalId.trim().length > 0) {
        goalIds.add(goalId);
    }
}

function selectProjectionPolicy(
    scopes: CompactProjectionScope[]
): CompactBoundaryProjectionMetadata['projectionPolicy'] {
    if (scopes.length !== 1) {
        return 'mixed_scoped';
    }
    return scopes[0] === 'goal' ? 'goal_only' : 'full_transcript';
}

export function buildCompactBoundaryProjectionMetadata(
    messages: readonly ChatMessage[]
): CompactBoundaryProjectionMetadata {
    const scopes = new Set<CompactProjectionScope>();
    const goalIds = new Set<string>();

    for (const message of messages) {
        if (isCompactBoundaryMessage(message)) {
            const segments = message.metadata.summarySegments;
            if (segments && segments.length > 0) {
                for (const segment of segments) {
                    addScope(scopes, segment.scope);
                    addGoalId(goalIds, segment.goalId);
                }
                continue;
            }

            const projection = message.metadata.projection;
            if (projection) {
                for (const scope of projection.summarizedScopes) {
                    addScope(scopes, scope);
                }
                for (const goalId of projection.summarizedGoalIds ?? []) {
                    addGoalId(goalIds, goalId);
                }
                continue;
            }

            addScope(scopes, 'global');
            continue;
        }

        const scope = message.metadata?.scope;
        if (scope === 'goal') {
            addScope(scopes, 'goal');
            addGoalId(goalIds, message.metadata?.execution?.controllerId);
        } else {
            addScope(scopes, 'global');
        }
    }

    const summarizedScopes = Array.from(scopes);
    if (summarizedScopes.length === 0) {
        summarizedScopes.push('global');
    }

    return {
        projectionPolicy: selectProjectionPolicy(summarizedScopes),
        summarizedScopes,
        ...(goalIds.size > 0 ? { summarizedGoalIds: Array.from(goalIds) } : {})
    };
}

type SegmentBucket = {
    scope: CompactProjectionScope;
    goalId?: string;
    startMessageId?: string;
    endMessageId?: string;
    parts: string[];
};

function getMessageStableId(message: ChatMessage): string | undefined {
    if (isCompactBoundaryMessage(message)) {
        return message.metadata.boundary_id;
    }
    const id = (message as { message_id?: unknown }).message_id;
    return typeof id === 'string' ? id : undefined;
}

function segmentKey(scope: CompactProjectionScope, goalId?: string): string {
    return `${scope}:${goalId ?? ''}`;
}

function addSegmentPart(
    buckets: Map<string, SegmentBucket>,
    scope: CompactProjectionScope,
    goalId: string | undefined,
    text: string,
    startMessageId?: string,
    endMessageId?: string
): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const key = segmentKey(scope, goalId);
    let bucket = buckets.get(key);
    if (!bucket) {
        bucket = { scope, ...(goalId ? { goalId } : {}), parts: [] };
        buckets.set(key, bucket);
    }
    bucket.startMessageId ??= startMessageId;
    bucket.endMessageId = endMessageId ?? bucket.endMessageId;
    bucket.parts.push(trimmed);
}

function addMessageSegment(buckets: Map<string, SegmentBucket>, message: ChatMessage, text: string): void {
    if (isCompactBoundaryMessage(message)) {
        const segments = message.metadata.summarySegments;
        if (segments && segments.length > 0) {
            for (const segment of segments) {
                addSegmentPart(
                    buckets,
                    segment.scope,
                    segment.goalId,
                    segment.text,
                    segment.startMessageId,
                    segment.endMessageId
                );
            }
            return;
        }

        const projection = message.metadata.projection;
        const goalIds = projection?.summarizedGoalIds ?? [];
        if (
            projection &&
            projection.summarizedScopes.length === 1 &&
            projection.summarizedScopes[0] === 'goal' &&
            goalIds.length === 1
        ) {
            addSegmentPart(buckets, 'goal', goalIds[0], text, getMessageStableId(message), getMessageStableId(message));
            return;
        }
        if (projection && projection.summarizedScopes.length === 1 && projection.summarizedScopes[0] === 'global') {
            addSegmentPart(
                buckets,
                'global',
                undefined,
                text,
                getMessageStableId(message),
                getMessageStableId(message)
            );
            return;
        }

        addSegmentPart(buckets, 'global', undefined, text, getMessageStableId(message), getMessageStableId(message));
        return;
    }

    const id = getMessageStableId(message);
    const scope = message.metadata?.scope;
    if (scope === 'goal') {
        const goalId = message.metadata?.execution?.controllerId;
        addSegmentPart(buckets, 'goal', goalId, text, id, id);
        return;
    }
    addSegmentPart(buckets, 'global', undefined, text, id, id);
}

export function buildCompactSummarySegments(
    messages: readonly ChatMessage[],
    serializeMessage: (message: ChatMessage) => string
): CompactSummarySegment[] | undefined {
    const buckets = new Map<string, SegmentBucket>();
    for (const message of messages) {
        addMessageSegment(buckets, message, serializeMessage(message));
    }

    const segments = Array.from(buckets.values()).map((bucket) => ({
        scope: bucket.scope,
        ...(bucket.goalId ? { goalId: bucket.goalId } : {}),
        ...(bucket.startMessageId ? { startMessageId: bucket.startMessageId } : {}),
        ...(bucket.endMessageId ? { endMessageId: bucket.endMessageId } : {}),
        text: bucket.parts.join('\n\n---\n\n')
    }));
    return segments.length > 0 ? segments : undefined;
}
