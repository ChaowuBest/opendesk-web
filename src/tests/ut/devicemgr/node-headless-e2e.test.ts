import { jest } from '@jest/globals';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import type { DeviceMgrApplication } from '../../../main/applications/devicemgr/app.js';
import { DeviceGateway } from '../../../main/applications/devicemgr/gateway.js';
import type { DeviceMgrConfig, NodeInvokeResult, NodeSession } from '../../../main/applications/devicemgr/common.js';
import { createNodeExecutionToolset } from '../../../main/applications/devicemgr/node-tools.js';

jest.setTimeout(30000);

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('failed to allocate test port')));
                return;
            }
            const port = address.port;
            server.close(() => resolve(port));
        });
    });
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number, message: () => string): Promise<T> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = fn();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message());
}

function parsePayload(result: NodeInvokeResult): any {
    if (!result.ok) {
        throw new Error(`${result.error?.code ?? 'INVOKE_FAILED'}: ${result.error?.message ?? 'unknown error'}`);
    }
    if (typeof result.payloadJSON === 'string' && result.payloadJSON.trim()) {
        return JSON.parse(result.payloadJSON);
    }
    return result.payload;
}

function pythonExecutable(): string {
    for (const candidate of ['python3', 'python']) {
        const result = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
        if (result.status === 0) {
            return result.stdout.trim();
        }
    }
    throw new Error('failed to resolve python3 or python');
}

function serviceStartCommand(args: string[], pythonPath: string): string[] {
    const scriptPath = path.join(process.cwd(), 'docs/examples/node/node_headless.py');
    const result = spawnSync(
        pythonPath,
        [
            '-c',
            [
                'import importlib.util',
                'import json',
                `spec = importlib.util.spec_from_file_location("node_headless", ${JSON.stringify(scriptPath)})`,
                'module = importlib.util.module_from_spec(spec)',
                'spec.loader.exec_module(module)',
                `args = module.parse_args(${JSON.stringify(['install', ...args])})`,
                'print(json.dumps(module.service_start_command(args)))',
                ''
            ].join('\n')
        ],
        { cwd: process.cwd(), encoding: 'utf8' }
    );
    if (result.status !== 0) {
        throw new Error(
            `failed to generate service start command:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        );
    }
    return JSON.parse(result.stdout) as string[];
}

async function stopProcess(process: ChildProcessWithoutNullStreams | null): Promise<void> {
    if (!process || process.exitCode !== null || process.signalCode !== null) return;
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            process.kill('SIGKILL');
            resolve();
        }, 2000);
        process.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        process.kill();
    });
}

describe('headless node gateway integration', () => {
    let dataDir: string;
    let workspaceDir: string;
    let gateway: DeviceGateway | null = null;
    let nodeProcess: ChildProcessWithoutNullStreams | null = null;
    let stdout = '';
    let stderr = '';
    let nextNodeIndex = 0;
    let pythonPath = '';

    beforeAll(() => {
        pythonPath = pythonExecutable();
    });

    beforeEach(() => {
        dataDir = makeTempDir('opendesk-gateway-e2e-');
        workspaceDir = makeTempDir('opendesk-node-workspace-');
        stdout = '';
        stderr = '';
    });

    afterEach(async () => {
        await stopProcess(nodeProcess);
        nodeProcess = null;
        if (gateway) {
            await gateway.stop();
            gateway = null;
        }
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    });

    async function startGatewayAndNode(): Promise<{ nodeId: string; node: NodeSession }> {
        const nodeId = `opendesk-headless-e2e-${++nextNodeIndex}`;
        const port = await getFreePort();
        const config: DeviceMgrConfig = {
            enabled: true,
            host: '127.0.0.1',
            port,
            autoApproveLocal: true
        };
        gateway = new DeviceGateway(dataDir, config);
        await gateway.start();

        const scriptPath = path.join(process.cwd(), 'docs/examples/node/node_headless.py');
        nodeProcess = spawn(
            pythonPath,
            [
                '-u',
                scriptPath,
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
                '--node-id',
                nodeId,
                '--cwd',
                workspaceDir
            ],
            {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        nodeProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        nodeProcess.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        const node = await waitFor(
            () => gateway?.getNodeRegistry().get(nodeId),
            5000,
            () => `headless node did not connect\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
        return { nodeId, node };
    }

    async function invokeNode(nodeId: string, command: string, params: Record<string, unknown> = {}): Promise<any> {
        if (!gateway) throw new Error('gateway not started');
        return parsePayload(
            await gateway.getNodeRegistry().invoke({
                nodeId,
                command,
                params,
                timeoutMs: 5000
            })
        );
    }

    async function invokeNodeRaw(
        nodeId: string,
        command: string,
        params: Record<string, unknown> = {}
    ): Promise<NodeInvokeResult> {
        if (!gateway) throw new Error('gateway not started');
        return await gateway.getNodeRegistry().invoke({
            nodeId,
            command,
            params,
            timeoutMs: 5000
        });
    }

    function createTaskForNode(node: NodeSession): TaskState {
        const task = new TaskState(new TaskManagerState());
        task.workspace = '/opendesk/local-workspace';
        task.harnessContext.workspace = '/opendesk/local-workspace';
        task.harnessContext.executionHost = {
            type: 'node',
            nodeId: node.nodeId,
            nodeLabel: node.displayName || node.nodeId,
            capabilities: {
                nodeId: node.nodeId,
                displayName: node.displayName,
                platform: node.platform,
                workspace: node.workspace,
                commands: node.commands,
                shells: node.shells,
                defaultShell: node.defaultShell
            }
        };
        return task;
    }

    function createToolApp(): DeviceMgrApplication {
        return {
            getGateway: () => gateway
        } as unknown as DeviceMgrApplication;
    }

    test('registers capabilities and runs shell commands on the connected node', async () => {
        const { nodeId, node } = await startGatewayAndNode();
        expect(node.commands).toEqual(
            expect.arrayContaining([
                'system.run',
                'fs.readText',
                'fs.writeText',
                'fs.editText',
                'fs.searchReplace',
                'fs.glob',
                'fs.grep'
            ])
        );
        expect(node.shells.length).toBeGreaterThan(0);
        expect(fs.realpathSync(node.workspace)).toBe(fs.realpathSync(workspaceDir));
        await waitFor(
            () => (stdout.includes('connected') ? true : null),
            3000,
            () => `headless node connected but did not report connected\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );

        const defaultCwdResult = await invokeNode(nodeId, 'system.run', {
            shell: 'auto',
            command: `${pythonPath} -c "import os; print(os.getcwd())"`
        });
        expect(defaultCwdResult.success).toBe(true);
        expect(fs.realpathSync(defaultCwdResult.stdout.trim())).toBe(fs.realpathSync(workspaceDir));

        const shellResult = await invokeNode(nodeId, 'system.run', {
            shell: 'auto',
            command: 'echo opendesk-node-e2e',
            cwd: workspaceDir
        });
        expect(shellResult.success).toBe(true);
        expect(shellResult.stdout).toContain('opendesk-node-e2e');

        const failedShell = await invokeNode(nodeId, 'system.run', {
            shell: 'auto',
            command: `${pythonPath} -c "import sys; sys.exit(7)"`,
            cwd: workspaceDir
        });
        expect(failedShell.success).toBe(false);
        expect(failedShell.exitCode).not.toBe(0);
    });

    test('generated service start command connects to the gateway as a headless node', async () => {
        const nodeId = `opendesk-headless-e2e-${++nextNodeIndex}`;
        const port = await getFreePort();
        const config: DeviceMgrConfig = {
            enabled: true,
            host: '127.0.0.1',
            port,
            autoApproveLocal: true
        };
        gateway = new DeviceGateway(dataDir, config);
        await gateway.start();

        const command = serviceStartCommand(
            [
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
                '--node-id',
                nodeId,
                '--name',
                'Generated Service Node',
                '--cwd',
                workspaceDir,
                '--retry-interval',
                '0.2',
                '--max-retry-interval',
                '0.2',
                '--python',
                pythonPath
            ],
            pythonPath
        );
        nodeProcess = spawn(command[0], command.slice(1), {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        nodeProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        nodeProcess.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        const node = await waitFor(
            () => gateway?.getNodeRegistry().get(nodeId),
            5000,
            () => `service start command did not connect\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
        expect(node.displayName).toBe('Generated Service Node');
        expect(fs.realpathSync(node.workspace)).toBe(fs.realpathSync(workspaceDir));
    });

    test('retries gateway connection until the gateway becomes available', async () => {
        const nodeId = `opendesk-headless-e2e-${++nextNodeIndex}`;
        const port = await getFreePort();
        const scriptPath = path.join(process.cwd(), 'docs/examples/node/node_headless.py');
        nodeProcess = spawn(
            pythonPath,
            [
                '-u',
                scriptPath,
                'start',
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
                '--node-id',
                nodeId,
                '--cwd',
                workspaceDir,
                '--retry-interval',
                '0.2',
                '--max-retry-interval',
                '0.2'
            ],
            {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        nodeProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        nodeProcess.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        await waitFor(
            () => (stderr.includes('retrying') ? true : null),
            3000,
            () => `headless node did not retry before gateway start\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );

        const config: DeviceMgrConfig = {
            enabled: true,
            host: '127.0.0.1',
            port,
            autoApproveLocal: true
        };
        gateway = new DeviceGateway(dataDir, config);
        await gateway.start();

        const node = await waitFor(
            () => gateway?.getNodeRegistry().get(nodeId),
            7000,
            () => `headless node did not connect after gateway start\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
        expect(node.nodeId).toBe(nodeId);
        await waitFor(
            () => (stdout.includes('connected') ? true : null),
            3000,
            () => `headless node connected but did not report connected\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
    });

    test('reconnects after an established gateway connection is lost', async () => {
        const nodeId = `opendesk-headless-e2e-${++nextNodeIndex}`;
        const port = await getFreePort();
        const config: DeviceMgrConfig = {
            enabled: true,
            host: '127.0.0.1',
            port,
            autoApproveLocal: true
        };
        gateway = new DeviceGateway(dataDir, config);
        await gateway.start();

        const scriptPath = path.join(process.cwd(), 'docs/examples/node/node_headless.py');
        nodeProcess = spawn(
            pythonPath,
            [
                '-u',
                scriptPath,
                'start',
                '--host',
                '127.0.0.1',
                '--port',
                String(port),
                '--node-id',
                nodeId,
                '--cwd',
                workspaceDir,
                '--retry-interval',
                '0.2',
                '--max-retry-interval',
                '0.2'
            ],
            {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        nodeProcess.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        nodeProcess.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        await waitFor(
            () => gateway?.getNodeRegistry().get(nodeId),
            5000,
            () => `headless node did not connect before gateway stop\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );

        await gateway.stop();
        gateway = null;

        await waitFor(
            () => (stderr.includes('retrying') ? true : null),
            5000,
            () => `headless node did not retry after gateway stop\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );

        gateway = new DeviceGateway(dataDir, config);
        await gateway.start();

        const node = await waitFor(
            () => gateway?.getNodeRegistry().get(nodeId),
            7000,
            () => `headless node did not reconnect after gateway restart\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
        expect(node.nodeId).toBe(nodeId);
        await waitFor(
            () => ((stdout.match(/connected/g) ?? []).length >= 2 ? true : null),
            3000,
            () => `headless node reconnected but did not report connected twice\nstdout:\n${stdout}\nstderr:\n${stderr}`
        );
    });

    test('writes, appends, and reads a line range from node-local files', async () => {
        const { nodeId } = await startGatewayAndNode();

        const writeResult = await invokeNode(nodeId, 'fs.writeText', {
            path: 'sample.txt',
            content: 'alpha\nbeta'
        });
        expect(writeResult).toContain('成功');
        const appendResult = await invokeNode(nodeId, 'fs.writeText', {
            path: 'sample.txt',
            content: 'gamma',
            mode: 'append'
        });
        expect(appendResult).toContain('成功');
        expect(fs.readFileSync(path.join(workspaceDir, 'sample.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
            'alpha\nbeta\ngamma\n'
        );

        const readResult = await invokeNode(nodeId, 'fs.readText', {
            path: 'sample.txt',
            offset: 2,
            limit: 2
        });
        expect(readResult.type).toBe('text');
        expect(readResult.file.content).toContain('beta');
        expect(readResult.file.content).toContain('gamma');
        expect(readResult.file.content).not.toContain('alpha');
        expect(readResult.file.startLine).toBe(2);
        expect(readResult.file.numLines).toBe(2);
    });

    test('edits files and applies single searchReplace operations on the node', async () => {
        const { nodeId } = await startGatewayAndNode();

        await invokeNode(nodeId, 'fs.writeText', {
            path: 'edit.txt',
            content: 'needle one\nneedle two\nstable'
        });
        const editResult = await invokeNode(nodeId, 'fs.editText', {
            filePath: 'edit.txt',
            oldString: 'needle',
            newString: 'thread',
            expectedReplacements: 2
        });
        expect(editResult).toContain('成功替换 2 处');

        const replaceResult = await invokeNode(nodeId, 'fs.searchReplace', {
            filePath: 'edit.txt',
            oldString: 'thread',
            newString: 'fiber'
        });
        expect(replaceResult).toContain('替换完成');

        const content = fs.readFileSync(path.join(workspaceDir, 'edit.txt'), 'utf8');
        expect(content).toContain('fiber one');
        expect(content).toContain('thread two');
        expect(content).toContain('stable');
    });

    test('finds workspace files with glob and grep commands on the node', async () => {
        const { nodeId } = await startGatewayAndNode();

        await invokeNode(nodeId, 'fs.writeText', {
            path: 'src/a.log',
            content: 'Target Alpha\nother'
        });
        await invokeNode(nodeId, 'fs.writeText', {
            path: 'src/nested/b.txt',
            content: 'target beta'
        });
        await invokeNode(nodeId, 'fs.writeText', {
            path: 'src/nested/c.md',
            content: 'no match'
        });

        const globResult = await invokeNode(nodeId, 'fs.glob', {
            path: '.',
            pattern: '*.txt',
            maxResults: 10
        });
        expect(globResult).toContain('找到 1 个文件');
        expect(globResult).toContain(path.join('src', 'nested', 'b.txt'));
        expect(globResult).not.toContain('a.log');

        const grepResult = await invokeNode(nodeId, 'fs.grep', {
            path: '.',
            pattern: 'target',
            filePattern: '**/*',
            ignoreCase: true,
            maxResults: 10
        });
        expect(grepResult).toContain('找到 2 处匹配');
        expect(grepResult).toContain('Target Alpha');
        expect(grepResult).toContain('target beta');
    });

    test('returns explicit errors for unsupported or invalid node commands', async () => {
        const { nodeId } = await startGatewayAndNode();

        const unsupported = await invokeNodeRaw(nodeId, 'fs.notSupported');
        expect(unsupported.ok).toBe(false);
        expect(unsupported.error?.code).toBe('NODE_COMMAND_FAILED');
        expect(unsupported.error?.message).toContain('command not supported');

        const missingFile = await invokeNodeRaw(nodeId, 'fs.readText', {
            path: 'missing.txt'
        });
        expect(missingFile.ok).toBe(false);
        expect(missingFile.error?.code).toBe('NODE_COMMAND_FAILED');
        expect(missingFile.error?.message).toContain('missing.txt');
    });

    test('runs shell and file operations through devicemgr node tools against the headless node', async () => {
        const { node } = await startGatewayAndNode();
        const task = createTaskForNode(node);
        const toolset = createNodeExecutionToolset(createToolApp());

        const shellResult = await toolset.callTool(
            'executeNodeShell',
            {
                command: 'echo opendesk-node-tool',
                shell: 'auto',
                timeout: 5000
            },
            task
        );
        expect(shellResult.status).toBe('success');
        expect(shellResult.result).toContain('opendesk-node-tool');

        const writeResult = await toolset.callTool(
            'writeNodeFile',
            {
                path: 'tools/api.txt',
                content: 'tool write alpha'
            },
            task
        );
        expect(writeResult.status).toBe('success');
        expect(writeResult.result).toContain('成功');
        expect(fs.readFileSync(path.join(workspaceDir, 'tools/api.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
            'tool write alpha\n'
        );

        const readResult = await toolset.callTool(
            'readNodeFile',
            {
                path: 'tools/api.txt',
                offset: 1,
                limit: 1
            },
            task
        );
        expect(readResult.status).toBe('success');
        expect(readResult.result).toContain('tool write alpha');
        const expectedFilePath = JSON.stringify(path.join(workspaceDir, 'tools/api.txt')).slice(1, -1);
        expect(readResult.result).toContain(expectedFilePath);
    });
});
