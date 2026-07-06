import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readJson(relativePath) {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function validatePhase(scenarios, resultPath, phase) {
    assert.ok(existsSync(resultPath), `missing Gate 4-7 ${phase} behavior evidence file: ${resultPath}`);

    const results = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(results.schemaVersion, 1);
    assert.equal(results.phase, phase);
    assert.ok(Array.isArray(results.results), `${phase} behavior evidence must contain results[]`);

    const resultById = new Map(results.results.map((result) => [result.scenarioId, result]));
    const failures = [];

    for (const scenario of scenarios.scenarios) {
        const result = resultById.get(scenario.id);
        if (!result) {
            failures.push(`${scenario.id}:missing`);
            continue;
        }
        if (result.status !== scenarios.requiredResultStatus) {
            failures.push(`${scenario.id}:${result.status ?? 'missing-status'}`);
        }
        for (const field of ['executedAt', 'environment', 'evidence']) {
            if (typeof result[field] !== 'string' || result[field].trim().length === 0) {
                failures.push(`${scenario.id}:missing-${field}`);
            }
        }
    }

    assert.deepEqual(failures, []);
    return results;
}

test('Gate 4-7 behavior scenarios have comparable baseline and post-migration evidence', () => {
    const scenarios = readJson('src/tests/pi-tui-migration/behavior-smoke-scenarios.json');
    const baselinePath = path.join(repoRoot, scenarios.resultFiles.baselineCurrent);
    const postPath = path.join(repoRoot, scenarios.resultFiles.postMigration);
    const baseline = validatePhase(scenarios, baselinePath, 'baseline_current');
    const post = validatePhase(scenarios, postPath, 'post_migration');

    const baselineById = new Map(baseline.results.map((result) => [result.scenarioId, result]));
    const postById = new Map(post.results.map((result) => [result.scenarioId, result]));
    const failures = [];

    for (const scenario of scenarios.scenarios) {
        const before = baselineById.get(scenario.id);
        const after = postById.get(scenario.id);
        if (before?.status !== 'passed' || after?.status !== 'passed') {
            failures.push(`${scenario.id}:baseline-${before?.status ?? 'missing'}-post-${after?.status ?? 'missing'}`);
        }
    }

    assert.deepEqual(failures, []);
});
