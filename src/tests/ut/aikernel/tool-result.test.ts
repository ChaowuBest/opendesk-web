/**
 * ToolResult 的单元测试。
 *
 * 覆盖范围：
 * - safeInvokeCallback: 同步错误捕获
 * - safeInvokeCallback: 异步错误捕获 (async callback rejected)
 * - safeInvokeCallback: 正常回调执行
 * - safeInvokeCallback: 无回调时不抛错
 */

import { AssistantMessage, ToolCallMessagePart } from '../../../main/aikernel/messages';
import { BaseTool, ToolResult } from '../../../main/aikernel/tool';
import { z } from 'zod';

// Mock console.warn 来验证错误日志
const originalWarn = console.warn;
let warnCalls: string[] = [];

beforeEach(() => {
    warnCalls = [];
    console.warn = (...args: unknown[]) => {
        warnCalls.push(args.map((a) => String(a)).join(' '));
    };
});

afterEach(() => {
    console.warn = originalWarn;
});

describe('ToolResult safeInvokeCallback', () => {
    describe('同步错误捕获', () => {
        test('同步抛出的错误被捕获，不影响后续执行', () => {
            const tr = new ToolResult();
            const error = new Error('同步错误测试');

            tr.updatedCallback = () => {
                throw error;
            };

            // 不应该抛出异常
            expect(() => tr.attachResult('test')).not.toThrow();
            expect(tr.result).toBe('test');

            // 应该打印 warn 日志
            expect(warnCalls.length).toBe(1);
            expect(warnCalls[0]).toContain('[ToolResult] updatedCallback error');
            expect(warnCalls[0]).toContain('同步错误测试');
        });

        test('同步错误后仍可继续调用', () => {
            const tr = new ToolResult();
            let callCount = 0;

            tr.updatedCallback = () => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('第一次调用失败');
                }
            };

            tr.attachResult('a');
            tr.attachResult('b');

            // 两次调用都应该执行（虽然第一次抛错）
            expect(callCount).toBe(2);
            expect(tr.result).toBe('ab');
        });
    });

    describe('异步错误捕获', () => {
        test('async 回调 reject 时被捕获，不影响后续执行', async () => {
            const tr = new ToolResult();
            const error = new Error('异步错误测试');

            tr.updatedCallback = async () => {
                throw error;
            };

            // 不应该抛出异常
            expect(() => tr.attachResult('test')).not.toThrow();
            expect(tr.result).toBe('test');

            // 等待 microtask 执行
            await new Promise((resolve) => setTimeout(resolve, 10));

            // 应该打印 warn 日志
            expect(warnCalls.length).toBe(1);
            expect(warnCalls[0]).toContain('[ToolResult] updatedCallback async error');
            expect(warnCalls[0]).toContain('异步错误测试');
        });

        test('返回 rejected promise 的回调被正确处理', async () => {
            const tr = new ToolResult();

            tr.updatedCallback = () => {
                return Promise.reject(new Error('promise reject'));
            };

            expect(() => tr.updateResult('updated')).not.toThrow();
            expect(tr.result).toBe('updated');

            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(warnCalls.length).toBe(1);
            expect(warnCalls[0]).toContain('[ToolResult] updatedCallback async error');
        });

        test('异步回调正常 resolve 时不打印 warn', async () => {
            const tr = new ToolResult();
            let resolved = false;

            tr.updatedCallback = async () => {
                await new Promise((r) => setTimeout(r, 5));
                resolved = true;
            };

            tr.attachResult('ok');

            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(resolved).toBe(true);
            expect(warnCalls.length).toBe(0);
        });
    });

    describe('正常回调执行', () => {
        test('正常同步回调被执行', () => {
            const tr = new ToolResult();
            const results: string[] = [];

            tr.updatedCallback = (r) => {
                results.push(r.result);
            };

            tr.attachResult('a');
            tr.attachResult('b');
            tr.updateResult('c');

            expect(results).toEqual(['a', 'ab', 'c']);
        });

        test('updateResultObject 触发回调', () => {
            const tr = new ToolResult();
            let calledWith: object | undefined;

            tr.updatedCallback = (r) => {
                calledWith = r.result_object;
            };

            tr.updateResultObject({ foo: 'bar' });

            expect(calledWith).toEqual({ foo: 'bar' });
        });

        test('无回调时不抛错', () => {
            const tr = new ToolResult();

            expect(() => tr.attachResult('test')).not.toThrow();
            expect(() => tr.updateResult('test')).not.toThrow();
            expect(() => tr.updateResultObject({})).not.toThrow();
        });
    });

    describe('边界情况', () => {
        test('回调返回非 Promise 对象时不报错', () => {
            const tr = new ToolResult();

            tr.updatedCallback = () => {
                // 返回一个普通对象（非 Promise，但可能有 .catch 方法）
                return { not: 'a promise' };
            };

            expect(() => tr.attachResult('test')).not.toThrow();
            // 不应该有 warn（因为对象没有 .catch 方法或 .catch 不是函数）
            expect(warnCalls.length).toBe(0);
        });

        test('回调返回带 catch 方法的对象时被正确处理', async () => {
            const tr = new ToolResult();
            let catchCalled = false;

            tr.updatedCallback = () => {
                // 返回一个伪 Promise 对象
                return {
                    catch: (fn: (err: unknown) => void) => {
                        catchCalled = true;
                        fn(new Error('fake promise error'));
                    }
                };
            };

            tr.attachResult('test');

            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(catchCalled).toBe(true);
            expect(warnCalls.length).toBe(1);
            expect(warnCalls[0]).toContain('[ToolResult] updatedCallback async error');
        });
    });
});

describe('BaseTool 参数校验', () => {
    test('参数不符合 schema 时不调用 executor', async () => {
        let executed = false;
        const tool = new BaseTool(
            'needsName',
            'Needs name',
            z.object({
                name: z.string().min(1)
            })
        );
        tool.setExecutor(async () => {
            executed = true;
            return 'ok';
        });

        const result = await tool.execute({} as any);

        expect(result.status).toBe('error');
        expect(result.result).toContain('name');
        expect(result.result).not.toContain('trim');
        expect(executed).toBe(false);
    });
});

function parseDelta(delta: object): AssistantMessage {
    return AssistantMessage.parseOpenAIMessage(delta);
}

describe('AssistantMessage tool call streaming', () => {
    test('merges repeated-id tool call deltas instead of creating empty duplicate calls', () => {
        const message = new AssistantMessage();

        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        index: 0,
                        id: 'call_read_1',
                        function: { name: 'readFile', arguments: '{"file_' }
                    }
                ]
            })
        );
        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        index: 0,
                        id: 'call_read_1',
                        function: { name: 'readFile', arguments: 'path":' }
                    }
                ]
            })
        );
        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        index: 0,
                        id: 'call_read_1',
                        function: {
                            name: 'readFile',
                            arguments: '"/tmp/example.md"}'
                        }
                    }
                ]
            })
        );

        expect(message.content).toHaveLength(1);
        const part = message.content[0] as ToolCallMessagePart;
        expect(part.toolcalls).toHaveLength(1);
        expect(part.toolcalls[0].id).toBe('call_read_1');
        expect(part.toolcalls[0].tool_name).toBe('readFile');
        expect(JSON.parse(part.toolcalls[0].args_string)).toEqual({
            file_path: '/tmp/example.md'
        });
    });

    test('continues to merge standard deltas where only the first chunk has an id', () => {
        const message = new AssistantMessage();

        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        index: 0,
                        id: 'call_read_2',
                        function: { name: 'readFile', arguments: '{"file_path":' }
                    }
                ]
            })
        );
        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        index: 0,
                        function: { arguments: '"/tmp/example.md"}' }
                    }
                ]
            })
        );

        const part = message.content[0] as ToolCallMessagePart;
        expect(part.toolcalls).toHaveLength(1);
        expect(part.toolcalls[0].id).toBe('call_read_2');
        expect(JSON.parse(part.toolcalls[0].args_string)).toEqual({ file_path: '/tmp/example.md' });
    });

    test('does not merge no-id no-index tool call chunks into unrelated tools', () => {
        const message = new AssistantMessage();

        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        function: { name: 'readFile', arguments: '{"file_path":"/tmp/a.md"}' }
                    }
                ]
            })
        );
        message.mergeChunk(
            parseDelta({
                tool_calls: [
                    {
                        function: { name: 'executeBash', arguments: '{"command":"pwd"}' }
                    }
                ]
            })
        );

        const part = message.content[0] as ToolCallMessagePart;
        expect(part.toolcalls).toHaveLength(2);
        expect(part.toolcalls.map((tc) => tc.tool_name)).toEqual(['readFile', 'executeBash']);
    });
});
