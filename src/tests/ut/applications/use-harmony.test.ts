/**
 * 真实 process.env 透传：测试通过改 PATH 劫持 hdc 命令，Jest vm 默认深拷贝
 * process，写入对 child_process 不可见，需用 real-env 环境透传真实 env。
 * @jest-environment <rootDir>/src/tests/real-env-environment.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { loadUseHarmonySkill } from '../../../main/applications/builtin/skills/use-harmony/skill.js';
import {
    AppLifecycleTool,
    ClickTool,
    ChooseFileTool,
    createUseHarmonyToolset,
    DoubleClickTool,
    DropFixtureTool,
    DragTool,
    GetDeviceInfoTool,
    GoBackTool,
    GoForwardTool,
    InstallAppTool,
    InputTool,
    listDevices,
    ListWindowsTool,
    OpenAppTool,
    PressKeyTool,
    PullFileTool,
    PushFileTool,
    resolveDeviceId,
    SelectOptionTool,
    LongClickTool,
    ScreenshotTool,
    ScrollTool,
    ScrollInScrollableTool,
    ShellTool,
    SnapshotTool,
    SystemDialogTool,
    UninstallAppTool,
    WaitForTool
} from '../../../main/applications/builtin/skills/use-harmony/tools.js';

it('use-harmony skill loader preserves metadata, instructions, and toolset wiring', () => {
    const skill = loadUseHarmonySkill();

    expect(skill.frontmatter.name).toBe('use-harmony');
    expect(skill.frontmatter.description).toBe(
        '通过 hdc 操控鸿蒙设备：应用管理、界面快照、点击/滑动/输入等自动化控制能力'
    );
    expect(skill.body).toMatch(/# 鸿蒙设备控制/);
    expect(skill.body).toMatch(/## 核心原则：无障碍优先，截图兜底/);
    expect(skill.body).toMatch(/## 应用管理/);
    expect(skill.body).toMatch(/### 虚拟滚动选择器/);
    expect(skill.body).not.toMatch(/手工操作步骤|09:09|14 次滚动|dumpLayout 手工流程/);
    expect(skill.toolsets?.length).toBe(1);
    expect(skill.getTool('snapshot')?.name).toBe('snapshot');
    expect(skill.getTool('openApp')?.name).toBe('openApp');
});

it('use-harmony toolset exposes native picker, and WebView drop tools', () => {
    const toolset = createUseHarmonyToolset();
    expect(toolset.hasTool('chooseFile')).toBe(true);
    expect(toolset.hasTool('dropFixture')).toBe(true);
    expect(toolset.hasTool('selectOption')).toBe(true);
});

it('listDevices parses the 4-column hdc output where the transport column precedes Connected', async () => {
    // Regression: real `hdc list targets -v` prints 4 whitespace-separated
    // columns (id / transport / state / address), e.g.
    //   "ea010e...		USB	Connected	localhost"
    // The old 3-column parser treated "USB" as the status, so USB devices
    // failed the `status === 'Connected'` filter in resolveDeviceId and every
    // device-scoped tool reported "No connected device found".
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-list-devices-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const originalPath = process.env.PATH;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "ea010e5350654d4d43101a285dd21b00\\t\\tUSB\\tConnected\\tlocalhost\\n"',
                '  printf "127.0.0.1:5555\\t\\tTCP\\tConnected\\tlocalhost\\n"',
                '  printf "emulator-5554\\t\\tUSB\\tDisconnected\\tlocalhost\\n"',
                '  printf "[Empty]\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;

        const devices = await listDevices();
        expect(devices).toEqual([
            { id: 'ea010e5350654d4d43101a285dd21b00', status: 'Connected', type: 'USB localhost' },
            { id: '127.0.0.1:5555', status: 'Connected', type: 'TCP localhost' },
            { id: 'emulator-5554', status: 'Disconnected', type: 'USB localhost' }
        ]);

        // An explicit id resolves for any listed device, USB included.
        expect(await resolveDeviceId('ea010e5350654d4d43101a285dd21b00')).toBe('ea010e5350654d4d43101a285dd21b00');

        // Both rows are now recognized as Connected (the old parser saw only
        // "USB" and reported "No connected device found" instead).
        await expect(resolveDeviceId()).rejects.toThrow('Multiple connected devices found');
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('listDevices keeps parsing the legacy 3-column hdc output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-list-devices-legacy-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const originalPath = process.env.PATH;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;

        const devices = await listDevices();
        expect(devices).toEqual([{ id: 'FMR0223C13000649', status: 'Connected', type: 'HarmonyOS Device' }]);

        const resolved = await resolveDeviceId();
        expect(resolved).toBe('FMR0223C13000649');
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('selectOption opens an accessible dropdown, chooses an option, and verifies the result', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.selected).toBe(true);
        expect(parsed.verified).toBe(true);
        expect(parsed.strategy).toBe('accessibility');
        expect(parsed.option).toBe('简体中文');
        expect(parsed.attempts).toBe(1);
        expect(
            fs
                .readFileSync(argsLogPath, 'utf8')
                .split('\n')
                .filter((line) => line.includes('uiInput click'))
        ).toEqual(['shell uitest uiInput click 200 130', 'shell uitest uiInput click 200 230']);
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
});

it('chooseFile selects a visible system picker entry and confirms it', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            path: '/data/local/tmp/opendesk-fixtures/gui-gap-demo.zip',
            mode: 'openFile',
            selected: true,
            confirmed: true,
            pickerBundleName: 'com.ohos.filepicker'
        });
        const commands = fs.readFileSync(argsLogPath, 'utf8').trim().split('\n');
        expect(commands.includes('shell uitest dumpLayout')).toBe(true);
        expect(commands.includes('shell uitest uiInput click 300 230')).toBe(true);
        expect(commands.includes('shell uitest uiInput click 760 930')).toBe(true);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        delete process.env.HDC_LAYOUT_PATH;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('chooseFile refuses to click when the visible system picker has no matching target', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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
        expect(parsed.success).toBe(false);
        expect(parsed.error).toMatch(/gui-gap-demo\.zip/);
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        expect(commands).not.toMatch(/uiInput click/);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        delete process.env.HDC_LAYOUT_PATH;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('chooseFile save mode enters the target directory before filling the file name', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(JSON.parse(result.result).success).toBe(true);
        const commands = fs.readFileSync(argsLogPath, 'utf8').trim().split('\n');
        const directoryClick = commands.indexOf('shell uitest uiInput click 300 230');
        const fileNameClick = commands.indexOf('shell uitest uiInput click 350 830');
        const confirmClick = commands.indexOf('shell uitest uiInput click 760 930');
        expect(directoryClick >= 0).toBe(true);
        expect(fileNameClick > directoryClick).toBe(true);
        expect(confirmClick > fileNameClick).toBe(true);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        delete process.env.HDC_LAYOUT_PATH;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('dropFixture injects a File through the OpenDesk WebView drop path', async () => {
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
        fs.writeFileSync(
            fakeHdcPath,
            '#!/bin/sh\n' +
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then\n  shift 2\nfi\n' +
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then\n  echo "FMR0223C13000649 Connected HarmonyOS Device"\n  exit 0\nfi\n' +
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"\nprintf "No Error\\n"\n',
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new DropFixtureTool().execute({
            localPath: fixturePath,
            bundleName: 'com.develop.opensource.ohpcd.opendesk',
            x: 600,
            y: 720,
            snapshot: false
        });

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.localPath).toBe(fixturePath);
        expect(parsed.bytes).toBe(15000);
        expect(parsed.method).toBe('webview-drop');
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        expect(commands).toMatch(/shell arkweb_exec_js -b com\.develop\.opensource\.ohpcd\.opendesk -s/);
        expect(commands).toMatch(/DataTransfer/);
        expect(commands).toMatch(/gui-gap-icon\.png/);
        const commandLines = commands.trim().split('\n');
        if (!(commandLines.length >= 4)) throw new Error('large fixtures should be injected in bounded chunks');
        if (!commandLines.every((line) => line.length < 18000))
            throw new Error('no HDC argument should contain the full file');
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('appLifecycle restart force-stops then starts the resolved entry ability', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            bundleName: 'com.example.app',
            action: 'restart',
            stopped: true,
            started: true,
            abilityName: 'EntryAbility'
        });
        expect(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n')).toEqual([
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

it('appLifecycle is serialized because lifecycle operations mutate shared device state', () => {
    expect(new AppLifecycleTool().serialExecution).toBe(true);
});

it('appLifecycle clearData requires explicit destructive confirmation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-clear-data-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            '#!/bin/sh\n' +
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then\n  shift 2\nfi\n' +
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then\n  echo "FMR0223C13000649 Connected HarmonyOS Device"\n  exit 0\nfi\n' +
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"\n',
            { mode: 0o755 }
        );
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

        expect(rejected.status).toBe('success');
        expect(JSON.parse(rejected.result).success).toBe(false);
        expect(fs.existsSync(argsLogPath)).toBe(false);

        const cleared = await new AppLifecycleTool().execute({
            bundleName: 'com.example.app',
            action: 'clearData',
            confirmDestructive: true,
            relaunch: false,
            settleTime: 0,
            snapshot: false
        });

        expect(cleared.status).toBe('success');
        expect(JSON.parse(cleared.result)).toEqual({
            success: true,
            bundleName: 'com.example.app',
            action: 'clearData',
            stopped: true,
            dataCleared: true,
            started: false
        });
        expect(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n')).toEqual([
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

it('appLifecycle clearCache stops, clears cache, and optionally relaunches', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            bundleName: 'com.example.app',
            action: 'clearCache',
            stopped: true,
            cacheCleared: true,
            started: true,
            abilityName: 'MainAbility'
        });
        expect(fs.readFileSync(argsLogPath, 'utf8').trim().split('\n')).toEqual([
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

it('input passes text to hdc without executing it in a host or device shell', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result).success).toBe(true);
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(fs.readFileSync(uiTestArgsLogPath, 'utf8').includes('keyEvent')).toBe(true);
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
}, 60000); // typeAsciiText 逐字符发 keyEvent，Windows 上每个字符都要起一次 bash 进程，90 字符累计约 8s

it('input replace without bounds falls back to a bounded number of Backspace events', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-replace-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeUiTestPath = path.join(tempDir, 'uitest');
    const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
    const originalPath = process.env.PATH;
    const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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
        process.env.UITEST_ARGS_LOG = uiTestArgsLogPath;

        const result = await new InputTool().execute({
            x: 10,
            y: 20,
            text: '',
            mode: 'replace',
            maxClearChars: 3,
            snapshot: false
        });

        expect(result.status).toBe('success');
        expect(fs.readFileSync(uiTestArgsLogPath, 'utf8').trim().split('\n')).toEqual([
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
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            x: 10,
            y: 20,
            text: '',
            mode: 'replace',
            clearMode: 'backspace'
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
}, 30000); // 每个 uiInput 调用都要起一次 bash 进程，留足余量

it('input replace dragSelect clears via a field-spanning drag when bounds are provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-dragselect-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeUiTestPath = path.join(tempDir, 'uitest');
    const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
    const originalPath = process.env.PATH;
    const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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
        process.env.UITEST_ARGS_LOG = uiTestArgsLogPath;

        const result = await new InputTool().execute({
            x: 100,
            y: 40,
            text: '',
            mode: 'replace',
            bounds: { x1: 10, y1: 20, x2: 210, y2: 60 },
            maxClearChars: 256,
            snapshot: false
        });

        expect(result.status).toBe('success');
        expect(fs.readFileSync(uiTestArgsLogPath, 'utf8').trim().split('\n')).toEqual([
            'uiInput',
            'click',
            '100',
            '40',
            'uiInput',
            'drag',
            '30',
            '24',
            '190',
            '56',
            '600'
        ]);
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            x: 100,
            y: 40,
            text: '',
            mode: 'replace',
            clearMode: 'dragSelect'
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
}, 30000); // 每个 uiInput 调用都要起一次 bash 进程，留足余量

it('pointer gesture tools delegate to native uiInput commands', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-gesture-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeUiTestPath = path.join(tempDir, 'uitest');
    const uiTestArgsLogPath = path.join(tempDir, 'uitest-args.log');
    const originalPath = process.env.PATH;
    const originalUiTestArgsLog = process.env.UITEST_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(JSON.parse(doubleClick.result)).toEqual({
            success: true,
            gesture: 'doubleClick',
            native: true,
            x: 10,
            y: 20
        });
        expect(JSON.parse(drag.result)).toEqual({
            success: true,
            gesture: 'drag',
            native: true,
            fromX: 1,
            fromY: 2,
            toX: 3,
            toY: 4,
            speed: 800
        });
        expect(JSON.parse(longClick.result)).toEqual({
            success: true,
            gesture: 'longClick',
            native: true,
            x: 30,
            y: 40
        });
        expect(fs.readFileSync(uiTestArgsLogPath, 'utf8').trim().split('\n')).toEqual([
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

it('screenshot runs the default OCR path through the Tesseract executable', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.ocr).toEqual([{ text: 'Hello', x: 10, y: 20, width: 30, height: 15, confidence: 95 }]);
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

it('regional screenshot maps OCR boxes back to absolute device coordinates', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.ocr).toEqual([{ text: 'Option', x: 20, y: 25, width: 20, height: 10, confidence: 95 }]);
        const preparedImg = await Jimp.read(preparedImagePath);
        expect({ width: preparedImg.bitmap.width, height: preparedImg.bitmap.height }).toEqual({
            width: 80,
            height: 60
        });
    } finally {
        process.env.PATH = originalPath;
        if (originalScreenshotPath === undefined) delete process.env.HDC_SCREENSHOT_PATH;
        else process.env.HDC_SCREENSHOT_PATH = originalScreenshotPath;
        if (originalPreparedImagePath === undefined) delete process.env.TESSERACT_INPUT_COPY;
        else process.env.TESSERACT_INPUT_COPY = originalPreparedImagePath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('concurrent snapshots use distinct local files', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(results.map((result) => JSON.parse(result.result).success)).toEqual([true, true]);
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

it('openApp rejects a bundle name containing shell syntax before invoking hdc', async () => {
    const result = await new OpenAppTool().execute({
        bundleName: 'com.example.app; touch /tmp/unexpected-hdc-command'
    });

    expect(result.status).toBe('error');
});

it('pressKey rejects combinations that exceed the hdc keyEvent limit', async () => {
    const result = await new PressKeyTool().execute({
        key: 'a',
        modifiers: ['Ctrl', 'Alt', 'Shift'],
        snapshot: false
    });

    expect(result.status).toBe('error');
});

it('snapshot exposes a ref and coordinates for a non-clickable textbox', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(snapshotResult.status).toBe('success');
        expect(snapshot.snapshot).toMatch(/textbox .*\[ref=e0 x=200 y=230\]/);
    } finally {
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) delete process.env.HDC_LAYOUT_PATH;
        else process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('snapshot keeps refs for clickable controls', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(snapshotResult.status).toBe('success');
        expect(snapshot.snapshot).toMatch(/button "发送" \[ref=e0 x=200 y=230\]/);
    } finally {
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) delete process.env.HDC_LAYOUT_PATH;
        else process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('window discovery does not duplicate nested nodes that repeat the same bundle name', async () => {
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
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

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.snapshot.match(/button "Tap"/g)?.length).toBe(1);

        const windowsResult = await new ListWindowsTool().execute({});
        expect(windowsResult.status).toBe('success');
        const parsedWindows = JSON.parse(windowsResult.result);
        expect(parsedWindows.success).toBe(true);
        expect(parsedWindows.windows.length).toBe(1);
    } finally {
        process.env.PATH = originalPath;
        if (originalLayoutPath === undefined) {
            delete process.env.HDC_LAYOUT_PATH;
        } else {
            process.env.HDC_LAYOUT_PATH = originalLayoutPath;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('systemDialog select matches the option text via OCR instead of always picking the highlighted row', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-system-dialog-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const fakeTesseractPath = path.join(tempDir, 'tesseract');
    const screenshotPath = path.join(tempDir, 'screenshot.png');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalScreenshotPath = process.env.HDC_SCREENSHOT_PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ] && [ "$2" = "snapshot_display" ]; then',
                '  printf "write to /data/local/tmp/opendesk_screenshot.png\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  cp "$HDC_SCREENSHOT_PATH" "$4"',
                'elif [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "uiInput" ]; then',
                '  printf "No Error\\n"',
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
                '  printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t80\\t60\\t20\\t95\\t浅色\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t160\\t60\\t20\\t95\\t深色\\n5\\t1\\t1\\t1\\t1\\t1\\t20\\t240\\t60\\t20\\t95\\t跟随系统\\n" > "$2.tsv"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );

        // 400x300 dialog: three option rows (dark text bars) with the middle one
        // highlighted in blue (the HarmonyOS picker selected state).
        const img = new Jimp({ width: 400, height: 300, color: 0xffffffff });
        const drawBar = (x: number, y: number, w: number, h: number, color: number) => {
            for (let py = y; py < y + h; py++) {
                for (let px = x; px < x + w; px++) {
                    img.setPixelColor(color, px, py);
                }
            }
        };
        drawBar(0, 55, 400, 20, 0x232323ff); // 浅色 row at y≈65
        drawBar(0, 115, 400, 20, 0x0011aaff); // 深色 row highlighted blue (dark enough to also count as a text row) at y≈125
        drawBar(0, 175, 400, 20, 0x232323ff); // 跟随系统 row at y≈185
        const pngBuf = await img.getBuffer('image/png');
        fs.writeFileSync(screenshotPath, pngBuf);
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_SCREENSHOT_PATH = screenshotPath;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new SystemDialogTool().execute({
            action: 'select',
            option: '跟随系统',
            settleTime: 100,
            snapshot: false
        });

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.optionIndex).toBe(2);
        // Click lands on the third row (y≈185), not the highlighted middle row.
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        expect(commands).toMatch(/uiInput click 200 18[0-9]/);
        expect(commands).not.toMatch(/uiInput click 200 12[0-9]/);
    } finally {
        process.env.PATH = originalPath;
        if (originalScreenshotPath === undefined) delete process.env.HDC_SCREENSHOT_PATH;
        else process.env.HDC_SCREENSHOT_PATH = originalScreenshotPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('scrollInScrollable skips degenerate 1px containers and picks the real column', async () => {
    // Regression: real WebView dumps (WorkBuddy time pickers) lead with a
    // scrollable outer wrapper that is 1px wide ([0,127][1,1955]). The old code
    // picked the FIRST scrollable container, so it scrolled in thin air and never
    // made the target visible. The fixed code filters zero-width/height
    // containers and selects the narrow column that actually contains the target.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-scroll-scrollable-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const layoutPath = path.join(tempDir, 'layout.json');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;
    const originalLayout = process.env.HDC_SCROLL_LAYOUT;

    try {
        // Layout shape observed on WorkBuddy v5.3.8: a degenerate 1px outer
        // scrollable wrapper first, then the real hour column viewport and the
        // target item ("09" fully inside the column viewport).
        const layout = {
            attributes: {},
            children: [
                {
                    attributes: { type: 'genericContainer', scrollable: 'true', bounds: '[0,127][1,1955]' },
                    children: []
                },
                {
                    attributes: { type: 'genericContainer', scrollable: 'true', bounds: '[729,912][904,1309]' },
                    children: []
                },
                {
                    attributes: { type: 'button', text: '09', bounds: '[729,1054][904,1112]' },
                    children: []
                }
            ]
        };
        fs.writeFileSync(layoutPath, JSON.stringify(layout));
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "shell" ] && [ "$2" = "uitest" ] && [ "$3" = "dumpLayout" ]; then',
                '  printf "saved to:/data/local/tmp/layout.json\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  cp "$HDC_SCROLL_LAYOUT" "$4"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;
        process.env.HDC_SCROLL_LAYOUT = layoutPath;

        const result = await new ScrollInScrollableTool().execute({
            targetRole: 'button',
            targetText: '09',
            bundleName: 'com.tencent.workbuddy',
            containerRole: 'genericContainer',
            maxScrolls: 8,
            settleMs: 100,
            snapshot: false
        });

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        // The fixed container filter picks the hour column, not the 1px wrapper.
        expect(parsed.containerBounds).toEqual({ x1: 729, y1: 912, x2: 904, y2: 1309 });
        expect(parsed.visible).toBe(true);
        expect(parsed.scrollsUsed).toBe(0);
        expect(parsed.targetCenter).toEqual({ x: 817, y: 1083 });
        // No scrolling gesture was issued because the target is already visible.
        expect(fs.readFileSync(argsLogPath, 'utf8')).not.toMatch(/uiInput drag/);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        if (originalLayout === undefined) delete process.env.HDC_SCROLL_LAYOUT;
        else process.env.HDC_SCROLL_LAYOUT = originalLayout;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('shell runs an arbitrary command and returns the device output', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-shell-test-'));
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
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "shell" ]; then',
                '  shift',
                '  /bin/sh -c "$*"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new ShellTool().execute({ command: 'echo hello-from-device' });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            output: 'hello-from-device'
        });
        if (!fs.readFileSync(argsLogPath, 'utf8').includes('-t FMR0223C13000649 shell echo hello-from-device'))
            throw new Error('command should target the resolved device via -t');
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('shell reports non-zero exit code and stderr instead of throwing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-shell-fail-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "shell" ]; then',
                '  shift',
                '  /bin/sh -c "$*"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new ShellTool().execute({ command: 'ls /no/such/path' });

        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.result);
        expect(parsed.success).toBe(true);
        expect(parsed.exitCode).not.toBe(0);
        if (!(parsed.stderr.length > 0)) throw new Error('command stderr should be surfaced');
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('getDeviceInfo reports model, resolution, system version, and wlan ip', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-deviceinfo-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const originalPath = process.env.PATH;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "shell" ] && [ "$2" = "param" ] && [ "$3" = "get" ]; then',
                '  case "$4" in',
                '    const.product.model) printf "HUAWEI MateBook X Pro\\n" ;;',
                '    const.product.brand) printf "HUAWEI\\n" ;;',
                '    const.product.name) printf "MateBook\\n" ;;',
                '    const.product.software.version) printf "5.0.0.60\\n" ;;',
                '    const.ohos.apiversion) printf "12\\n" ;;',
                '  esac',
                'elif [ "$1" = "shell" ] && [ "$2" = "hidumper" ] && [ "$3" = "-s" ] && [ "$4" = "RenderService" ]; then',
                '  printf "activeMode: 2560x1600, refreshrate=60\\n"',
                'elif [ "$1" = "shell" ] && [ "$2" = "ifconfig" ]; then',
                '  printf "wlan0 inet addr:192.168.1.100  Bcast:192.168.1.255\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;

        const result = await new GetDeviceInfoTool().execute({});

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            model: 'HUAWEI MateBook X Pro',
            brand: 'HUAWEI',
            productName: 'MateBook',
            sysVersion: '5.0.0.60',
            sdkVersion: '12',
            displaySize: { width: 2560, height: 1600 },
            wlanIp: '192.168.1.100'
        });
    } finally {
        process.env.PATH = originalPath;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('pushFile sends a local file to the device via hdc file send', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-push-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const localFilePath = path.join(tempDir, 'fixture.bin');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(localFilePath, 'fixture-data');
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "send" ]; then',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new PushFileTool().execute({
            localPath: localFilePath,
            remotePath: '/data/local/tmp/fixture.bin'
        });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            localPath: localFilePath,
            remotePath: '/data/local/tmp/fixture.bin',
            sent: true
        });
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        if (!commands.includes(`file send ${localFilePath} /data/local/tmp/fixture.bin`))
            throw new Error('hdc file send should be invoked with local and remote paths');
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('pullFile fetches a device file via hdc file recv', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-pull-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const localFilePath = path.join(tempDir, 'pulled.bin');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "file" ] && [ "$2" = "recv" ]; then',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const result = await new PullFileTool().execute({
            remotePath: '/data/local/tmp/device.log',
            localPath: localFilePath
        });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            success: true,
            remotePath: '/data/local/tmp/device.log',
            localPath: localFilePath,
            pulled: true
        });
        const commands = fs.readFileSync(argsLogPath, 'utf8');
        if (!commands.includes(`file recv /data/local/tmp/device.log ${localFilePath}`))
            throw new Error('hdc file recv should be invoked with remote and local paths');
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('installApp validates the .hap extension before invoking hdc install', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-install-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const hapPath = path.join(tempDir, 'demo.hap');
    const txtPath = path.join(tempDir, 'not-a-hap.txt');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(hapPath, 'fake-hap-content');
        fs.writeFileSync(txtPath, 'fake-text');
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "install" ]; then',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const rejected = await new InstallAppTool().execute({ hapPath: txtPath });
        expect(JSON.parse(rejected.result).success).toBe(false);
        expect(fs.existsSync(argsLogPath)).toBe(false);

        const installed = await new InstallAppTool().execute({ hapPath });
        expect(installed.status).toBe('success');
        expect(JSON.parse(installed.result)).toEqual({
            success: true,
            hapPath,
            installed: true
        });
        expect(fs.readFileSync(argsLogPath, 'utf8').includes(`install ${hapPath}`)).toBe(true);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

it('uninstallApp requires explicit destructive confirmation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-use-harmony-uninstall-test-'));
    const fakeHdcPath = path.join(tempDir, 'hdc');
    const argsLogPath = path.join(tempDir, 'hdc-args.log');
    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.HDC_ARGS_LOG;

    try {
        fs.writeFileSync(
            fakeHdcPath,
            [
                '#!/bin/sh',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  echo "FMR0223C13000649 Connected HarmonyOS Device"',
                '  exit 0',
                'fi',
                'printf "%s\\n" "$*" >> "$HDC_ARGS_LOG"',
                'if [ "$1" = "-t" ] && [ "$#" -ge 3 ]; then',
                '  shift 2',
                'fi',
                'if [ "$1" = "list" ] && [ "$2" = "targets" ]; then',
                '  printf "FMR0223C13000649\\tConnected\\tHarmonyOS Device\\n"',
                'elif [ "$1" = "uninstall" ]; then',
                '  printf "No Error\\n"',
                'fi'
            ].join('\n'),
            { mode: 0o755 }
        );
        process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
        process.env.HDC_ARGS_LOG = argsLogPath;

        const rejected = await new UninstallAppTool().execute({
            bundleName: 'com.example.app',
            confirmDestructive: false
        });
        expect(rejected.status).toBe('success');
        expect(JSON.parse(rejected.result).success).toBe(false);
        expect(fs.existsSync(argsLogPath)).toBe(false);

        const uninstalled = await new UninstallAppTool().execute({
            bundleName: 'com.example.app',
            confirmDestructive: true
        });
        expect(uninstalled.status).toBe('success');
        expect(JSON.parse(uninstalled.result)).toEqual({
            success: true,
            bundleName: 'com.example.app',
            uninstalled: true
        });
        expect(fs.readFileSync(argsLogPath, 'utf8').includes('uninstall com.example.app')).toBe(true);
    } finally {
        process.env.PATH = originalPath;
        if (originalArgsLog === undefined) delete process.env.HDC_ARGS_LOG;
        else process.env.HDC_ARGS_LOG = originalArgsLog;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
