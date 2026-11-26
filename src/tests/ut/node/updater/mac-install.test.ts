import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    findAppBundleOnVolume,
    installFromDmg,
    resolveAppBundlePath,
    type MacInstallRunner
} from '../../../../main/updater/mac-install.js';

// macOS 二期自动安装：ready 后挂载 DMG、ditto 复制到临时目录后瞬时 rename 替换运行中的 .app bundle，再卸载。
// 全部外部命令经 MacInstallRunner 注入，测试只断言命令编排与回滚顺序。
const dmgPath = '/cache/opendesk-darwin-arm64-0.4.0.dmg';
const appBundlePath = '/Applications/OpenDesk.app';
const mountPoint = '/Volumes/opendesk-update-ab12cd34';
const backupPath = appBundlePath + '.opendesk-update-backup';
const stagingPath = appBundlePath + '.opendesk-update-staging';

function createRecordingRunner(
    options: {
        volumeEntries?: string[];
        existingPaths?: string[];
        failWhen?: (command: string, args: string[]) => boolean;
    } = {}
): { runner: MacInstallRunner; commands: Array<{ command: string; args: string[] }> } {
    const commands: Array<{ command: string; args: string[] }> = [];
    // 有状态模拟：mv/rm/ditto 的副作用会改变路径存在性，
    // 让 pathExists 守卫（回滚/预清理）能按真实语义生效
    const existingPaths = new Set(options.existingPaths ?? []);
    const runner: MacInstallRunner = {
        run: async (command, args) => {
            commands.push({ command, args });
            if (options.failWhen?.(command, args)) {
                throw new Error(`${command} ${args[0]} exited with failure`);
            }
            if (command === 'mv') {
                const [from, to] = args;
                if (!existingPaths.has(from)) throw new Error(`${command} ${from} exited with failure`);
                existingPaths.delete(from);
                existingPaths.add(to);
            } else if (command === 'ditto') {
                existingPaths.add(args[1]);
            } else if (command === 'rm') {
                for (const target of args.slice(1)) existingPaths.delete(target);
            }
        },
        listDir: async () => options.volumeEntries ?? ['OpenDesk.app', 'readme.txt'],
        pathExists: (target) => existingPaths.has(target)
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
    assert.equal(await findAppBundleOnVolume('/Volumes/x', runner), path.join('/Volumes/x', 'Extra.app'));
});

test('findAppBundleOnVolume fails when the image has no app bundle', async () => {
    const runner = createListOnlyRunner(['readme.txt']);
    await assert.rejects(findAppBundleOnVolume('/Volumes/x', runner), /No application bundle found/);
});

test('installFromDmg mounts, copies to a staging directory and renames the previous bundle away', async () => {
    const { runner, commands } = createRecordingRunner({ existingPaths: [appBundlePath] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    // ditto 的秒级复制先落在 staging 目录，旧包只在两次瞬时 rename 之间离开原位
    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'mv', args: [appBundlePath, backupPath] },
        { command: 'mv', args: [stagingPath, appBundlePath] },
        { command: 'rm', args: ['-rf', backupPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg installs without a backup when the target bundle is missing', async () => {
    const { runner, commands } = createRecordingRunner({ existingPaths: [] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'mv', args: [stagingPath, appBundlePath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg pre-clears a residual backup left by an earlier failed cleanup', async () => {
    // mv 对已存在目录会把源移入其内部：残留备份不清掉，替换与回滚编排都会被破坏
    const { runner, commands } = createRecordingRunner({ existingPaths: [appBundlePath, backupPath] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'rm', args: ['-rf', backupPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'mv', args: [appBundlePath, backupPath] },
        { command: 'mv', args: [stagingPath, appBundlePath] },
        { command: 'rm', args: ['-rf', backupPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg reuses an interrupted backup when the target bundle is missing', async () => {
    // 上次安装被打断（旧包已移入备份、目标位空置）：备份充当旧包，成功替换后一并清理
    const { runner, commands } = createRecordingRunner({ existingPaths: [backupPath] });

    await installFromDmg({ dmgPath, appBundlePath, mountPoint, runner });

    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'mv', args: [stagingPath, appBundlePath] },
        { command: 'rm', args: ['-rf', backupPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg keeps the previous bundle intact when ditto fails', async () => {
    const { runner, commands } = createRecordingRunner({
        existingPaths: [appBundlePath],
        failWhen: (command) => command === 'ditto'
    });

    await assert.rejects(
        installFromDmg({ dmgPath, appBundlePath, mountPoint, runner }),
        /ditto .* exited with failure/
    );

    // 复制阶段失败只清理半成品 staging：旧包从未离开原位，无需回滚
    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'rm', args: ['-rf', stagingPath] },
        { command: 'hdiutil', args: ['detach', mountPoint] }
    ]);
});

test('installFromDmg rolls the previous bundle back when the final rename fails', async () => {
    const { runner, commands } = createRecordingRunner({
        existingPaths: [appBundlePath],
        failWhen: (command, args) => command === 'mv' && args[0] === stagingPath
    });

    await assert.rejects(installFromDmg({ dmgPath, appBundlePath, mountPoint, runner }), /mv .* exited with failure/);

    // 替换阶段失败回滚：旧包从备份移回原位，之后仍然卸载卷
    assert.deepEqual(commands, [
        { command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath] },
        { command: 'ditto', args: [path.join(mountPoint, 'OpenDesk.app'), stagingPath] },
        { command: 'mv', args: [appBundlePath, backupPath] },
        { command: 'mv', args: [stagingPath, appBundlePath] },
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
