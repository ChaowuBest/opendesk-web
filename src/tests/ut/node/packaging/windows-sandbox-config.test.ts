import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const require = createRequire(import.meta.url);
const forgeConfig = require('../../../../../forge.config.cjs');

test('Windows sandbox sources and build entrypoint are included', () => {
    const project = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Dynobox.csproj');
    const buildScript = path.join(root, 'scripts', 'build-windows-sandbox.cjs');
    const policy = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Policy.cs');
    const runtime = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'sandboxes', 'dynabox.ts'),
        'utf8'
    );
    const forgeConfigSource = fs.readFileSync(path.join(root, 'forge.config.cjs'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'scripts', 'windows-installer', 'build-installer.mjs'), 'utf8');
    const arm64Installer = fs.readFileSync(path.join(root, 'scripts', 'make-arm64-setup.mjs'), 'utf8');

    assert.equal(fs.existsSync(project), true);
    assert.equal(fs.existsSync(buildScript), true);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /PublishSingleFile=true/);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /runtimeDirectory[\s\S]*sandbox\.exe/);
    assert.match(forgeConfigSource, /resourcesRoot, 'sandbox'/);
    assert.match(
        installer,
        /const targetWindowsArch = process\.env\.OPENDESK_WIX_ARCH \|\| 'x64'[\s\S]*?const targetWindowsRid = targetWindowsArch === 'arm64' \? 'win-arm64' : 'win-x64'[\s\S]*?path\.join\(projectRoot, 'native', 'windows', 'sandbox', 'dist', targetWindowsRid, 'bin', 'DokanSetup\.msi'\)/
    );
    assert.match(
        installer,
        /<MsiPackage Id="DokanMsi"[\s\S]*?SourceFile="\$\{xml\(dokanMsi\)\}"[\s\S]*?InstallCondition="NOT DokanVersion/
    );
    assert.match(
        arm64Installer,
        /OPENDESK_DOKAN_MSI_PATH:\s*path\.join\([\s\S]*?'native',[\s\S]*?'windows',[\s\S]*?'sandbox',[\s\S]*?'dist',[\s\S]*?'win-arm64',[\s\S]*?'bin',[\s\S]*?'DokanSetup\.msi'/
    );
    assert.match(runtime, /resourcesPath \|\| ''[\s\S]*?sandbox', 'sandbox\.exe'/);
    assert.match(runtime, /native', 'windows', 'sandbox', 'runtime', 'sandbox\.exe'/);
    assert.match(fs.readFileSync(policy, 'utf8'), /AuthenticationHeaderValue\("Bearer"/);
});

test('stageWindowsSandboxResource 仅复制目标架构 sandbox.exe 并移除外侧构建树', async () => {
    const sourceRoot = path.join(root, 'native', 'windows', 'sandbox', 'dist');
    const architectures = [
        ['x64', 'win-x64'],
        ['arm64', 'win-arm64'],
        ['ia32', 'win-x86']
    ] as const;

    for (const [arch, rid] of architectures) {
        const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-sandbox-stage-${arch}-`));
        const staleTree = path.join(buildPath, 'resources', 'native', 'windows', 'sandbox');
        const copiedFiles: Array<{ source: string; target: string }> = [];
        const originalExistsSync = fs.existsSync;
        const originalCopyFileSync = fs.copyFileSync;

        try {
            fs.mkdirSync(path.join(staleTree, 'dist', 'win-x64', 'bin'), { recursive: true });
            fs.writeFileSync(path.join(staleTree, 'dist', 'win-x64', 'bin', 'DokanSetup.msi'), 'driver');

            // Mock only the native source existence check. The destination remains a real
            // temporary directory, so this test never creates or modifies build artifacts.
            fs.existsSync = ((candidate: fs.PathLike): boolean => {
                const candidatePath = path.resolve(candidate.toString());
                if (candidatePath.startsWith(sourceRoot) && candidatePath.endsWith(path.join('bin', 'sandbox.exe'))) {
                    return true;
                }
                return originalExistsSync(candidate);
            }) as typeof fs.existsSync;
            fs.copyFileSync = ((source: fs.PathLike, target: fs.PathLike, ...args: any[]): void => {
                copiedFiles.push({ source: source.toString(), target: target.toString() });
                if (path.resolve(source.toString()).startsWith(sourceRoot)) {
                    fs.writeFileSync(target, 'sandbox');
                    return;
                }
                originalCopyFileSync(source, target, ...args);
            }) as typeof fs.copyFileSync;

            const error = await new Promise<Error | undefined>((resolve) => {
                forgeConfig.stageWindowsSandboxResource(buildPath, '39.2.6', 'win32', arch, resolve);
            });
            assert.equal(error, undefined);

            const target = path.join(buildPath, 'resources', 'sandbox', 'sandbox.exe');
            assert.equal(fs.existsSync(target), true);
            assert.equal(fs.readFileSync(target, 'utf8'), 'sandbox');
            assert.deepEqual(copiedFiles, [
                {
                    source: path.join(sourceRoot, rid, 'bin', 'sandbox.exe'),
                    target
                }
            ]);
            assert.equal(fs.existsSync(staleTree), false);
            assert.equal(
                copiedFiles.some(({ source }) => /Dokan|\.msi$/i.test(source)),
                false
            );
        } finally {
            fs.existsSync = originalExistsSync;
            fs.copyFileSync = originalCopyFileSync;
            fs.rmSync(buildPath, { recursive: true, force: true });
        }
    }
});

test('delete-to-trash is wired from the task setting through to the native mirror', () => {
    const nativeDir = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox');
    const program = fs.readFileSync(path.join(nativeDir, 'Program.cs'), 'utf8');
    const runner = fs.readFileSync(path.join(nativeDir, 'Runner.cs'), 'utf8');
    const mirror = fs.readFileSync(path.join(nativeDir, 'MirrorFs.cs'), 'utf8');
    const recycleBin = path.join(nativeDir, 'RecycleBin.cs');
    const runtime = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'sandboxes', 'dynabox.ts'),
        'utf8'
    );
    const shellCommon = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'shells', 'common.ts'),
        'utf8'
    );
    const pwsh = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'shells', 'pwsh.ts'),
        'utf8'
    );
    const app = fs.readFileSync(path.join(root, 'src', 'main', 'applications', 'terminal', 'app.ts'), 'utf8');
    const setting = fs.readFileSync(path.join(root, 'src', 'main', 'utils', 'setting.ts'), 'utf8');

    // 设置项存在且默认关闭
    assert.match(setting, /shell_sandbox_del_to_trash: z\.boolean\(\)\.default\(false\)/);
    // TS 侧透传链路：任务设置 -> pwsh 工具 -> 沙箱启动参数；
    // 实例内新建的分流由原生侧创建跟踪实现，宿主不传额外参数
    assert.match(app, /shell_sandbox_del_to_trash/);
    assert.match(pwsh, /sandboxDeleteToTrash/);
    assert.match(shellCommon, /deleteToTrash: sandboxDeleteToTrash/);
    assert.match(runtime, /--del-to-trash/);
    assert.doesNotMatch(runtime, /--created-after/);
    // 原生侧解析与执行：CLI 标志 -> Sandbox -> MirrorFs 回收站删除
    assert.equal(fs.existsSync(recycleBin), true);
    assert.match(program, /--del-to-trash/);
    assert.match(runner, /DeleteToTrash = delToTrash/);
    // 回归（BUG-2）：内部路径判定必须用规范虚拟路径（res.VirtualPath），
    // 原始请求名可能携带 /dynobox/../ 段逃逸前缀匹配导致用户文件被永久删除。
    // ShouldSendToTrash 汇总回收站判定，必须接收规范虚拟路径并检查内部区域
    assert.match(mirror, /ShouldSendToTrash\(res\.VirtualPath\)/);
    assert.match(mirror, /if \(IsSandboxInternalPath\(virtualPath\)\) return false;/);
    // 实例内创建跟踪：本沙箱实例运行期间新建的路径删除时直接清除（避免回收站
    // 被任务期间的临时文件灌满），跟踪表随实例结束丢弃，不跨实例残留
    assert.match(mirror, /_sessionCreated\.ContainsKey\(virtualPath\)/);
    assert.match(mirror, /TrackSessionCreated\(res\.VirtualPath\)/);
    assert.match(mirror, /FollowSessionCreatedMove\(oldVp, newVp, targetExistedBefore\)/);
    assert.match(mirror, /Policy\.IsInternalAppContainerPath/);
    assert.match(mirror, /RecycleBin\.TrySend/);
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /SHFileOperationW/);
    // 回归（BUG-4）：系统禁用回收站（NukeOnDelete/MaxCapacity=0）时
    // FOF_ALLOWUNDO 会静默永久删除，必须在删除前检测并拒绝
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /IsBinDisabledForDrive/);
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /NukeOnDelete/);
});
