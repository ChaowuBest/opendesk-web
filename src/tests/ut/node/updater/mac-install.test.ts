import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    findAppBundleOnVolume,
    installFromDmg,
    resolveAppBundlePath,
    type MacInstallRunner
} from '../../../../main/updater/mac-install.js';

// macOS 二期自动安装：ready 后挂载 DMG、ditto 替换运行中的 .app bundle，再卸载。
// 全部外部命令经 MacInstallRunner 注入，测试只断言命令编排与回滚顺序。
const dmgPath = '/cache/opendesk-darwin-arm64-0.4.0.dmg';
const appBundlePath = '/Applications/OpenDesk.app';
const mountPoint = '/Volumes/opendesk-update-ab12cd34';
const backupPath = appBundlePath + '.opendesk-update-backup';

function createRecordingRunner(
    options: {
        volumeEntries?: string[];
        existingPaths?: string[];
        failWhen?: (command: string, args: string[]) => boolean;
    } = {}
): { runner: MacInstallRunner; commands: Array<{ command: string; args: string[] }> } {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: MacInstallRunner = {
        run: async (command, args) => {
            commands.push({ command, args });
            if (options.failWhen?.(command, args)) {
                throw new Error(`${command} ${args[0]} exited with failure`);
            }
        },
        listDir: async () => options.volumeEntries ?? ['OpenDesk.app', 'readme.txt'],
        pathExists: (target) => options.existingPaths?.includes(target) ?? false
    };
    return { runner, commands };
}

function createListOnlyRunner(entries: string[]): MacInstallRunner {
    return {
        run: async () => undefined,
        listDir: async () => entries,
        pathExists: () => false
    };
}

test('resolveAppBundlePath maps an executable inside a bundle to the app path', () => {
    const execPath = '/Applications/OpenDesk.app/Contents/MacOS/OpenDesk';
    assert.equal(resolveAppBundlePath(execPath), '/Applications/OpenDesk.app');
});

test('resolveAppBundlePath rejects paths outside an application bundle', () => {
    // 直接跑 node/electron 可执行文件时没有 bundle 可替换，必须拒绝而不是替换任意目录
    assert.equal(resolveAppBundlePath('/usr/local/bin/node'), undefined);
    assert.equal(resolveAppBundlePath('/Applications/OpenDesk.app/Contents/Resources/app.asar'), undefined);
});

test('findAppBundleOnVolume picks the first app bundle deterministically', async () => {
    const runner = createListOnlyRunner(['readme.txt', 'Extra.app', 'OpenDesk.app']);
    assert.equal(await findAppBundleOnVolume('/Volumes/x', runner), '/Volumes/x/Extra.app');
});

test('findAppBundleOnVolume fails when the image has no app bundle', async () => {
    const runner = createListOnlyRunner(['readme.txt']);
    await assert.rejects(findAppBundleOnVolume('/Volumes/x', runner), /No application bundle found/);
});

test('installFromDmg mounts, replaces the previous bundle and detaches', async () => {
    const { runner, commands } = createRecordingRunner({ existingPaths: [appBundlePath] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'mv', args: [appBundlePath, backupPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), appBundlePath] },
        { command: 'rm', args: ['-rf', backupPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg installs without a backup when the target bundle is missing', async () => {
    const { runner, commands } = createRecordingRunner({ existingPaths: [] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), appBundlePath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg rolls the previous bundle back when ditto fails', async () => {
    const { runner, commands } = createRecordingRunner({
        existingPaths: [appBundlePath],
        failWhen: (command) => command === 'ditto'
    });

    await assert.rejects(
        installFromDmg({ dmgPath, appBundlePath, mountPoint, runner }),
        /ditto .* exited with failure/
    );

    // 回滚顺序：清掉半安装目录 → 把旧包移回原位，之后仍然卸载卷
    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'mv', args: [appBundlePath, backupPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), appBundlePath] },
        { command: 'rm', args: ['-rf', appBundlePath] },
        { command: 'mv', args: [backupPath, appBundlePath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg still detaches when the image has no app bundle', async () => {
    const { runner, commands } = createRecordingRunner({ volumeEntries: ['readme.txt'] });

    await assert.rejects(installFromDmg({ dmgPath, appBundlePath, mountPoint, runner }), /No application bundle/);

    // 挂载失败后不能把卷留在文件系统里
    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg ignores a failing detach after a successful install', async () => {
    const { runner, commands } = createRecordingRunner({
        existingPaths: [appBundlePath],
        failWhen: (command, args) => command === 'hdiutil' && args[0] === 'detach'
    });

    // 安装已经完成，卸载失败只影响卷释放（系统重启/用户弹出兜底），不能当成安装失败
    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.equal(commands.at(-1)?.command, 'hdiutil');
    assert.equal(commands.at(-1)?.args[0], 'detach');
});
