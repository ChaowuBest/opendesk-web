import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    ClickTool,
    GoBackTool,
    GoForwardTool,
    InputTool,
    ListWindowsTool,
    OpenAppTool,
    PressKeyTool,
    ScrollTool,
    SubmitOpenDeskMessageTool,
    SnapshotTool,
    WaitForTool
} from '../../../../main/applications/builtin/skills/use-harmony/tools.js';

test('input passes text to hdc without executing it in a host or device shell', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeUiTestPath = path.join(tempDir, 'uitest');
    const markerPath = path.join(tempDir, 'shell-command-was-executed');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;
    const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'printf "%s\\n" "$@" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ]; then',
                '  shift',
                '  /bin/sh -c "$*"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(fakeUiTestPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$UITEST_ARGS_LOG"\n', {
            mode: 0o755
        });
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;
        process.env.UITEST_ARGS_LOG = uiTestArgsLogPath;
        const inputText = `it's literal: $(touch ${markerPath})`;

        const result = await new InputTool().execute({
            x: 10,
            y: 20,
            text: inputText,
            snapshot: false
        });

        assert.equal(result.status, 'success');
        assert.equal(JSON.parse(result.result).success, true);
        assert.equal(fs.existsSync(markerPath), false, 'tool text must never be evaluated by a shell');
        assert.ok(fs.readFileSync(uiTestArgsLogPath, 'utf8').split('\n').includes(inputText));
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) {
            delete process.env.HDC_ARGS_LOG;
        } else {
            process.env.HDC_ARGS_LOG = originalArgsLog;
        }
        if (originalUiTestArgsLog === undefined) {
            delete process.env.UITEST_ARGS_LOG;
        } else {
            process.env.UITEST_ARGS_LOG = originalUiTestArgsLog;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('concurrent snapshots use distinct local files', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-concurrency-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const layoutPath = path.join(tempDir, 'layout.json');
    const recvLockPath = path.join(tempDir, 'recv-lock');
    const originalPath = process.env.PATH;
    const originalLayoutPath = process.env.HDC_LAYOUT_PATH;
    const originalRecvLockPath = process.env.HDC_RECV_LOCK;
    const originalDateNow = Date.now;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "shell" ]; then',
                '  printf "saved to:/data/local/tmp/layout.json\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  if mkdir "$HDC_RECV_LOCK" 2>/dev/null; then',
                '    sleep 0.2',
                '    cp "$HDC_LAYOUT_PATH" "$4"',
                '  else',
                '    cp "$HDC_LAYOUT_PATH" "$4"',
                '    sleep 0.4',
                '  fi',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(
            layoutPath,
            JSON.stringify({
                attributes: { type: 'root' },
                children: [
                    {
                        attributes: { type: 'window', bundleName: 'com.example.app', text: 'Example' },
                        children: []
                    }
                ]
            })
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_LAYOUT_PATH = layoutPath;
        process.env.HDC_RECV_LOCK = recvLockPath;
        Date.now = () => 123456789;

        const results = await Promise.all([new SnapshotTool().execute({}), new SnapshotTool().execute({})]);

        assert.deepEqual(
            results.map((result) => JSON.parse(result.result).success),
            [true, true]
        );
    } finally {
        Date.now = originalDateNow;
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) {
            delete process.env.HDC_LAYOUT_PATH;
        } else {
            process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        }
        if (originalRecvLockPath === undefined) {
            delete process.env.HDC_RECV_LOCK;
        } else {
            process.env.HDC_RECV_LOCK = originalRecvLockPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('openApp rejects a bundle name containing shell syntax before invoking hdc', async () => {
    const result = await new OpenAppTool().execute({
        bundleName: 'com.example.app; touch /tmp/unexpected-hdc-command'
    });

    assert.equal(result.status, 'error');
});

test('pressKey rejects combinations that exceed the hdc keyEvent limit', async () => {
    const result = await new PressKeyTool().execute({
        key: 'a',
        modifiers: ['Ctrl', 'Alt', 'Shift'],
        snapshot: false
    });

    assert.equal(result.status, 'error');
});

test('submitOpenDeskMessage submits only to an idle task other than its caller', async () => {
    const submitted: string[] = [];
    const targetTask = {
        task_id: 'target-task',
        task_status: 'stopped' as const,
        submitUserMessage: async (text: string) => {
            submitted.push(text);
            return { status: 'ok' as const };
        }
    };
    const tool = new SubmitOpenDeskMessageTool({
        getTask: (taskId) => (taskId === targetTask.task_id ? targetTask : undefined)
    });

    const result = await tool.execute({ taskId: targetTask.task_id, text: 'hello from fallback submit' }, undefined, {
        task_id: 'caller-task'
    } as never);

    assert.equal(result.status, 'success');
    assert.deepEqual(JSON.parse(result.result), { success: true, taskId: 'target-task', submitted: true });
    assert.deepEqual(submitted, ['hello from fallback submit']);
});

test('submitOpenDeskMessage rejects running and caller tasks without submitting', async () => {
    const submitted: string[] = [];
    const runningTask = {
        task_id: 'running-task',
        task_status: 'running' as const,
        submitUserMessage: async (text: string) => {
            submitted.push(text);
            return { status: 'ok' as const };
        }
    };
    const tool = new SubmitOpenDeskMessageTool({
        getTask: () => runningTask
    });

    const runningResult = await tool.execute({ taskId: 'running-task', text: 'must not interrupt' });
    assert.equal(runningResult.status, 'success');
    assert.match(runningResult.result, /message queue/);

    const callerTask = {
        ...runningTask,
        task_status: 'stopped' as const
    };
    const callerTool = new SubmitOpenDeskMessageTool({
        getTask: () => callerTask
    });
    const callerResult = await callerTool.execute(
        { taskId: 'running-task', text: 'must not recurse' },
        undefined,
        callerTask as never
    );
    assert.equal(callerResult.status, 'success');
    assert.match(callerResult.result, /invoked this tool/);
    assert.deepEqual(submitted, []);
});

test(
    'window discovery does not duplicate nested nodes that repeat the same bundle name',
    { concurrency: false },
    async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-snapshot-test-'));
        const fakeHdcPath = path.join(tempDir, 'hdc');
        const layoutPath = path.join(tempDir, 'layout.json');
        const originalPath = process.env.PATH;
        const originalLayoutPath = process.env.HDC_LAYOUT_PATH;

        try {
            fs.writeFileSync(
                fakeHdcPath,
                [
                    '#!/bin/sh',
                    'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                    '  printf "saved to:/data/local/tmp/layout.json\\n"',
                    'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                    '  cp "$HDC_LAYOUT_PATH" "$4"',
                    'fi'
                ].join('\n'),
                { mode: 0o755 }
            );
            fs.writeFileSync(
                layoutPath,
                JSON.stringify({
                    attributes: { type: 'root' },
                    children: [
                        {
                            attributes: {
                                type: 'window',
                                bundleName: 'com.example.app',
                                text: 'Example'
                            },
                            children: [
                                {
                                    attributes: {
                                        type: 'Column',
                                        bundleName: 'com.example.app'
                                    },
                                    children: [
                                        {
                                            attributes: {
                                                type: 'Button',
                                                text: 'Tap',
                                                clickable: 'true',
                                                bounds: '[0,0][100,40]'
                                            },
                                            children: []
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                })
            );
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
            process.env.HDC_LAYOUT_PATH = layoutPath;

            const result = await new SnapshotTool().execute({
                bundleName: 'com.example.app'
            });

            assert.equal(result.status, 'success');
            const parsed = JSON.parse(result.result);
            assert.equal(parsed.success, true);
            assert.equal(parsed.snapshot.match(/button "Tap"/g)?.length, 1);

            const windowsResult = await new ListWindowsTool().execute({});
            assert.equal(windowsResult.status, 'success');
            const parsedWindows = JSON.parse(windowsResult.result);
            assert.equal(parsedWindows.success, true);
            assert.equal(parsedWindows.windows.length, 1);
        } finally {
            process.env.PATH = originalPath;
            if (originalLayoutPath === undefined) {
                delete process.env.HDC_LAYOUT_PATH;
            } else {
                process.env.HDC_LAYOUT_PATH = originalLayoutPath;
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
);
