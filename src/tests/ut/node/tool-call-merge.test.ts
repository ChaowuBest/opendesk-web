import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';

test('ToolCallMessagePart.push() keeps different valid ids separate when their indices match', () => {
    const part = new ToolCallMessagePart();

    part.push(new ToolCall(0, 'call_pwd', 'terminal-executeBash', '{"command":"pwd"}'));
    part.push(new ToolCall(0, 'call_ls', 'terminal-executeBash', '{"command":"ls"'));
    part.push(new ToolCall(0, '', undefined, '}'));

    assert.equal(part.toolcalls.length, 2);
    assert.equal(part.toolcalls[0].id, 'call_pwd');
    assert.equal(part.toolcalls[0].args_string, '{"command":"pwd"}');
    assert.equal(part.toolcalls[1].id, 'call_ls');
    assert.equal(part.toolcalls[1].args_string, '{"command":"ls"}');
});

test('ToolCallMessagePart.push() fills a missing id by matching the index', () => {
    const part = new ToolCallMessagePart();

    part.push(new ToolCall(0, '', 'readFile', '{"file_path":'));
    part.push(new ToolCall(0, 'call_read', undefined, '"/tmp/example.md"}'));

    assert.equal(part.toolcalls.length, 1);
    assert.equal(part.toolcalls[0].id, 'call_read');
    assert.equal(part.toolcalls[0].args_string, '{"file_path":"/tmp/example.md"}');
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
