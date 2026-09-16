import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('Windows sandbox sources and build entrypoint are included', () => {
    const project = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Dynobox.csproj');
    const buildScript = path.join(root, 'scripts', 'build-windows-sandbox.cjs');
    const policy = path.join(root, 'native', 'windows', 'sandbox', 'src', 'Dynobox', 'Policy.cs');
    const runtime = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'sandboxes', 'dynabox.ts'),
        'utf8'
    );
    const forgeConfig = fs.readFileSync(path.join(root, 'forge.config.cjs'), 'utf8');
    const bundle = fs.readFileSync(path.join(root, 'resources', 'package', 'bootstrapper', 'bundle.wxs'), 'utf8');
    const bootstrapperBuild = fs.readFileSync(path.join(root, 'scripts', 'build-wix-bootstrapper.mjs'), 'utf8');

    assert.equal(fs.existsSync(project), true);
    assert.equal(fs.existsSync(buildScript), true);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /PublishSingleFile=true/);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /runtimeDirectory[\s\S]*sandbox\.exe/);
    assert.match(forgeConfig, /resourcesRoot, 'sandbox'/);
    assert.match(
        bundle,
        /<MsiPackage Id="DokanMsi"[\s\S]*?SourceFile="\$\(var\.DokanMsiPath\)"[\s\S]*?InstallCondition="NOT DokanVersion/
    );
    assert.match(bootstrapperBuild, /DokanSetup\.msi/);
    assert.match(runtime, /resourcesPath \|\| ''[\s\S]*?sandbox', 'sandbox\.exe'/);
    assert.match(runtime, /native', 'windows', 'sandbox', 'runtime', 'sandbox\.exe'/);
    assert.match(fs.readFileSync(policy, 'utf8'), /AuthenticationHeaderValue\("Bearer"/);
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
    // TS 侧透传链路：任务设置 -> pwsh 工具 -> 沙箱启动参数
    assert.match(app, /shell_sandbox_del_to_trash/);
    assert.match(pwsh, /sandboxDeleteToTrash/);
    assert.match(shellCommon, /deleteToTrash: sandboxDeleteToTrash/);
    assert.match(runtime, /--del-to-trash/);
    // 原生侧解析与执行：CLI 标志 -> Sandbox -> MirrorFs 回收站删除
    assert.equal(fs.existsSync(recycleBin), true);
    assert.match(program, /--del-to-trash/);
    assert.match(runner, /DeleteToTrash = delToTrash/);
    // 回归（BUG-2）：内部路径判定必须用规范虚拟路径（res.VirtualPath），
    // 原始请求名可能携带 /dynobox/../ 段逃逸前缀匹配导致用户文件被永久删除
    assert.match(mirror, /DeleteToTrash && !IsSandboxInternalPath\(res\.VirtualPath\)/);
    assert.match(mirror, /Policy\.IsInternalAppContainerPath/);
    assert.match(mirror, /RecycleBin\.TrySend/);
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /SHFileOperationW/);
    // 回归（BUG-4）：系统禁用回收站（NukeOnDelete/MaxCapacity=0）时
    // FOF_ALLOWUNDO 会静默永久删除，必须在删除前检测并拒绝
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /IsBinDisabledForDrive/);
    assert.match(fs.readFileSync(recycleBin, 'utf8'), /NukeOnDelete/);
});
