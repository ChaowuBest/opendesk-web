import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AcpState } from '../../../../main/server/acp/state.js';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-state-test-'));
}

function cleanupTempDir(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('AcpState: returns undefined when no models available', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        const result = state.resolveDefaultModel('opendesk-default', []);
        assert.equal(result, undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: falls back to OpenDesk default when no ACP state exists', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        const result = state.resolveDefaultModel('opendesk-default', ['opendesk-default', 'other-model']);
        assert.equal(result, 'opendesk-default');
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: uses ACP stored model when valid', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        state.setDefaultModel('acp-model');

        const result = state.resolveDefaultModel('opendesk-default', ['acp-model', 'opendesk-default']);
        assert.equal(result, 'acp-model');
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: clears stale ACP model and falls back to OpenDesk default', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        state.setDefaultModel('deleted-model');

        const result = state.resolveDefaultModel('opendesk-default', ['opendesk-default', 'other-model']);
        assert.equal(result, 'opendesk-default');

        // Verify the stale model was cleared
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: falls back to first model when both ACP and OpenDesk defaults are invalid', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        state.setDefaultModel('deleted-acp-model');

        const result = state.resolveDefaultModel('deleted-opendesk-model', ['first-model', 'second-model']);
        assert.equal(result, 'first-model');

        // Verify the stale model was cleared
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: falls back to first model when OpenDesk default is empty', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));

        const result = state.resolveDefaultModel('', ['first-model', 'second-model']);
        assert.equal(result, 'first-model');
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: persists default model to disk', () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'acp.json');
        const state1 = new AcpState(filePath);
        state1.setDefaultModel('persisted-model');

        // Create a new instance reading from the same file
        const state2 = new AcpState(filePath);
        assert.equal(state2.getDefaultModel(), 'persisted-model');

        // Verify file content
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.equal(content.default_model, 'persisted-model');
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: handles missing file gracefully', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'nonexistent.json'));
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: handles corrupted JSON gracefully', () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'acp.json');
        fs.writeFileSync(filePath, '{ invalid json }', 'utf8');

        const state = new AcpState(filePath);
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: handles empty file gracefully', () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'acp.json');
        fs.writeFileSync(filePath, '', 'utf8');

        const state = new AcpState(filePath);
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: handles non-object JSON gracefully', () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'acp.json');
        fs.writeFileSync(filePath, '"just a string"', 'utf8');

        const state = new AcpState(filePath);
        assert.equal(state.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: clearDefaultModel removes the model and persists', () => {
    const dir = createTempDir();
    try {
        const filePath = path.join(dir, 'acp.json');
        const state = new AcpState(filePath);
        state.setDefaultModel('some-model');
        assert.equal(state.getDefaultModel(), 'some-model');

        state.clearDefaultModel();
        assert.equal(state.getDefaultModel(), undefined);

        // Verify persistence
        const state2 = new AcpState(filePath);
        assert.equal(state2.getDefaultModel(), undefined);
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: resolveDefaultModel does not modify state when model is valid', () => {
    const dir = createTempDir();
    try {
        const state = new AcpState(path.join(dir, 'acp.json'));
        state.setDefaultModel('valid-model');

        state.resolveDefaultModel('opendesk-default', ['valid-model', 'opendesk-default']);

        // ACP model should still be set
        assert.equal(state.getDefaultModel(), 'valid-model');
    } finally {
        cleanupTempDir(dir);
    }
});

test('AcpState: singleton getInstance works', () => {
    AcpState.resetInstance();
    try {
        const instance1 = AcpState.getInstance();
        const instance2 = AcpState.getInstance();
        assert.equal(instance1, instance2);
    } finally {
        AcpState.resetInstance();
    }
});
