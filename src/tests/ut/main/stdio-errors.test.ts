import { beforeEach, describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// 只执行入口中的标准输出错误监听器，避免加载 main.ts 启动真实 Electron。
const source = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const registrations = sourceFile.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    const event = call.arguments[0];
    return (
        ['process.stdout.on', 'process.stderr.on'].includes(call.expression.getText(sourceFile)) &&
        event !== undefined &&
        ts.isStringLiteral(event) &&
        event.text === 'error'
    );
});
const script = ts.transpileModule(registrations.map((statement) => statement.getText(sourceFile)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

describe.each(['stdout', 'stderr'] as const)('%s 终端断开错误', (streamName) => {
    let stream: EventEmitter & { isTTY?: boolean };

    beforeEach(() => {
        const stdio = {
            stdout: Object.assign(new EventEmitter(), { isTTY: false as boolean | undefined }),
            stderr: Object.assign(new EventEmitter(), { isTTY: false as boolean | undefined })
        };
        expect(registrations).toHaveLength(2);
        runInNewContext(script, { process: stdio });
        stream = stdio[streamName];
        expect(stream.listenerCount('error')).toBe(1);
    });

    it('忽略关闭终端后产生的 EIO，后续日志错误也不会进入致命异常处理', () => {
        stream.isTTY = true;
        const error = Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' });
        for (let i = 0; i < 3; i++) {
            expect(() => stream.emit('error', error)).not.toThrow();
        }
    });

    it.each([true, undefined])('保留 EPIPE 处理（isTTY=%s）', (isTTY) => {
        stream.isTTY = isTTY;
        const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        expect(() => stream.emit('error', error)).not.toThrow();
    });

    it.each([false, undefined])('不吞掉重定向输出的 EIO（isTTY=%s）', (isTTY) => {
        stream.isTTY = isTTY;
        const error = Object.assign(new Error('write EIO'), { code: 'EIO', syscall: 'write' });
        expect(() => stream.emit('error', error)).toThrow(error);
    });

    it.each(['ENOSPC', 'EBADF'])('不吞掉其他输出错误 %s', (code) => {
        stream.isTTY = true;
        const error = Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });
        expect(() => stream.emit('error', error)).toThrow(error);
    });
});
