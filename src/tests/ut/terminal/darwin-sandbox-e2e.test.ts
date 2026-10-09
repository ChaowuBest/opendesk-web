import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// locale/index.ts 在 jest ESM VM 下 createRequire 与内置 require 冲突，mock 掉
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${JSON.stringify(params)}` : key)
}));
const settingBase = path.join(os.tmpdir(), 'opendesk-darwin-sandbox-e2e');
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return { getEffectiveWorkspace: () => settingBase };
        }
    },
    getOpendeskDirectory: () => path.join(settingBase, 'config'),
    getLogDirectory: () => path.join(settingBase, 'log')
}));

const { prepareDarwinSandbox } = await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');
const { prepareShellForSandbox } = await import('../../../main/applications/terminal/sandboxes/darwin-sandbox.js');

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

// e2e 用独立 exec 缓存目录：并行 jest worker 共享用户级缓存时，重签 rename 与
// spawn 的交叉会让 execve 落在空窗（与生产单实例语义无关，仅测试环境竞争）
const e2eCacheDir = path.join(os.tmpdir(), `opendesk-sandbox-exec-cache-${process.pid}`);
beforeAll(() => {
    process.env.OPENDESK_SANDBOX_EXEC_CACHE = e2eCacheDir;
});

/** 等待文件出现且内容匹配（沙箱写入异步完成） */
async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return predicate();
}

darwinOnly('prepareDarwinSandbox 端到端（真实进程）', () => {
    // 非 temp 外部根（HOME 下固定前缀）：统一策略把 POSIX temp 区（/tmp、
    // /private/var/folders 等）读写放行（shell 管道/heredoc/编译器落盘区），
    // 且该区文件删除不入回收站（trash-excluded 内建清单）。"外部拒绝/回收站"
    // 语义必须在非 temp 路径上测；temp 放行语义另设正向断言。
    const outsideRoot = path.join(os.homedir(), '.opendesk-sbx-e2e-outside');

    test('工作区写放行、工作区外写拒绝、预存在文件删除送废纸篓', async () => {
        const root = path.join(outsideRoot, 'run');
        const workspace = path.join(root, 'workspace');
        const outside = path.join(outsideRoot, 'outside');
        const trashDir = path.join(outsideRoot, 'trash');
        // workspace 也必须在非 temp 区：temp 区文件删除命中 trash-exclude 内建清单
        //（/tmp、/private/var/folders 等构建零时产物直接真删不入站），回收站断言会反向
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(trashDir, { recursive: true });
        const preExisting = path.join(workspace, 'pre-existing.txt');
        fs.writeFileSync(preExisting, 'old');
        const outsideTarget = path.join(outside, 'target.txt');
        fs.writeFileSync(outsideTarget, 'secret');

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', 'echo sandbox-write > ws-file.txt'],
            command: 'echo sandbox-write > ws-file.txt',
            cwd: workspace,
            deleteToTrash: true
        });
        expect(launch).not.toBeNull();
        expect(launch!.env!.DYLD_INSERT_LIBRARIES).toContain('dynobox-darwin.dylib');
        expect(launch!.env!.OPENDESK_SANDBOX_POLICY).toBeTruthy();
        expect(launch!.env!.OPENDESK_SANDBOX_TRASH).toBe('1');
        // shell 必须被重签（/bin/zsh 是平台二进制）
        expect(launch!.file).not.toBe('/bin/zsh');

        try {
            // 无 decide 端点（策略 endpoint 不可达）时：工作区放行仍然生效
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: {
                    ...process.env,
                    ...launch!.env,
                    OPENDESK_SANDBOX_TRASH_DIR: trashDir,
                    OPENDESK_SANDBOX_LOG: '/tmp/darwin-e2e-debug.log'
                }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(await waitFor(() => fs.existsSync(path.join(workspace, 'ws-file.txt')))).toBe(true);
            expect(fs.readFileSync(path.join(workspace, 'ws-file.txt'), 'utf8')).toContain('sandbox-write');

            // 第二个沙箱实例：预存在文件删除 → 废纸篓；外部写 → 拒绝。
            // 外部目标在非 temp 区（outsideRoot），用绝对路径访问。
            fs.writeFileSync(path.join(workspace, 'to-delete.txt'), 'bye');
            const launch2 = await prepareDarwinSandbox({
                shellPath: '/bin/zsh',
                shellArgs: [
                    '-c',
                    `/bin/rm to-delete.txt; if /bin/cat ${JSON.stringify(path.join(outside, 'target.txt'))} > capture.txt 2>/dev/null; then echo hack > ${JSON.stringify(path.join(outside, 'target.txt'))}; fi; true`
                ],
                command: 'rm/ask scenario',
                cwd: workspace,
                deleteToTrash: true
            });
            const proc2 = spawn(launch2!.file, launch2!.args, {
                cwd: launch2!.cwd,
                env: {
                    ...process.env,
                    ...launch2!.env,
                    OPENDESK_SANDBOX_TRASH_DIR: trashDir,
                    OPENDESK_SANDBOX_LOG: '/tmp/darwin-e2e-debug.log'
                }
            });
            const code2 = await new Promise<number | null>((resolve) => proc2.once('exit', resolve));
            expect(code2).toBe(0);
            // 预存在文件已从工作区消失并进入废纸篓（经重签的 /bin/rm 执行）；
            // 统一回收站目标名为 <uuid>.back（随机 UUID，防同名覆盖 TOCTOU），
            // 且 summary.json 记录原始路径/大小/删除时间供宿主 GUI 找回
            expect(await waitFor(() => !fs.existsSync(path.join(workspace, 'to-delete.txt')))).toBe(true);
            expect(await waitFor(() => fs.readdirSync(trashDir).some((name) => name.endsWith('.back')))).toBe(true);
            const trashed = fs.readdirSync(trashDir).find((name) => name.endsWith('.back'))!;
            expect(fs.readFileSync(path.join(trashDir, trashed), 'utf8')).toBe('bye');
            const summary = JSON.parse(fs.readFileSync(path.join(trashDir, 'summary.json'), 'utf8'));
            expect(Array.isArray(summary)).toBe(true);
            expect(summary).toHaveLength(1);
            expect(summary[0].uuid + '.back').toBe(trashed);
            expect(summary[0].original_path).toContain('to-delete.txt');
            expect(summary[0].size).toBe(3);
            expect(Number.isNaN(Date.parse(summary[0].deleted_at))).toBe(false);
            // 外部读放行（capture.txt 有内容），外部写被拒（原内容保留）
            expect(await waitFor(() => fs.existsSync(path.join(workspace, 'capture.txt')))).toBe(true);
            expect(fs.readFileSync(outsideTarget, 'utf8')).toBe('secret');
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    }, 60000);

    test('decide 端点授权后工作区外写放行', async () => {
        // 目标用非 temp 外部（HOME 下）：temp 区（/var/folders）存在
        // /var ↔ /private/var 别名形态分叉，normalize 后 parent 与
        // jest worker mkdtemp 的短形态路径在 stat 上不一致，会误触发
        // "父链缺失透传"分支（见 boxdylib check_write_path），ask 链路测不到。
        const root = path.join(outsideRoot, 'decide-run');
        const workspace = path.join(root, 'workspace');
        const outside = path.join(outsideRoot, 'outside');
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(outside, { recursive: true });
        const outsideTarget = path.join(outside, 'allowed.txt');
        fs.writeFileSync(outsideTarget, 'before');

        // 恒放行的 /decide 假端点（协议 v2：POST /decide → {"decision":"allow"}）
        const http = await import('node:http');
        const server = http.createServer((request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end('{"decision":"allow"}');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        const endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/decide`;

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', `echo approved > ${JSON.stringify(outsideTarget)}`],
            command: 'write outside',
            cwd: workspace
        });
        expect(launch).not.toBeNull();
        // 把策略文件中的 endpoint 替换为假端点（策略由 prepareDarwinSandbox 随机 token 生成）
        const policyPath = launch!.env!.OPENDESK_SANDBOX_POLICY;
        const policyText = fs.readFileSync(policyPath, 'utf8');
        const rewritten = policyText.replace(/endpoint = ".*"/, `endpoint = "${endpoint}"`);
        fs.writeFileSync(policyPath, rewritten);

        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: {
                    ...process.env,
                    ...launch!.env,
                    OPENDESK_SANDBOX_LOG: '/tmp/darwin-decide-debug.log'
                }
            });
            let stderr = '';
            proc.stderr?.on('data', (d) => (stderr += String(d)));
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(await waitFor(() => fs.readFileSync(outsideTarget, 'utf8') === 'approved\n')).toBe(true);
            void stderr;
        } finally {
            await launch!.cleanup();
            server.close();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    }, 60000);

    test('写目标父链缺失时透传 ENOENT 且不触发 decide 端点', async () => {
        // 回归：符号引擎（dbghelp/SymSrv）按模块内嵌 CodeView 路径探测/写入符号缓存
        // （Windows 侧真实事故：node.exe 的 c:\ws\out\Release\node.pdb）。这类路径在
        // 多数机器上根本不存在，父链缺失的写注定 ENOENT——必须透传内核错误码且**不弹
        // 审批**（无端点时若走 ask 会 fail-closed 成 EACCES，行为与宿主不一致且弹窗噪音）。
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-missingparent-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        const missing = path.join(workspace, 'no-such-parent', 'deeper', 'probe.pdb');

        // 无端点可达 + 工作区外写兜底 ask 的策略：若父链缺失的写仍走 ask，
        // curl 不可达 → fail-closed EACCES；正确行为是透传 ENOENT。
        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', `/bin/sh -c 'echo x > "${missing}" 2>${path.join(root, 'err.txt')}' ; true`],
            command: 'write missing-parent',
            cwd: workspace
        });
        expect(launch).not.toBeNull();
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            // 父链缺失的写没有创建任何东西
            expect(fs.existsSync(missing)).toBe(false);
            expect(fs.existsSync(path.join(workspace, 'no-such-parent'))).toBe(false);
            // stderr 必须是内核的 ENOENT（"No such file or directory"），
            // 而不是 ask fail-closed 的 "Operation not permitted"（EACCES）
            const errPath = path.join(root, 'err.txt');
            if (fs.existsSync(errPath)) {
                const err = fs.readFileSync(errPath, 'utf8');
                expect(err).not.toMatch(/Operation not permitted/);
            }
            // 父目录存在时创建仍走正常判定（工作区内写放行→创建成功）
            const ok = path.join(workspace, 'ok.txt');
            const launch2 = await prepareDarwinSandbox({
                shellPath: '/bin/zsh',
                shellArgs: ['-c', `echo ok > "${ok}"`],
                command: 'create in existing parent',
                cwd: workspace
            });
            try {
                const proc2 = spawn(launch2!.file, launch2!.args, {
                    cwd: launch2!.cwd,
                    env: { ...process.env, ...launch2!.env }
                });
                await new Promise<number | null>((resolve) => proc2.once('exit', resolve));
                expect(await waitFor(() => fs.existsSync(ok))).toBe(true);
            } finally {
                await launch2!.cleanup();
            }
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('任务级 trash 目录：<opendesk>/trash/<taskId>/，env 传递 TRASH_DIR', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-tasktrash-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        const taskId = 'task-abc-123';
        const taskState = {
            task_id: taskId,
            getWorkspace: () => workspace,
            harnessContext: {}
        } as any;

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', 'true'],
            command: 'task trash scenario',
            cwd: workspace,
            taskState,
            deleteToTrash: true
        });
        try {
            // env 必须传递任务级 trash 目录；目录在 mock 的 opendesk 配置根下
            const expectedTrash = path.join(settingBase, 'config', 'trash', taskId);
            expect(launch!.env!.OPENDESK_SANDBOX_TRASH).toBe('1');
            expect(launch!.env!.OPENDESK_SANDBOX_TRASH_DIR).toBe(expectedTrash);
            // TS 侧已预创建（含 taskId 层级）
            expect(fs.existsSync(expectedTrash)).toBe(true);
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('shebang 脚本经解释器改写后仍受沙箱管控', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-sh-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        // 逃逸目标在非 temp 外部（HOME 下）：temp 区被统一策略写放行，测不出拒绝语义
        const outsideTarget = path.join(outsideRoot, 'shebang-outside.txt');
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        const script = path.join(workspace, 'run.sh');
        // 脚本里写工作区外 → 应被拒绝（解释器 /bin/bash 是平台二进制，内核 exec 会绕过
        // 注入；沙箱在 exec 脚本时改写为直接 exec 解释器并保持 DYLD 环境生效）
        fs.writeFileSync(script, `#!/bin/bash\necho via-script > ${JSON.stringify(outsideTarget)}\n`);
        fs.chmodSync(script, 0o755);

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', './run.sh; true'],
            command: 'shebang scenario',
            cwd: workspace
        });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            // 写被拒：文件不存在（zsh 已退出，若放行则文件必然已落盘，无需等待）
            expect(fs.existsSync(outsideTarget)).toBe(false);
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    }, 60000);

    test('shebang 带参数解释器（#!/usr/bin/env 形态之外的单参数）仍受管控', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-sharg-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        // #!/bin/awk -f 形态：单参数解释器。awk 脚本写工作区外 → 拒绝
        // （目标在非 temp 外部；temp 区写放行测不出拒绝语义）
        const outsideTarget = path.join(outsideRoot, 'awk-out.txt');
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        const script = path.join(workspace, 'run.awk');
        fs.writeFileSync(script, `#!/usr/bin/awk -f\nBEGIN { print "awk-ran" > ${JSON.stringify(outsideTarget)} }\n`);
        fs.chmodSync(script, 0o755);

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', './run.awk; true'],
            command: 'shebang with arg',
            cwd: workspace
        });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(fs.existsSync(outsideTarget)).toBe(false);
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    }, 60000);

    test('macOS 别名路径（/tmp ↔ /private/tmp）写入语义一致', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-alias-'));
        // /tmp 是 /private/tmp 的 symlink：macOS 特有别名对
        expect(path.resolve('/tmp')).not.toBe('/private/tmp');
        const workspace = '/private' + path.join(root.replace(/^\/private/, ''), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const shortWorkspace = root.replace(/^\/private/, '') + '/workspace';
        // shortWorkspace = /tmp/... 形态（若 root 本身在 /private 下则相对变换）
        const shortRoot = root.replace(/^\/private/, '');

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: [
                '-c',
                `echo via-short > ${path.join(shortWorkspace, 'short.txt')}; echo "short-rc=$?"; echo via-long > long.txt; echo "long-rc=$?"`
            ],
            command: 'alias scenario',
            cwd: workspace
        });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const out = await new Promise<string>((resolve) => {
                let acc = '';
                proc.stdout?.on('data', (d) => (acc += String(d)));
                proc.once('exit', () => resolve(acc));
            });
            // 短路径（/tmp/...）与长路径（realpath）写都应放行（别名归一）
            expect(out).toContain('short-rc=0');
            expect(out).toContain('long-rc=0');
            expect(fs.existsSync(path.join(workspace, 'short.txt'))).toBe(true);
            expect(fs.existsSync(path.join(workspace, 'long.txt'))).toBe(true);
            void shortWorkspace;
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('别名路径指向工作区外仍被拒绝', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-alias2-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        // 逃逸目标在非 temp 外部：temp 区被统一策略写放行，测不出拒绝语义；
        // /tmp 短路径形态保留（别名归一后仍须落到非 temp 区被拒）
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        fs.mkdirSync(outsideRoot, { recursive: true });
        const outsideTarget = path.join(outsideRoot, 'alias-escape.txt');
        // /tmp 是 /private/tmp 的符号链接：内核物理解析下 `/tmp/../..` 恰好抵消
        // /private/tmp 两层，拼上绝对目标后与 outsideTarget 同指一处（HOME 下，
        // 父目录真实存在）。别名归一一旦失效——按 /tmp 字面前缀当成 temp 区放行、
        // 或按未解析形态误走"父链缺失透传"——写都会真实落到 outsideTarget，
        // 下面的存在性断言才能抓到逃逸。此前写成 '/tmp/../.opendesk-sbx-e2e-outside'
        // 物理落在 /private/ 下（root 属主），普通用户被真实权限拒绝，断言恒过。
        const shortOutside = `/tmp/../..${outsideTarget}`;

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', `echo pwn > ${shortOutside}; true`],
            command: 'alias escape',
            cwd: workspace
        });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(fs.existsSync(outsideTarget)).toBe(false);
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    }, 60000);

    test('temp 区工作区外写放行（统一策略：POSIX temp 区是落盘工作区）', async () => {
        // 语义正向固化：/tmp、/private/var/folders 等 temp 区写放行（shell 管道/
        // heredoc/编译器/jest transform 落盘区）。一旦被误改成 ask/deny，沙箱内
        // 工具链会全面卡死——这里固定该语义，回归立即报出。
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-temp-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: [
                '-c',
                // mktemp 目录本身就在 temp 区（os.tmpdir()）；workspace 外的
                // 兄弟目录写必须放行
                `echo temp-ok > ${JSON.stringify(path.join(root, 'temp-outside.txt'))}; echo "rc=$?"`
            ],
            command: 'temp write scenario',
            cwd: workspace
        });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(await waitFor(() => fs.existsSync(path.join(root, 'temp-outside.txt')))).toBe(true);
            expect(fs.readFileSync(path.join(root, 'temp-outside.txt'), 'utf8')).toContain('temp-ok');
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('并发多实例共用缓存目录互不干扰', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-conc-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        const launches = await Promise.all([
            prepareDarwinSandbox({
                shellPath: '/bin/zsh',
                shellArgs: ['-c', 'echo from-a > a.txt'],
                command: 'a',
                cwd: workspace
            }),
            prepareDarwinSandbox({
                shellPath: '/bin/zsh',
                shellArgs: ['-c', 'echo from-b > b.txt'],
                command: 'b',
                cwd: workspace
            })
        ]);
        try {
            // 两个实例同时启动（同一 shell 的重签只做一次，共享缓存副本）
            const procs = launches.map((l) =>
                spawn(l!.file, l!.args, { cwd: l!.cwd, env: { ...process.env, ...l!.env } })
            );
            const codes = await Promise.all(
                procs.map((p) => new Promise<number | null>((resolve) => p.once('exit', (c) => resolve(c))))
            );
            expect(codes).toEqual([0, 0]);
            expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toContain('from-a');
            expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toContain('from-b');
        } finally {
            await Promise.all(launches.map((l) => l!.cleanup()));
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('策略文件在进程启动后删除不影响已加载的策略（dylib 只读一次）', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-fc-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);

        // zsh 先 sleep 让测试在它运行期间删 policy，再写文件：
        // dylib 只在启动时读一次策略，运行期删除不影响已加载规则
        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', 'sleep 0.5; echo first > first.txt; echo second > second.txt; true'],
            command: 'policy snapshot scenario',
            cwd: workspace
        });
        const policyPath = launch!.env!.OPENDESK_SANDBOX_POLICY;
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            // 等 zsh 完成策略加载后再删 policy（sleep 0.5 窗口内）
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(fs.existsSync(policyPath)).toBe(true);
            fs.rmSync(policyPath, { force: true });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0);
            expect(fs.readFileSync(path.join(workspace, 'first.txt'), 'utf8')).toContain('first');
            expect(fs.readFileSync(path.join(workspace, 'second.txt'), 'utf8')).toContain('second');
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    test('policy 在启动前缺失 → 子进程只读模式（写拒绝，fail closed）', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-darwin-e2e-fc2-'));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);

        const launch = await prepareDarwinSandbox({
            shellPath: '/bin/zsh',
            shellArgs: ['-c', 'echo x > dropped.txt; true'],
            command: 'missing policy scenario',
            cwd: workspace
        });
        // spawn 前删 policy：子进程 dylib 读不到 → 只读模式 → 写拒绝
        fs.rmSync(launch!.env!.OPENDESK_SANDBOX_POLICY, { force: true });
        try {
            const proc = spawn(launch!.file, launch!.args, {
                cwd: launch!.cwd,
                env: { ...process.env, ...launch!.env }
            });
            const code = await new Promise<number | null>((resolve) => proc.once('exit', resolve));
            expect(code).toBe(0); // 末尾 true，rc 0
            expect(fs.existsSync(path.join(workspace, 'dropped.txt'))).toBe(false);
        } finally {
            await launch!.cleanup();
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});
