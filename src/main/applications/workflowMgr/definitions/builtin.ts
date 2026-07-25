/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 职责：提供不可变的内置 Workflow Definition。
 */

import {
    computeWorkflowRevision,
    type WorkflowDefinition,
    type WorkflowPhaseDefinition
} from '../../../aikernel/workflow.js';
import { t } from '../../../../locale/index.js';

const DEEP_RESEARCH_SEARCH_LIMIT = 5;
const DEEP_RESEARCH_FETCH_LIMIT = 5;
const DEEP_RESEARCH_VERIFY_VOTES_PER_CLAIM = 3;

const DEEP_RESEARCH_MVP_POLICY = Object.freeze({
    targetSearchAngles: DEEP_RESEARCH_SEARCH_LIMIT,
    minSearchAngles: 1,
    maxSearchAngles: DEEP_RESEARCH_SEARCH_LIMIT,
    searchResultsPerAngle: { min: 1, max: 2 },
    claimsPerSource: { min: 1, max: 2 },
    maxFetchSources: DEEP_RESEARCH_FETCH_LIMIT,
    maxVerifyClaims: DEEP_RESEARCH_FETCH_LIMIT,
    votesPerClaim: DEEP_RESEARCH_VERIFY_VOTES_PER_CLAIM,
    refutationsRequired: 2
});

function createDeepResearchPhases(): WorkflowPhaseDefinition[] {
    return [
        {
            name: t('workflow.deepResearch.phase.scope'),
            description: t('workflow.deepResearch.phase.scopeDescription')
        },
        {
            name: t('workflow.deepResearch.phase.search'),
            description: t('workflow.deepResearch.phase.searchDescription')
        },
        {
            name: t('workflow.deepResearch.phase.fetch'),
            description: t('workflow.deepResearch.phase.fetchDescription')
        },
        {
            name: t('workflow.deepResearch.phase.verify'),
            description: t('workflow.deepResearch.phase.verifyDescription')
        },
        {
            name: t('workflow.deepResearch.phase.synthesize'),
            description: t('workflow.deepResearch.phase.synthesizeDescription')
        }
    ];
}

function createDeepResearchScript(phases: WorkflowPhaseDefinition[]): string {
    const phaseNames = phases.map((phase) => JSON.stringify(phase.name));
    return `
const POLICY = ${JSON.stringify(DEEP_RESEARCH_MVP_POLICY)};
const QUESTION = typeof args.query === 'string' ? args.query.trim() : '';
if (!QUESTION) {
    throw new Error('deep-research requires args.query');
}

const SCOPE_SCHEMA = {
    type: 'object',
    properties: {
        question: { type: 'string' },
        summary: { type: 'string' },
        angles: {
            type: 'array',
            minItems: POLICY.minSearchAngles,
            maxItems: POLICY.maxSearchAngles,
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string' },
                    query: { type: 'string' },
                    rationale: { type: 'string' }
                },
                required: ['label', 'query']
            }
        }
    },
    required: ['question', 'angles']
};
const SEARCH_SCHEMA = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            maxItems: POLICY.searchResultsPerAngle.max,
            items: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    title: { type: 'string' },
                    snippet: { type: 'string' },
                    relevance: { enum: ['high', 'medium', 'low'] }
                },
                required: ['url', 'title', 'relevance']
            }
        }
    },
    required: ['results']
};
const EXTRACT_SCHEMA = {
    type: 'object',
    properties: {
        sourceQuality: { enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'] },
        publishDate: { type: 'string' },
        claims: {
            type: 'array',
            maxItems: POLICY.claimsPerSource.max,
            items: {
                type: 'object',
                properties: {
                    claim: { type: 'string' },
                    quote: { type: 'string' },
                    importance: { enum: ['central', 'supporting', 'tangential'] }
                },
                required: ['claim', 'quote', 'importance']
            }
        }
    },
    required: ['claims', 'sourceQuality']
};
const VERDICT_SCHEMA = {
    type: 'object',
    properties: {
        refuted: { type: 'boolean' },
        evidence: { type: 'string' },
        confidence: { enum: ['high', 'medium', 'low'] },
        correctedClaim: { type: 'string' },
        counterSources: { type: 'array', items: { type: 'string' } }
    },
    required: ['refuted', 'evidence', 'confidence']
};
const REPORT_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
        confidence: { enum: ['high', 'medium', 'low'] },
        findings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    claim: { type: 'string' },
                    confidence: { enum: ['high', 'medium', 'low'] },
                    sources: { type: 'array', items: { type: 'string' } },
                    evidence: { type: 'string' }
                },
                required: ['claim', 'confidence', 'sources', 'evidence']
            }
        },
        caveats: { type: 'string' },
        openQuestions: { type: 'array', items: { type: 'string' } }
    },
    required: ['summary', 'confidence', 'findings', 'caveats']
};

const objectValue = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const arrayValue = value => Array.isArray(value) ? value : [];
const textValue = value => typeof value === 'string' ? value.trim() : '';
const payloadOf = result => result && result.status === 'success' ? objectValue(result.output) : {};
const normalizeUrl = url => textValue(url).toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/^www\\./, '')
    .split(/[?#]/)[0]
    .replace(/\\/$/, '');
const searchCandidateIdentity = url => textValue(url);
const hostOf = url => normalizeUrl(url).split('/')[0] || 'unknown';
const safeAgent = async (prompt, options) => {
    try {
        return await agent(prompt, options);
    } catch {
        return null;
    }
};

await phase(${phaseNames[0]});
const scopeResult = await safeAgent(
    'Decompose this research question into complementary search angles.\\n\\n' +
    '## Question\\n' + QUESTION + '\\n\\n' +
    'Generate about ' + POLICY.targetSearchAngles + ' distinct web search queries that cover different evidence dimensions. ' +
    'Use fewer only when the question is narrow. Avoid redundant angles and match labels to the user language. ' +
    'Return {question, summary, angles:[{label,query,rationale}]}. Structured output only.',
    {
        title: 'scope',
        allowedTools: [],
        reasoningEffort: 'high',
        outputSchema: SCOPE_SCHEMA
    }
);
const scopeOutput = payloadOf(scopeResult);
const angles = arrayValue(scopeOutput.angles)
    .map((raw, index) => {
        const item = objectValue(raw);
        const query = textValue(item.query);
        return query ? {
            label: textValue(item.label) || 'angle ' + (index + 1),
            query,
            rationale: textValue(item.rationale)
        } : null;
    })
    .filter(Boolean)
    .slice(0, POLICY.maxSearchAngles);
if (angles.length === 0) {
    throw new Error('deep-research scope agent returned no executable search angles');
}

await phase(${phaseNames[1]});
const searchEntries = await Promise.all(angles.map(async angle => ({
    angle,
    result: await safeAgent(
        '## Web Searcher: ' + angle.label + '\\n\\n' +
        'Research question: "' + QUESTION + '"\\n' +
        'Search query: ' + angle.query + '\\n' +
        'Rationale: ' + angle.rationale + '\\n\\n' +
        'Use web search and return the top ' + POLICY.searchResultsPerAngle.min + '-' +
        POLICY.searchResultsPerAngle.max + ' relevant results. Prefer authoritative sources, skip SEO spam, ' +
        'and return {results:[{url,title,snippet,relevance}]}. Structured output only.',
        {
            title: 'search:' + angle.label,
            allowedTools: ['WebSearch'],
            reasoningEffort: 'low',
            outputSchema: SEARCH_SCHEMA
        }
    )
})));
const relevanceRank = { high: 0, medium: 1, low: 2 };
const seenUrls = new Set();
const discoveredSources = [];
for (const entry of searchEntries) {
    const results = arrayValue(payloadOf(entry.result).results)
        .map(objectValue)
        .filter(item => textValue(item.url) && textValue(item.title))
        .sort((left, right) =>
            (relevanceRank[left.relevance] ?? 9) - (relevanceRank[right.relevance] ?? 9)
        );
    for (const source of results) {
        const identity = searchCandidateIdentity(source.url);
        if (!identity || seenUrls.has(identity)) continue;
        seenUrls.add(identity);
        discoveredSources.push({
            url: textValue(source.url),
            title: textValue(source.title),
            snippet: textValue(source.snippet),
            relevance: textValue(source.relevance) || 'medium',
            angle: entry.angle.label,
            relevanceRank: relevanceRank[source.relevance] ?? 2,
            discoveryOrder: discoveredSources.length
        });
    }
}
const candidateSources = discoveredSources
    .sort((left, right) =>
        (left.relevanceRank - right.relevanceRank) ||
        (left.discoveryOrder - right.discoveryOrder)
    )
    .slice(0, POLICY.maxFetchSources);
if (candidateSources.length === 0) {
    throw new Error('deep-research search agents returned no usable sources');
}

await phase(${phaseNames[2]});
const fetchedSources = (await Promise.all(candidateSources.map(async source => {
    const extraction = await safeAgent(
        '## Source Extractor\\n\\n' +
        'Research question: "' + QUESTION + '"\\n' +
        'Fetch this source and extract ' + POLICY.claimsPerSource.min + '-' +
        POLICY.claimsPerSource.max + ' falsifiable, quote-supported claims.\\n' +
        'URL: ' + source.url + '\\nTitle: ' + source.title + '\\n\\n' +
        'Assess source quality and return {sourceQuality,publishDate,claims:[{claim,quote,importance}]}. ' +
        'If the page is unavailable or irrelevant, return claims:[] and sourceQuality:"unreliable".',
        {
            title: 'fetch:' + (source.title.slice(0, 80) || hostOf(source.url)),
            allowedTools: ['webFetch'],
            reasoningEffort: 'low',
            outputSchema: EXTRACT_SCHEMA
        }
    );
    if (!extraction) return null;
    const output = payloadOf(extraction);
    return {
        url: source.url,
        title: source.title,
        angle: source.angle,
        sourceQuality: textValue(output.sourceQuality) || 'unreliable',
        publishDate: textValue(output.publishDate),
        claims: arrayValue(output.claims).map(rawClaim => {
            const claim = objectValue(rawClaim);
            return {
                claim: textValue(claim.claim),
                quote: textValue(claim.quote),
                importance: textValue(claim.importance) || 'supporting',
                sourceUrl: source.url,
                sourceTitle: source.title,
                sourceQuality: textValue(output.sourceQuality) || 'unreliable'
            };
        }).filter(claim => claim.claim && claim.quote)
    };
}))).filter(Boolean);
const importanceRank = { central: 0, supporting: 1, tangential: 2 };
const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
const claims = fetchedSources
    .flatMap(source => source.claims)
    .sort((left, right) =>
        ((importanceRank[left.importance] ?? 9) - (importanceRank[right.importance] ?? 9)) ||
        ((qualityRank[left.sourceQuality] ?? 9) - (qualityRank[right.sourceQuality] ?? 9))
    )
    .slice(0, POLICY.maxVerifyClaims);

await phase(${phaseNames[3]});
const votedClaims = await Promise.all(claims.map(async claim => {
    const verdictResults = await Promise.all(
        Array.from({ length: POLICY.votesPerClaim }, (_, voteIndex) => safeAgent(
            '## Adversarial Claim Verifier (voter ' + (voteIndex + 1) + '/' +
            POLICY.votesPerClaim + ')\\n\\n' +
            'Try to refute this claim independently. At least ' + POLICY.refutationsRequired +
            '/' + POLICY.votesPerClaim + ' refutations eliminate it.\\n' +
            'Research question: ' + QUESTION + '\\n' +
            'Claim: "' + claim.claim + '"\\n' +
            'Source: ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\\n' +
            'Supporting quote: "' + claim.quote + '"\\n\\n' +
            'Check for contradiction, weak sourcing, outdated evidence, unsupported inference, or cherry-picking. ' +
            'When credible counter-evidence refutes the claim, provide the evidence-backed corrected claim and exact source URLs. ' +
            'Use refuted=true with low confidence when evidence is insufficient. ' +
            'Return {refuted,evidence,confidence,correctedClaim,counterSources}.',
            {
                title: 'v' + voteIndex + ':' + claim.claim.slice(0, 40),
                allowedTools: ['WebSearch', 'webFetch'],
                reasoningEffort: 'low',
                outputSchema: VERDICT_SCHEMA
            }
        ))
    );
    const verdicts = verdictResults
        .map(payloadOf)
        .filter(verdict => typeof verdict.refuted === 'boolean')
        .map(verdict => ({
            ...verdict,
            refuted: verdict.refuted || verdict.confidence === 'low',
            correctedClaim: textValue(verdict.correctedClaim),
            counterSources: arrayValue(verdict.counterSources).map(textValue).filter(Boolean)
        }));
    const refutedVotes = verdicts.filter(verdict => verdict.refuted).length;
    const hasFullQuorum = verdicts.length === POLICY.votesPerClaim;
    return {
        ...claim,
        verdicts,
        refutedVotes,
        survives: hasFullQuorum && refutedVotes < POLICY.refutationsRequired
    };
}));
const confirmed = votedClaims.filter(claim => claim.survives);
const killed = votedClaims.filter(claim => !claim.survives);
const corrections = killed.flatMap(claim => claim.verdicts
    .filter(verdict =>
        verdict.refuted && verdict.correctedClaim && verdict.counterSources.length > 0 && textValue(verdict.evidence)
    )
    .map(verdict => ({
        originalClaim: claim.claim,
        correctedClaim: verdict.correctedClaim,
        evidence: textValue(verdict.evidence),
        confidence: textValue(verdict.confidence) || 'low',
        sources: verdict.counterSources
    }))
);

await phase(${phaseNames[4]});
const confirmedBlock = confirmed.map((claim, index) =>
    '### [' + index + '] ' + claim.claim + '\\n' +
    'Vote: ' + (claim.verdicts.length - claim.refutedVotes) + '-' + claim.refutedVotes +
    ' · Source: ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\\n' +
    'Quote: "' + claim.quote + '"'
).join('\\n\\n') || 'No original claim survived verification.';
const correctionBlock = corrections.map((correction, index) =>
    '### [' + index + '] ' + correction.correctedClaim + '\\n' +
    'Corrects: "' + correction.originalClaim + '"\\n' +
    'Confidence: ' + correction.confidence + '\\n' +
    'Evidence: ' + correction.evidence + '\\n' +
    'Sources: ' + correction.sources.join(', ')
).join('\\n\\n') || 'No evidence-backed correction was produced.';
const sourceBlock = fetchedSources.map(source =>
    '- ' + source.title + ' · ' + source.url + ' (' + source.sourceQuality + ')'
).join('\\n') || 'No source was fetched successfully.';
const synthesisResult = await safeAgent(
    '## Synthesis: research report\\n\\n' +
    'Question: ' + QUESTION + '\\n\\n' +
    '## Confirmed claims\\n' + confirmedBlock + '\\n\\n' +
    '## Evidence-backed corrections from refuted claims\\n' + correctionBlock + '\\n\\n' +
    '## Fetched sources\\n' + sourceBlock + '\\n\\n' +
    'Build findings from confirmed claims and evidence-backed corrections. Merge semantic duplicates, ' +
    'group findings so they answer the question, assign confidence, write a concise executive summary, ' +
    'and state evidence gaps in caveats and open questions. ' +
    'Return {summary,confidence,findings:[{claim,confidence,sources,evidence}],caveats,openQuestions}.',
    {
        title: 'synthesize',
        allowedTools: [],
        reasoningEffort: 'high',
        outputSchema: REPORT_SCHEMA
    }
);
const synthesis = payloadOf(synthesisResult);
const finalReport = {
    stage: 'final',
    answer: textValue(synthesis.summary) ||
        'The available evidence was insufficient for a synthesized answer.',
    confidence: textValue(synthesis.confidence) || 'low',
    findings: arrayValue(synthesis.findings),
    caveats: textValue(synthesis.caveats),
    openQuestions: arrayValue(synthesis.openQuestions),
    refuted: killed.map(claim => ({
        claim: claim.claim,
        source: claim.sourceUrl,
        vote: (claim.verdicts.length - claim.refutedVotes) + '-' + claim.refutedVotes
    })),
    corrections,
    sources: fetchedSources.map(source => ({
        url: source.url,
        title: source.title,
        quality: source.sourceQuality,
        angle: source.angle,
        claimCount: source.claims.length
    })),
    stats: {
        angles: angles.length,
        sourcesFetched: fetchedSources.length,
        claimsVerified: votedClaims.length,
        confirmed: confirmed.length,
        killed: killed.length,
        corrections: corrections.length,
        agentCalls: 1 + angles.length + fetchedSources.length +
            (votedClaims.length * POLICY.votesPerClaim) + 1
    }
};
await report(finalReport);
return finalReport;
`.trim();
}

const CREATED_AT = '2026-07-19T00:00:00.000Z';

export function createBuiltinWorkflows(): WorkflowDefinition[] {
    const phases = createDeepResearchPhases();
    const script = createDeepResearchScript(phases);
    const inputSchema = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                minLength: 1
            }
        },
        required: ['query'],
        additionalProperties: false
    };
    return [
        {
            id: 'builtin-deep-research',
            revision: computeWorkflowRevision({ script, inputSchema, phases }),
            name: 'deep-research',
            description: t('workflow.deepResearch.description'),
            whenToUse: t('workflow.deepResearch.whenToUse'),
            phases,
            script,
            inputSchema,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT
        }
    ];
}
