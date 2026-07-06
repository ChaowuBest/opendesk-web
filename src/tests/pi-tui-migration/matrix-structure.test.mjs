import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readJson(relativePath) {
    return JSON.parse(readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

const expectedRules = [
    'autocomplete-item',
    'autocomplete-provider',
    'box-component',
    'combined-autocomplete-provider',
    'component-interface',
    'editor-component',
    'editor-theme',
    'focusable-interface',
    'input-component',
    'key-helper',
    'key-id-type',
    'loader-component',
    'markdown-component',
    'markdown-theme',
    'overlay-handle',
    'process-terminal',
    'select-item-type',
    'select-list-component',
    'select-list-theme',
    'slash-command-type',
    'tui-class',
    'terminal-type',
    'text-component',
    'is-key-release',
    'matches-key',
    'parse-key',
    'package-scope-import',
    'editor-keybindings-manager',
    'get-editor-keybindings',
    'set-editor-keybindings',
    'action-delete-char-backward',
    'action-select-up',
    'action-select-down',
    'action-select-page-up',
    'action-select-page-down',
    'action-select-confirm',
    'action-select-cancel',
    'action-input-newline',
    'action-input-submit',
    'action-input-tab',
    'rendering-utils',
    'overlay-focus',
    'jest-mocks',
    'documentation-references'
];

test('migration matrix contains the full replacement-map rule universe', () => {
    const matrix = readJson('src/tests/pi-tui-migration/migration-test-matrix.json');
    assert.equal(matrix.schemaVersion, 1);
    assert.deepEqual(Object.keys(matrix.rules).sort(), expectedRules.slice().sort());
});

test('each matrix rule declares gates, risk, and validation modes', () => {
    const matrix = readJson('src/tests/pi-tui-migration/migration-test-matrix.json');
    const knownGates = new Set(Object.keys(matrix.gates));
    for (const [ruleId, rule] of Object.entries(matrix.rules)) {
        assert.ok(Array.isArray(rule.gates) && rule.gates.length > 0, `${ruleId} lacks gates`);
        assert.ok(
            rule.gates.every((gate) => knownGates.has(gate)),
            `${ruleId} references an unknown gate`
        );
        assert.ok(['low', 'medium', 'high'].includes(rule.risk), `${ruleId} has invalid risk`);
        assert.ok(Array.isArray(rule.mode) && rule.mode.length > 0, `${ruleId} lacks validation mode`);
    }
});

test('Gate 4-7 have required behavior scenarios and result evidence mapping', () => {
    const evidence = readJson('src/tests/pi-tui-migration/gate-evidence-map.json');
    const scenarios = readJson('src/tests/pi-tui-migration/behavior-smoke-scenarios.json');
    const scenarioIds = new Set(scenarios.scenarios.map((scenario) => scenario.id));

    for (const gate of ['gate4', 'gate5', 'gate6', 'gate7']) {
        const requiredScenarios = evidence.gates[gate]?.requiredScenarios;
        assert.ok(Array.isArray(requiredScenarios) && requiredScenarios.length > 0, `${gate} lacks required scenarios`);
        assert.ok(
            requiredScenarios.every((scenarioId) => scenarioIds.has(scenarioId)),
            `${gate} references a missing behavior scenario`
        );
    }
    assert.equal(evidence.resultFiles.behaviorBaselineCurrent, scenarios.resultFiles.baselineCurrent);
    assert.equal(evidence.resultFiles.behaviorPostMigration, scenarios.resultFiles.postMigration);
});

test('all behavior-gated rules are covered by at least one behavior scenario', () => {
    const matrix = readJson('src/tests/pi-tui-migration/migration-test-matrix.json');
    const scenarios = readJson('src/tests/pi-tui-migration/behavior-smoke-scenarios.json');
    const coveredRules = new Set(scenarios.scenarios.flatMap((scenario) => scenario.rules));

    const missing = [];
    for (const [ruleId, rule] of Object.entries(matrix.rules)) {
        if (
            rule.gates.some((gate) => ['gate4', 'gate5', 'gate6', 'gate7'].includes(gate)) &&
            !coveredRules.has(ruleId)
        ) {
            missing.push(ruleId);
        }
    }
    assert.deepEqual(missing, []);
});

test('behavior scenarios are executable records, not informal notes', () => {
    const scenarios = readJson('src/tests/pi-tui-migration/behavior-smoke-scenarios.json');
    for (const scenario of scenarios.scenarios) {
        assert.match(scenario.id, /^gate[4-7]-/);
        assert.ok(['real-terminal-or-pty'].includes(scenario.execution), `${scenario.id} has invalid execution`);
        assert.ok(
            Array.isArray(scenario.entrypoints) && scenario.entrypoints.length > 0,
            `${scenario.id} lacks entrypoints`
        );
        assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, `${scenario.id} lacks steps`);
        assert.ok(
            Array.isArray(scenario.assertions) && scenario.assertions.length > 0,
            `${scenario.id} lacks assertions`
        );
        assert.ok(Array.isArray(scenario.rules) && scenario.rules.length > 0, `${scenario.id} lacks covered rules`);
    }
});
