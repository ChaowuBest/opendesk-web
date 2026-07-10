import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getGoalEvaluationDisplayKind,
    getLatestGoalEvaluationDisplay,
    normalizeGoalEvaluationDisplay
} from '../../../common/goal/evaluation-display.js';

test('normalizeGoalEvaluationDisplay normalizes fields and ignores nextPrompt', () => {
    const normalized = normalizeGoalEvaluationDisplay({
        evaluationId: 'eval-1',
        goalId: 'goal-1',
        goalRevision: 2,
        anchorMessageId: 'msg-1',
        anchorMessageIndex: 3,
        phase: 'end',
        status: 'not_met',
        message: '  keep going  ',
        evidence: [' done ', '', 1, ' pending '],
        startedAt: '2026-01-01T00:00:00.000Z',
        evaluatedAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        nextPrompt: 'internal only'
    });

    assert.deepEqual(normalized, {
        evaluationId: 'eval-1',
        goalId: 'goal-1',
        goalRevision: 2,
        anchorMessageId: 'msg-1',
        anchorMessageIndex: 3,
        phase: 'end',
        status: 'not_met',
        message: 'keep going',
        evidence: ['done', 'pending'],
        startedAt: '2026-01-01T00:00:00.000Z',
        evaluatedAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        timestamp: '2026-01-01T00:00:02.000Z'
    });
    assert.equal('nextPrompt' in normalized, false);
});

test('normalizeGoalEvaluationDisplay defaults start phase to running', () => {
    assert.deepEqual(normalizeGoalEvaluationDisplay(undefined), {
        phase: 'start',
        status: 'running',
        message: '',
        evidence: []
    });
});

test('getLatestGoalEvaluationDisplay prefers evaluation records over lastEvaluation', () => {
    const latest = getLatestGoalEvaluationDisplay({
        evaluations: [
            { phase: 'end', status: 'met', message: 'old', evaluatedAt: '2026-01-01T00:00:00.000Z' },
            { phase: 'end', status: 'blocked', message: 'new', evaluatedAt: '2026-01-01T00:00:01.000Z' }
        ],
        lastEvaluation: {
            status: 'not_met',
            reason: 'fallback'
        }
    });

    assert.equal(latest?.status, 'blocked');
    assert.equal(latest?.message, 'new');
});

test('getLatestGoalEvaluationDisplay normalizes lastEvaluation fallback', () => {
    const latest = getLatestGoalEvaluationDisplay({
        lastEvaluation: {
            status: 'not_met',
            reason: 'needs more work',
            evidence: ['first'],
            evaluatedAt: '2026-01-01T00:00:00.000Z'
        }
    });

    assert.equal(latest?.phase, 'end');
    assert.equal(latest?.status, 'not_met');
    assert.equal(latest?.message, 'needs more work');
    assert.deepEqual(latest?.evidence, ['first']);
});

test('getGoalEvaluationDisplayKind maps statuses consistently', () => {
    assert.equal(getGoalEvaluationDisplayKind({ phase: 'start', status: 'running' }), 'running');
    assert.equal(getGoalEvaluationDisplayKind({ phase: 'end', status: 'met' }), 'success');
    assert.equal(getGoalEvaluationDisplayKind({ phase: 'end', status: 'not_met' }), 'warning');
    assert.equal(getGoalEvaluationDisplayKind({ phase: 'end', status: 'blocked' }), 'danger');
    assert.equal(getGoalEvaluationDisplayKind({ phase: 'end', status: 'unknown' }), 'neutral');
});
