import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import { loadUseHarmonySkill } from '../../../../main/applications/builtin/skills/use-harmony/skill.js';
import {
    AppLifecycleTool,
    ClickTool,
    ChooseFileTool,
    createUseHarmonyToolset,
    DoubleClickTool,
    DropFixtureTool,
    DragTool,
    GoBackTool,
    GoForwardTool,
    InputTool,
    ListWindowsTool,
    OpenAppTool,
    PressKeyTool,
    SelectOptionTool,
    StageFixtureTool,
    LongClickTool,
    ScreenshotTool,
    ScrollTool,
    SnapshotTool,
    WaitForTool
} from '../../../../main/applications/builtin/skills/use-harmony/tools.js';

test('use-harmony skill loader preserves metadata, instructions, and toolset wiring', () => {
    const skill = loadUseHarmonySkill();

    assert.equal(skill.frontmatter.name, 'use-harmony');
    assert.equal(
        skill.frontmatter.description,
        '通过 hdc 操控鸿蒙设备：应用管理、界面快照、点击/滑动/输入等自动化控制能力'
    );
    assert.match(skill.body, /# 鸿蒙设备控制/);
    assert.match(skill.body, /## 核心原则：无障碍优先，截图兜底/);
    assert.match(skill.body, /## 应用管理/);
    assert.equal(skill.toolsets?.length, 1);
    assert.equal(skill.getTool('snapshot')?.name, 'snapshot');
    assert.equal(skill.getTool('openApp')?.name, 'openApp');
});

test('use-harmony toolset exposes fixture staging, native picker, and WebView drop tools', () => {
    const toolset = createUseHarmonyToolset();
    assert.equal(toolset.hasTool('stageFixture'), true);
    assert.equal(toolset.hasTool('chooseFile'), true);
    assert.equal(toolset.hasTool('dropFixture'), true);
    assert.equal(toolset.hasTool('selectOption'), true);
});

test(
    'selectOption opens an accessible dropdown, chooses an option, and verifies the result',
    { concurrency: false },
    async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-select-option-test-'));
        const fakeHdcPath = path.join(tempDir, 'hdc');
        const statePath = path.join(tempDir, 'state');
        const closedLayoutPath = path.join(tempDir, 'closed-layout.json');
        const openLayoutPath = path.join(tempDir, 'open-layout.json');
        const selectedLayoutPath = path.join(tempDir, 'selected-layout.json');
        const argsLogPath = path.join(tempDir, 'hdc-args.log');
        const originalPath = process.env.PATH;
        const originalStatePath = process.env.HDC_SELECT_STATE;
        const originalClosedLayoutPath = process.env.HDC_CLOSED_LAYOUT;
        const originalOpenLayoutPath = process.env.HDC_OPEN_LAYOUT;
        const originalSelectedLayoutPath = process.env.HDC_SELECTED_LAYOUT;
        const originalArgsLog = process.env.HDC_ARGS_LOG;

        const windowWithChildren = (children: unknown[]) => ({
            attributes: {},
            children: [
                {
                    attributes: {
                        type: 'window',
                        bundleName: 'com.develop.opensource.ohpcd.opendesk',
                        visible: 'true'
                    },
                    children
                }
            ]
        });
        const trigger = (text: string, selected = false) => ({
            attributes: {
                type: 'button',
                text,
                bounds: '[100,100][300,160]',
                clickable: 'true',
                visible: 'true',
                ...(selected ? { selected: 'true' } : {})
            },
            children: []
        });

        try {
            fs.writeFileSync(statePath, '0');
            fs.writeFileSync(closedLayoutPath, JSON.stringify(windowWithChildren([trigger('语言')])));
            fs.writeFileSync(
                openLayoutPath,
                JSON.stringify(
                    windowWithChildren([
                        trigger('语言'),
                        {
                            attributes: { type: 'List', bounds: '[80,170][340,330]', visible: 'true' },
                            children: [
                                {
                                    attributes: {
                                        type: 'button',
                                        text: '简体中文',
                                        bounds: '[100,200][300,260]',
                                        clickable: 'true',
                                        visible: 'true'
                                    },
                                    children: []
                                }
                            ]
                        }
                    ])
                )
            );
            fs.writeFileSync(selectedLayoutPath, JSON.stringify(windowWithChildren([trigger('简体中文', true)])));
            fs.writeFileSync(
                fakeHdcPath,
                [
                    '#!/bin/sh',
                    'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                    'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                    '  printf "saved to:/data/local/tmp/layout.json\\n"',
                    'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                    '  state=$(cat "$HDC_SELECT_STATE")',
                    '  if [ "$state" = "0" ]; then cp "$HDC_CLOSED_LAYOUT" "$4";',
                    '  elif [ "$state" = "1" ]; then cp "$HDC_OPEN_LAYOUT" "$4";',
                    '  else cp "$HDC_SELECTED_LAYOUT" "$4"; fi',
                    'elif [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "uiInput" ] && [ "$4" = "click" ]; then',
                    '  state=$(cat "$HDC_SELECT_STATE")',
                    '  if [ "$state" = "0" ]; then printf "1" > "$HDC_SELECT_STATE"; else printf "2" > "$HDC_SELECT_STATE"; fi',
                    '  printf "No Error\\n"',
                    'fi'
                ].join('\n'),
                { mode: 0o755 }
            );
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
            process.env.HDC_SELECT_STATE = statePath;
            process.env.HDC_CLOSED_LAYOUT = closedLayoutPath;
            process.env.HDC_OPEN_LAYOUT = openLayoutPath;
            process.env.HDC_SELECTED_LAYOUT = selectedLayoutPath;
            process.env.HDC_ARGS_LOG = argsLogPath;

            const result = await new SelectOptionTool().execute({
                trigger: { role: 'button', name: '语言' },
                option: '简体中文',
                bundleName: 'com.develop.opensource.ohpcd.opendesk',
                match: 'exact',
                verify: true,
                maxAttempts: 2
            });

            assert.equal(result.status, 'success');
            const parsed = JSON.parse(result.result);
            assert.equal(parsed.success, true);
            assert.equal(parsed.selected, true);
            assert.equal(parsed.verified, true);
            assert.equal(parsed.strategy, 'accessibility');
            assert.equal(parsed.option, '简体中文');
            assert.equal(parsed.attempts, 1);
            assert.deepEqual(
                fs
                    .readFileSync(argsLogPath, 'utf8')
                    .split('\n')
                    .filter((line) => line.includes('uiInput click')),
                ['shell uitest uiInput click 200 130', 'shell uitest uiInput click 200 230']
            );
        } finally {
            process.env.PATH = originalPath;
            if (originalStatePath === undefined) delete process.env.HDC_SELECT_STATE;
            else process.env.HDC_SELECT_STATE = originalStatePath;
            if (originalClosedLayoutPath === undefined) delete process.env.HDC_CLOSED_LAYOUT;
            else process.env.HDC_CLOSED_LAYOUT = originalClosedLayoutPath;
            if (originalOpenLayoutPath === undefined) delete process.env.HDC_OPEN_LAYOUT;
            else process.env.HDC_OPEN_LAYOUT = originalOpenLayoutPath;
            if (originalSelectedLayoutPath === undefined) delete process.env.HDC_SELECTED_LAYOUT;
            else process.env.HDC_SELECTED_LAYOUT = originalSelectedLayoutPath;
            if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
            else process.env.HDC_ARGS_LOG = originalArgsLog;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
);

test('stageFixture sends a local file to the requested device directory', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-stage-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const fixturePath = path.join(tempDir, 'fixture.zip');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(fixturePath, 'zip-fixture');
        fs.writeFileSync(fakeHdcPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HDC_ARGS_LOG"\nprintf "No Error\\n"\n', {
            mode: 0o755
        });
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new StageFixtureTool().execute({
            localPath: fixturePath,
            deviceDirectory: '/data/local/tmp/opendesk-fixtures'
        });

        assert.equal(result.status, 'success');
        assert.deepEqual(JSON.parse(result.result), {
            success: true,
            localPath: fixturePath,
            devicePath: '/data/local/tmp/opendesk-fixtures/fixture.zip',
            kind: 'file',
            bytes: 11
        });
        assert.deepEqual(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n'), [
            'shell mkdir -p /data/local/tmp/opendesk-fixtures',
            `file send ${fixturePath} /data/local/tmp/opendesk-fixtures/fixture.zip`
        ]);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('chooseFile selects a visible system picker entry and confirms it', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-picker-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const layoutPath = path.join(tempDir, 'layout.json');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            layoutPath,
            JSON.stringify({
                attributes: { type: 'root' },
                children: [
                    {
                        attributes: {
                            type: 'window',
                            bundleName: 'com.ohos.filepicker',
                            text: '文件选择器'
                        },
                        children: [
                            {
                                attributes: {
                                    type: 'ListItem',
                                    text: 'gui-gap-demo.zip',
                                    clickable: 'true',
                                    bounds: '[100,200][500,260]'
                                },
                                children: []
                            },
                            {
                                attributes: {
                                    type: 'Button',
                                    text: '打开',
                                    clickable: 'true',
                                    bounds: '[700,900][820,960]'
                                },
                                children: []
                            }
                        ]
                    }
                ]
            })
        );
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                '  printf "saved to:/data/local/tmp/layout.json\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  cp "$HDC_LAYOUT_PATH" "$4"',
                'else',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;
        process.env.HDC_LAYOUT_PATH = layoutPath;

        const result = await new ChooseFileTool().execute({
            path: '/data/local/tmp/opendesk-fixtures/gui-gap-demo.zip',
            mode: 'openFile',
            maxScrolls: 0,
            snapshot: false
        });

        assert.equal(result.status, 'success');
        assert.deepEqual(JSON.parse(result.result), {
            success: true,
            path: '/data/local/tmp/opendesk-fixtures/gui-gap-demo.zip',
            mode: 'openFile',
            selected: true,
            confirmed: true,
            pickerBundleName: 'com.ohos.filepicker'
        });
        const commands = fs.readFileSync(argsLogPath, 'utf8').trim().split('\n');
        assert.ok(commands.includes('shell uitest dumpLayout'));
        assert.ok(commands.includes('shell uitest uiInput click 300 230'));
        assert.ok(commands.includes('shell uitest uiInput click 760 930'));
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        delete process.env.HDC_LAYOUT_PATH;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test(
    'chooseFile refuses to click when the visible system picker has no matching target',
    { concurrency: false },
    async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-picker-miss-test-'));
        const fakeHdcPath = path.join(tempDir, 'hdc');
        const argsLogPath = path.join(tempDir, 'hdc-args.log');
        const layoutPath = path.join(tempDir, 'layout.json');
        const originalPath = process.env.PATH;
        const originalArgsLog = process.env.HDC_ARGS_LOG;

        try {
            fs.writeFileSync(
                layoutPath,
                JSON.stringify({
                    attributes: { type: 'root' },
                    children: [
                        {
                            attributes: { type: 'window', bundleName: 'com.ohos.filepicker', text: '文件选择器' },
                            children: [
                                {
                                    attributes: {
                                        type: 'ListItem',
                                        text: 'another.zip',
                                        clickable: 'true',
                                        bounds: '[100,200][500,260]'
                                    },
                                    children: []
                                }
                            ]
                        }
                    ]
                })
            );
            fs.writeFileSync(
                fakeHdcPath,
                [
                    '#!/bin/sh',
                    'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                    'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                    '  printf "saved to:/data/local/tmp/layout.json\\n"',
                    'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                    '  cp "$HDC_LAYOUT_PATH" "$4"',
                    'else',
                    '  printf "No Error\\n"',
                    'fi'
                ].join('\n'),
                { mode: 0o755 }
            );
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
            process.env.HDC_ARGS_LOG = argsLogPath;
            process.env.HDC_LAYOUT_PATH = layoutPath;

            const result = await new ChooseFileTool().execute({
                path: '/data/local/tmp/opendesk-fixtures/gui-gap-demo.zip',
                mode: 'openFile',
                maxScrolls: 0,
                snapshot: false
            });

            const parsed = JSON.parse(result.result);
            assert.equal(parsed.success, false);
            assert.match(parsed.error, /gui-gap-demo\.zip/);
            const commands = fs.readFileSync(argsLogPath, 'utf8');
            assert.doesNotMatch(commands, /uiInput click/);
        } finally {
            process.env.PATH = originalPath;
            if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
            else process.env.HDC_ARGS_LOG = originalArgsLog;
            delete process.env.HDC_LAYOUT_PATH;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
);

test(
    'chooseFile save mode enters the target directory before filling the file name',
    { concurrency: false },
    async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-picker-save-test-'));
        const fakeHdcPath = path.join(tempDir, 'hdc');
        const argsLogPath = path.join(tempDir, 'hdc-args.log');
        const layoutPath = path.join(tempDir, 'layout.json');
        const originalPath = process.env.PATH;
        const originalArgsLog = process.env.HDC_ARGS_LOG;

        try {
            fs.writeFileSync(
                layoutPath,
                JSON.stringify({
                    attributes: { type: 'root' },
                    children: [
                        {
                            attributes: { type: 'window', bundleName: 'com.ohos.filepicker', text: '文件选择器' },
                            children: [
                                {
                                    attributes: {
                                        type: 'ListItem',
                                        text: 'opendesk-fixtures',
                                        clickable: 'true',
                                        bounds: '[100,200][500,260]'
                                    },
                                    children: []
                                },
                                {
                                    attributes: {
                                        type: 'TextInput',
                                        hint: '文件名',
                                        clickable: 'true',
                                        bounds: '[100,800][600,860]'
                                    },
                                    children: []
                                },
                                {
                                    attributes: {
                                        type: 'Button',
                                        text: '保存',
                                        clickable: 'true',
                                        bounds: '[700,900][820,960]'
                                    },
                                    children: []
                                }
                            ]
                        }
                    ]
                })
            );
            fs.writeFileSync(
                fakeHdcPath,
                [
                    '#!/bin/sh',
                    'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                    'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                    '  printf "saved to:/data/local/tmp/layout.json\\n"',
                    'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                    '  cp "$HDC_LAYOUT_PATH" "$4"',
                    'else',
                    '  printf "No Error\\n"',
                    'fi'
                ].join('\n'),
                { mode: 0o755 }
            );
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
            process.env.HDC_ARGS_LOG = argsLogPath;
            process.env.HDC_LAYOUT_PATH = layoutPath;

            const result = await new ChooseFileTool().execute({
                path: '/data/local/tmp/opendesk-fixtures/setting.json',
                mode: 'saveFile',
                maxScrolls: 0,
                snapshot: false
            });

            assert.equal(JSON.parse(result.result).success, true);
            const commands = fs.readFileSync(argsLogPath, 'utf8').trim().split('\n');
            const directoryClick = commands.indexOf('shell uitest uiInput click 300 230');
            const fileNameClick = commands.indexOf('shell uitest uiInput click 350 830');
            const confirmClick = commands.indexOf('shell uitest uiInput click 760 930');
            assert.ok(directoryClick >= 0);
            assert.ok(fileNameClick > directoryClick);
            assert.ok(confirmClick > fileNameClick);
        } finally {
            process.env.PATH = originalPath;
            if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
            else process.env.HDC_ARGS_LOG = originalArgsLog;
            delete process.env.HDC_LAYOUT_PATH;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
);

test('dropFixture injects a File through the OpenDesk WebView drop path', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-drop-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const fixturePath = path.join(tempDir, 'gui-gap-icon.png');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        const fixtureBuffer = Buffer.alloc(15000, 0);
        fixtureBuffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
        fs.writeFileSync(fixturePath, fixtureBuffer);
        fs.writeFileSync(fakeHdcPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HDC_ARGS_LOG"\nprintf "No Error\\n"\n', {
            mode: 0o755
        });
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new DropFixtureTool().execute({
            localPath: fixturePath,
            bundleName: 'com.develop.opensource.ohpcd.opendesk',
            x: 600,
            y: 720,
            snapshot: false
        });

        assert.equal(result.status, 'success');
        const parsed = JSON.parse(result.result);
        assert.equal(parsed.success, true);
        assert.equal(parsed.localPath, fixturePath);
        assert.equal(parsed.bytes, 15000);
        assert.equal(parsed.method, 'webview-drop');
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        assert.match(commands, /shell arkweb_exec_js -b com\.develop\.opensource\.ohpcd\.opendesk -s/);
        assert.match(commands, /DataTransfer/);
        assert.match(commands, /gui-gap-icon\.png/);
        const commandLines = commands.trim().split('\n');
        assert.ok(commandLines.length >= 4, 'large fixtures should be injected in bounded chunks');
        assert.ok(
            commandLines.every((line) => line.length < 18000),
            'no HDC argument should contain the full file'
        );
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appLifecycle restart force-stops then starts the resolved entry ability', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-lifecycle-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ] && [ "$2" = "bm" ] && [ "$3" = "dump" ]; then',
                '  printf \'{"name":"EntryAbility"}\\n\'',
                'else',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new AppLifecycleTool().execute({
            bundleName: 'com.example.app',
            action: 'restart',
            settleTime: 0,
            snapshot: false
        });

        assert.equal(result.status, 'success');
        assert.deepEqual(JSON.parse(result.result), {
            success: true,
            bundleName: 'com.example.app',
            action: 'restart',
            stopped: true,
            started: true,
            abilityName: 'EntryAbility'
        });
        assert.deepEqual(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n'), [
            'shell aa force-stop com.example.app',
            'shell bm dump -n com.example.app',
            'shell aa start -a EntryAbility -b com.example.app'
        ]);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appLifecycle is serialized because lifecycle operations mutate shared device state', () => {
    assert.equal(new AppLifecycleTool().serialExecution, true);
});

test('appLifecycle clearData requires explicit destructive confirmation', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-clear-data-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(fakeHdcPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HDC_ARGS_LOG"\n', { mode: 0o755 });
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const rejected = await new AppLifecycleTool().execute({
            bundleName: 'com.example.app',
            action: 'clearData',
            confirmDestructive: false,
            relaunch: false,
            settleTime: 0,
            snapshot: false
        });

        assert.equal(rejected.status, 'success');
        assert.equal(JSON.parse(rejected.result).success, false);
        assert.equal(fs.existsSync(argsLogPath), false, 'no HDC command should run without confirmation');

        const cleared = await new AppLifecycleTool().execute({
            bundleName: 'com.example.app',
            action: 'clearData',
            confirmDestructive: true,
            relaunch: false,
            settleTime: 0,
            snapshot: false
        });

        assert.equal(cleared.status, 'success');
        assert.deepEqual(JSON.parse(cleared.result), {
            success: true,
            bundleName: 'com.example.app',
            action: 'clearData',
            stopped: true,
            dataCleared: true,
            started: false
        });
        assert.deepEqual(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n'), [
            'shell aa force-stop com.example.app',
            'shell bm clean -n com.example.app -d'
        ]);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('appLifecycle clearCache stops, clears cache, and optionally relaunches', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-clear-cache-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ] && [ "$2" = "bm" ] && [ "$3" = "dump" ]; then',
                '  printf \'{"name":"MainAbility"}\\n\'',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new AppLifecycleTool().execute({
            bundleName: 'com.example.app',
            action: 'clearCache',
            relaunch: true,
            settleTime: 0,
            snapshot: false
        });

        assert.equal(result.status, 'success');
        assert.deepEqual(JSON.parse(result.result), {
            success: true,
            bundleName: 'com.example.app',
            action: 'clearCache',
            stopped: true,
            cacheCleared: true,
            started: true,
            abilityName: 'MainAbility'
        });
        assert.deepEqual(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n'), [
            'shell aa force-stop com.example.app',
            'shell bm clean -n com.example.app -c',
            'shell bm dump -n com.example.app',
            'shell aa start -a MainAbility -b com.example.app'
        ]);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

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
        assert.ok(fs.readFileSync(uiTestArgsLogPath, 'utf8').includes('keyEvent'));
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

test(
    'input replace clears from the end with a bounded number of Backspace events',
    { concurrency: false },
    async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-replace-test-'));
        const fakeHdcPath = path.join(tempDir, 'hdc');
        const fakeUiTestPath = path.join(tempDir, 'uitest');
        const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
        const originalPath = process.env.PATH;
        const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

        try {
            fs.writeFileSync(
                fakeHdcPath,
                ['#!/bin/sh', 'if [ "$1" = "shell" ]; then', '  shift', '  /bin/sh -c "$*"', 'fi'].join('\n'),
                { mode: 0o755 }
            );
            fs.writeFileSync(fakeUiTestPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$UITEST_ARGS_LOG"\n', {
                mode: 0o755
            });
            process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
            process.env.UITEST_ARGS_LOG = uiTestArgsLogPath;

            const result = await new InputTool().execute({
                x: 10,
                y: 20,
                text: '',
                mode: 'replace',
                maxClearChars: 3,
                snapshot: false
            });

            assert.equal(result.status, 'success');
            assert.deepEqual(fs.readFileSync(uiTestArgsLogPath, 'utf8').trim().split('\n'), [
                'uiInput',
                'click',
                '10',
                '20',
                'uiInput',
                'keyEvent',
                '2055',
                'uiInput',
                'keyEvent',
                '2055',
                'uiInput',
                'keyEvent',
                '2055'
            ]);
            assert.deepEqual(JSON.parse(result.result), {
                success: true,
                x: 10,
                y: 20,
                text: '',
                mode: 'replace',
                maxClearChars: 3
            });
        } finally {
            process.env.PATH = originalPath;
            if (originalUiTestArgsLog === undefined) {
                delete process.env.UITEST_ARGS_LOG;
            } else {
                process.env.UITEST_ARGS_LOG = originalUiTestArgsLog;
            }
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
);

test('pointer gesture tools delegate to native uiInput commands', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-gesture-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeUiTestPath = path.join(tempDir, 'uitest');
    const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
    const originalPath = process.env.PATH;
    const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            ['#!/bin/sh', 'if [ "$1" = "shell" ]; then', '  shift', '  /bin/sh -c "$*"', 'fi'].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(fakeUiTestPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$UITEST_ARGS_LOG"\n', {
            mode: 0o755
        });
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.UITEST_ARGS_LOG = uiTestArgsLogPath;

        const doubleClick = await new DoubleClickTool().execute({ x: 10, y: 20, snapshot: false });
        const drag = await new DragTool().execute({
            fromX: 1,
            fromY: 2,
            toX: 3,
            toY: 4,
            speed: 800,
            snapshot: false
        });
        const longClick = await new LongClickTool().execute({ x: 30, y: 40, snapshot: false });

        assert.deepEqual(JSON.parse(doubleClick.result), {
            success: true,
            gesture: 'doubleClick',
            native: true,
            x: 10,
            y: 20
        });
        assert.deepEqual(JSON.parse(drag.result), {
            success: true,
            gesture: 'drag',
            native: true,
            fromX: 1,
            fromY: 2,
            toX: 3,
            toY: 4,
            speed: 800
        });
        assert.deepEqual(JSON.parse(longClick.result), {
            success: true,
            gesture: 'longClick',
            native: true,
            x: 30,
            y: 40
        });
        assert.deepEqual(fs.readFileSync(uiTestArgsLogPath, 'utf8').trim().split('\n'), [
            'uiInput',
            'doubleClick',
            '10',
            '20',
            'uiInput',
            'drag',
            '1',
            '2',
            '3',
            '4',
            '800',
            'uiInput',
            'longClick',
            '30',
            '40'
        ]);
    } finally {
        process.env.PATH = originalPath;
        if (originalUiTestArgsLog === undefined) {
            delete process.env.UITEST_ARGS_LOG;
        } else {
            process.env.UITEST_ARGS_LOG = originalUiTestArgsLog;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('screenshot runs the default OCR path through the Tesseract executable', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-screenshot-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeTesseractPath = path.join(tempDir, 'tesseract');
    const screenshotPath = path.join(tempDir, 'screenshot.png');
    const originalPath = process.env.PATH;
    const originalScreenshotPath = process.env.HDC_SCREENSHOT_PATH;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "shell" ] && [ "$2" = "snapshot_display" ]; then',
                '  printf "write to /data/local/tmp/opendesk_screenshot.png\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  cp "$HDC_SCREENSHOT_PATH" "$4"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(
            fakeTesseractPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "--list-langs" ]; then',
                '  printf "List of available languages (2):\\neng\\nchi_sim\\n"',
                'else',
                '  printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t40\\t60\\t30\\t95\\tHello\\n" > "$2.tsv"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(
            screenshotPath,
            Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                'base64'
            )
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_SCREENSHOT_PATH = screenshotPath;

        const result = await new ScreenshotTool().execute({});

        assert.equal(result.status, 'success');
        const parsed = JSON.parse(result.result);
        assert.equal(parsed.success, true);
        assert.deepEqual(parsed.ocr, [{ text: 'Hello', x: 10, y: 20, width: 30, height: 15, confidence: 95 }]);
    } finally {
        process.env.PATH = originalPath;
        if (originalScreenshotPath === undefined) {
            delete process.env.HDC_SCREENSHOT_PATH;
        } else {
            process.env.HDC_SCREENSHOT_PATH = originalScreenshotPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('regional screenshot maps OCR boxes back to absolute device coordinates', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-region-ocr-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeTesseractPath = path.join(tempDir, 'tesseract');
    const screenshotPath = path.join(tempDir, 'screenshot.png');
    const preparedImagePath = path.join(tempDir, 'prepared.png');
    const originalPath = process.env.PATH;
    const originalScreenshotPath = process.env.HDC_SCREENSHOT_PATH;
    const originalPreparedImagePath = process.env.TESSERACT_INPUT_COPY;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "shell" ] && [ "$2" = "snapshot_display" ]; then',
                '  printf "write to /data/local/tmp/opendesk_screenshot.png\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  cp "$HDC_SCREENSHOT_PATH" "$4"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        fs.writeFileSync(
            fakeTesseractPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "--list-langs" ]; then',
                '  printf "List of available languages (1):\\neng\\n"',
                'else',
                '  cp "$1" "$TESSERACT_INPUT_COPY"',
                '  printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t10\\t40\\t20\\t95\\tOption\\n" > "$2.tsv"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        const img = new Jimp({ width: 100, height: 80, color: 0xffffffff });
        const pngBuf = await img.getBuffer('image/png');
        fs.writeFileSync(screenshotPath, pngBuf);
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_SCREENSHOT_PATH = screenshotPath;
        process.env.TESSERACT_INPUT_COPY = preparedImagePath;

        const result = await new ScreenshotTool().execute({
            region: { x1: 10, y1: 20, x2: 50, y2: 50 }
        });

        assert.equal(result.status, 'success');
        const parsed = JSON.parse(result.result);
        assert.equal(parsed.success, true);
        assert.deepEqual(parsed.ocr, [{ text: 'Option', x: 20, y: 25, width: 20, height: 10, confidence: 95 }]);
        const preparedImg = await Jimp.read(preparedImagePath);
        assert.deepEqual(
            { width: preparedImg.bitmap.width, height: preparedImg.bitmap.height },
            { width: 80, height: 60 }
        );
    } finally {
        process.env.PATH = originalPath;
        if (originalScreenshotPath === undefined) delete process.env.HDC_SCREENSHOT_PATH;
        else process.env.HDC_SCREENSHOT_PATH = originalScreenshotPath;
        if (originalPreparedImagePath === undefined) delete process.env.TESSERACT_INPUT_COPY;
        else process.env.TESSERACT_INPUT_COPY = originalPreparedImagePath;
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

test('snapshot exposes a ref and coordinates for a non-clickable textbox', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-textbox-ref-test-'));
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
                attributes: {},
                children: [
                    {
                        attributes: {
                            type: 'window',
                            bundleName: 'com.develop.opensource.ohpcd.opendesk',
                            visible: 'true'
                        },
                        children: [
                            {
                                attributes: {
                                    type: 'textField',
                                    hint: '在这里输入消息，按 Enter 发送',
                                    bounds: '[100,200][300,260]',
                                    enabled: 'true',
                                    visible: 'true'
                                },
                                children: []
                            }
                        ]
                    }
                ]
            })
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_LAYOUT_PATH = layoutPath;

        const snapshotResult = await new SnapshotTool().execute({
            bundleName: 'com.develop.opensource.ohpcd.opendesk'
        });
        const snapshot = JSON.parse(snapshotResult.result);

        assert.equal(snapshotResult.status, 'success');
        assert.match(snapshot.snapshot, /textbox .*\[ref=e0 x=200 y=230\]/);
    } finally {
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) delete process.env.HDC_LAYOUT_PATH;
        else process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('snapshot keeps refs for clickable controls', { concurrency: false }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-clickable-ref-test-'));
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
                attributes: {},
                children: [
                    {
                        attributes: {
                            type: 'window',
                            bundleName: 'com.develop.opensource.ohpcd.opendesk',
                            visible: 'true'
                        },
                        children: [
                            {
                                attributes: {
                                    type: 'button',
                                    text: '发送',
                                    bounds: '[100,200][300,260]',
                                    clickable: 'true',
                                    enabled: 'true',
                                    visible: 'true'
                                },
                                children: []
                            }
                        ]
                    }
                ]
            })
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_LAYOUT_PATH = layoutPath;

        const snapshotResult = await new SnapshotTool().execute({
            bundleName: 'com.develop.opensource.ohpcd.opendesk'
        });
        const snapshot = JSON.parse(snapshotResult.result);

        assert.equal(snapshotResult.status, 'success');
        assert.match(snapshot.snapshot, /button "发送" \[ref=e0 x=200 y=230\]/);
    } finally {
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) delete process.env.HDC_LAYOUT_PATH;
        else process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
