/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuiltinWorkflows } from '../../../../main/applications/workflow/definitions/builtin.js';
import { WorkflowRuntime } from '../../../../main/applications/workflow/run/runtime/host.js';

test('Deep Research is one immutable built-in using the generic five-stage Workflow script', () => {
    const workflows = createBuiltinWorkflows();

    assert.equal(workflows.length, 1);
    assert.equal(workflows[0].id, 'builtin-deep-research');
    assert.equal(workflows[0].name, 'deep-research');
    assert.match(workflows[0].revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(
        workflows[0].phases?.map((phase) => phase.name),
        ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize']
    );
    assert.equal((workflows[0].script.match(/await phase\(/g) ?? []).length, 5);
    assert.match(workflows[0].script, /"targetSearchAngles":5/);
    assert.match(workflows[0].script, /"maxSearchAngles":5/);
    assert.match(workflows[0].script, /"maxFetchSources":5/);
    assert.match(workflows[0].script, /"maxVerifyClaims":5/);
    assert.match(workflows[0].script, /"votesPerClaim":3/);
    assert.match(workflows[0].script, /"refutationsRequired":2/);
    assert.match(workflows[0].script, /hasFullQuorum/);
    assert.match(workflows[0].script, /allowedTools: \['WebSearch'\]/);
    assert.match(workflows[0].script, /allowedTools: \['webFetch'\]/);
    assert.match(workflows[0].script, /allowedTools: \['WebSearch', 'webFetch'\]/);
    assert.match(workflows[0].script, /outputSchema: VERDICT_SCHEMA/);
    new WorkflowRuntime().validateSource(workflows[0].script);
});

test('Deep Research keeps distinct search URLs and synthesizes evidence-backed corrections', async () => {
    const workflow = createBuiltinWorkflows()[0];
    const phases: string[] = [];
    const requests: { prompt: string; title: string }[] = [];
    const reports: unknown[] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const execute = new AsyncFunction('args', 'phase', 'agent', 'report', workflow.script);

    const output = (await execute(
        { query: 'How does the system work?' },
        async (name: string) => {
            phases.push(name);
        },
        async (prompt: string, options: { title?: string }) => {
            const title = options.title ?? '';
            requests.push({ prompt, title });
            if (title === 'scope') {
                return {
                    status: 'success',
                    summary: 'scoped',
                    output: {
                        question: 'How does the system work?',
                        angles: [
                            { label: 'Architecture', query: 'architecture' },
                            { label: 'Runtime', query: 'runtime' }
                        ]
                    }
                };
            }
            if (title === 'search:Architecture') {
                return {
                    status: 'success',
                    summary: 'searched architecture',
                    output: {
                        results: [
                            {
                                url: 'https://search.example/link?url=first',
                                title: 'First source',
                                relevance: 'high'
                            }
                        ]
                    }
                };
            }
            if (title === 'search:Runtime') {
                return {
                    status: 'success',
                    summary: 'searched runtime',
                    output: {
                        results: [
                            {
                                url: 'https://search.example/link?url=first',
                                title: 'Exact duplicate',
                                relevance: 'high'
                            },
                            {
                                url: 'https://search.example/link?url=second',
                                title: 'Second source',
                                relevance: 'medium'
                            }
                        ]
                    }
                };
            }
            if (title.startsWith('fetch:')) {
                const suffix = prompt.includes('url=first') ? 'first' : 'second';
                return {
                    status: 'success',
                    summary: `fetched ${suffix}`,
                    output: {
                        sourceQuality: 'secondary',
                        claims: [
                            {
                                claim: `Original ${suffix} claim`,
                                quote: `Original ${suffix} quote`,
                                importance: 'central'
                            }
                        ]
                    }
                };
            }
            if (title.startsWith('v')) {
                const suffix = prompt.includes('Original first claim') ? 'first' : 'second';
                return {
                    status: 'success',
                    summary: `corrected ${suffix}`,
                    output: {
                        refuted: true,
                        evidence: `Official evidence for ${suffix}`,
                        confidence: 'high',
                        correctedClaim: `Corrected ${suffix} claim`,
                        counterSources: [`https://official.example/${suffix}`]
                    }
                };
            }
            if (title === 'synthesize') {
                return {
                    status: 'success',
                    summary: 'synthesized',
                    output: {
                        summary: 'Corrected research summary',
                        confidence: 'high',
                        findings: [
                            {
                                claim: 'Corrected findings',
                                confidence: 'high',
                                sources: ['https://official.example/first', 'https://official.example/second'],
                                evidence: 'Official evidence'
                            }
                        ],
                        caveats: 'Limited fixture evidence',
                        openQuestions: []
                    }
                };
            }
            throw new Error(`Unexpected agent request: ${title}`);
        },
        async (value: unknown) => {
            reports.push(value);
            return null;
        }
    )) as { answer: string; confidence: string; stats: { sourcesFetched: number } };

    const fetchRequests = requests.filter((request) => request.title.startsWith('fetch:'));
    const synthesisRequest = requests.find((request) => request.title === 'synthesize');
    assert.deepEqual(phases, ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize']);
    assert.equal(fetchRequests.length, 2);
    assert.ok(fetchRequests.some((request) => request.prompt.includes('url=first')));
    assert.ok(fetchRequests.some((request) => request.prompt.includes('url=second')));
    assert.match(synthesisRequest?.prompt ?? '', /Corrected first claim/);
    assert.match(synthesisRequest?.prompt ?? '', /https:\/\/official\.example\/second/);
    assert.equal(output.answer, 'Corrected research summary');
    assert.equal(output.confidence, 'high');
    assert.equal(output.stats.sourcesFetched, 2);
    assert.deepEqual(reports, [output]);
});
