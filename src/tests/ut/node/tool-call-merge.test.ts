import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';

test('ToolCallMessagePart.push() merges by index when incoming TC has a different valid id', () => {
    const part = new ToolCallMessagePart();

    // Simulate: model first sends tool call with id="call_old", index=0, empty args
    const tc1 = new ToolCall(0, 'call_old', 'filemgr-readFile', '');
    part.push(tc1);
    assert.equal(part.toolcalls.length, 1);
    assert.equal(part.toolcalls[0].id, 'call_old');
    assert.equal(part.toolcalls[0].args_string, '');

    // Simulate: model re-initializes with a DIFFERENT id but same index
    // This can happen with certain models (e.g., GLM) that re-send tool call
    // initialization chunks with new ids.
    const tc2 = new ToolCall(0, 'call_new', 'filemgr-readFile', '');
    part.push(tc2);

    // Should MERGE into existing TC, NOT create a duplicate
    assert.equal(part.toolcalls.length, 1, 'should not create duplicate ToolCall');
    assert.equal(part.toolcalls[0].id, 'call_new', 'should update to new id');
    assert.equal(part.toolcalls[0].args_string, '', 'should keep empty args (both were empty)');

    // Simulate: subsequent chunks arrive with id="" and incremental args
    const tc3 = new ToolCall(0, '', undefined, '{"file_path": "/tmp/test.ts"}');
    part.push(tc3);

    assert.equal(part.toolcalls.length, 1, 'should still have only one ToolCall');
    assert.equal(part.toolcalls[0].id, 'call_new', 'id should persist');
    assert.equal(part.toolcalls[0].args_string, '{"file_path": "/tmp/test.ts"}', 'args should accumulate correctly');
});

test('ToolCallMessagePart.push() still creates new TC when indices differ', () => {
    const part = new ToolCallMessagePart();

    // First tool call at index 0
    part.push(new ToolCall(0, 'call_a', 'toolA', '{"x":1}'));
    assert.equal(part.toolcalls.length, 1);

    // Second tool call at index 1 with new id - should create NEW entry
    part.push(new ToolCall(1, 'call_b', 'toolB', '{"y":2}'));
    assert.equal(part.toolcalls.length, 2);
    assert.equal(part.toolcalls[0].id, 'call_a');
    assert.equal(part.toolcalls[1].id, 'call_b');
});

test('ToolCallMessagePart.push() merges standard delta chunks (first has id, rest have empty id)', () => {
    const part = new ToolCallMessagePart();

    // Standard streaming pattern: first chunk has id, rest have id=""
    part.push(new ToolCall(0, 'call_read_2', 'readFile', '{"file_path":'));
    part.push(new ToolCall(0, '', undefined, '"/tmp/example.md"}'));

    assert.equal(part.toolcalls.length, 1);
    assert.equal(part.toolcalls[0].id, 'call_read_2');
    assert.equal(part.toolcalls[0].args_string, '{"file_path":"/tmp/example.md"}');
});

test('ToolCallMessagePart.push() handles no-id chunks by index matching', () => {
    const part = new ToolCallMessagePart();

    // Model sends two different tool calls in separate parts with no id
    part.push(new ToolCall(undefined, undefined, 'readFile', '{"file_path":"/tmp/a.md"}'));
    part.push(new ToolCall(undefined, undefined, 'executeBash', '{"command":"pwd"}'));

    // Without valid id or index, each should be treated as separate
    assert.equal(part.toolcalls.length, 2);
    assert.equal(part.toolcalls[0].tool_name, 'readFile');
    assert.equal(part.toolcalls[1].tool_name, 'executeBash');
});
