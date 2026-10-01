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
    const nativeDir = path.join(root, 'native', 'windows', 'sandbox', 'src');
    const makefile = path.join(nativeDir, 'Makefile');
    const buildNative = path.join(nativeDir, 'build-native.cjs');
    const buildScript = path.join(root, 'scripts', 'build-windows-sandbox.cjs');
    const hookDll = path.join(nativeDir, 'hook', 'dllmain.cpp');
    const runtime = fs.readFileSync(
        path.join(root, 'src', 'main', 'applications', 'terminal', 'sandboxes', 'dynabox.ts'),
        'utf8'
    );
    const forgeConfigSource = fs.readFileSync(path.join(root, 'forge.config.cjs'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'scripts', 'windows-installer', 'build-installer.mjs'), 'utf8');

    assert.equal(fs.existsSync(makefile), true);
    assert.equal(fs.existsSync(buildNative), true);
    assert.equal(fs.existsSync(buildScript), true);
    assert.equal(fs.existsSync(hookDll), true);
    // MSVC + nmake 构建；hook DLL 与 sandbox.exe 同目录交付
    assert.match(fs.readFileSync(buildNative, 'utf8'), /vcvars(?:64|32|amd64_arm64)\.bat/);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /build-native\.cjs/);
    assert.match(fs.readFileSync(buildScript, 'utf8'), /runtimeDirectory[\s\S]*sandbox\.exe/);
    assert.match(forgeConfigSource, /resourcesRoot, 'sandbox'/);
    assert.match(forgeConfigSource, /sandbox_hook\.dll/);
    // 安装器不再打包 Dokan 驱动
    assert.doesNotMatch(installer, /DokanMsi|DokanSetup|dokan2\.dll/);
    assert.match(runtime, /resourcesPath \|\| ''[\s\S]*?sandbox', 'sandbox\.exe'/);
    assert.match(runtime, /native', 'windows', 'sandbox', 'runtime', 'sandbox\.exe'/);
    // Detours 注入 DLL 的入口必须是全局 extern "C"（被名字修饰会导致 CRT 不调用、
    // 链接器 /OPT:REF 丢弃整个 hook 链）
    assert.match(fs.readFileSync(hookDll, 'utf8'), /extern "C" BOOL APIENTRY DllMain/);
    // ask 协议带 Bearer token（C++ 侧）
    assert.match(fs.readFileSync(path.join(nativeDir, 'common', 'ask.cpp'), 'utf8'), /Bearer/);
});

test('stageWindowsSandboxResource 仅复制目标架构 sandbox.exe/hook DLL 并移除外侧构建树', async () => {
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
            fs.writeFileSync(path.join(staleTree, 'dist', 'win-x64', 'bin', 'sandbox_hook.dll'), 'hook');

            // Mock only the native source existence check. The destination remains a real
            // temporary directory, so this test never creates or modifies build artifacts.
            fs.existsSync = ((candidate: fs.PathLike): boolean => {
                const candidatePath = path.resolve(candidate.toString());
                if (candidatePath.startsWith(sourceRoot) && candidatePath.endsWith(path.join('bin', 'sandbox.exe'))) {
                    return true;
                }
                if (
                    candidatePath.startsWith(sourceRoot) &&
                    candidatePath.endsWith(path.join('bin', 'sandbox_hook.dll'))
                ) {
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
            const hookTarget = path.join(buildPath, 'resources', 'sandbox', 'sandbox_hook.dll');
            assert.equal(fs.existsSync(target), true);
            assert.equal(fs.readFileSync(target, 'utf8'), 'sandbox');
            assert.equal(fs.existsSync(hookTarget), true);
            assert.ok(
                copiedFiles.some(
                    ({ source, target: t }) =>
                        source === path.join(sourceRoot, rid, 'bin', 'sandbox.exe') && t === target
                )
            );
            assert.ok(
                copiedFiles.some(
                    ({ source, target: t }) =>
                        source === path.join(sourceRoot, rid, 'bin', 'sandbox_hook.dll') && t === hookTarget
                )
            );
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

test('delete-to-trash is wired from the task setting through to the native hooks', () => {
    const nativeDir = path.join(root, 'native', 'windows', 'sandbox', 'src');
    const main = fs.readFileSync(path.join(nativeDir, 'manager', 'main.cpp'), 'utf8');
    const runner = fs.readFileSync(path.join(nativeDir, 'manager', 'runner.cpp'), 'utf8');
    const hooksFile = fs.readFileSync(path.join(nativeDir, 'hook', 'hooks_file.cpp'), 'utf8');
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
    // 原生侧解析与执行：CLI 标志 -> 注入 DLL 环境 -> 回收站删除（hook 内）
    assert.match(main, /--del-to-trash/);
    assert.match(runner, /DYNOBOX_DEL_TO_TRASH/);
    assert.match(hooksFile, /SHFileOperationW/);
    assert.match(hooksFile, /FOF_ALLOWUNDO/);
    assert.match(hooksFile, /recycleToTrash/);
    // 回收站不可用时保留原文件、绝不静默永久删除
    assert.match(hooksFile, /回收站删除失败/);
});
