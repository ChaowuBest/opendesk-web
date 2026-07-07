#!/usr/bin/env node
/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixtureSourceDir = path.join(repoRoot, 'src/tests/resources/channel-plugins/opendesk-channel-fixture');
const defaultCli = 'dist/cli/opendesk-debug';
const defaultOutput = path.join(
    repoRoot,
    'docs/reports/pi_tui_migration_inventory/20260706/channel_fixture_e2e_post_migration.json'
);
const scriptBin = '/usr/bin/script';
const pluginPackageName = '@opendesk-test/channel-fixture';
const pluginId = 'opendesk-channel-fixture';
const channelId = 'opendesk-test-channel';
const channelLabel = 'OpenDesk Fixture Channel';
const accountId = 'fixture-account';
const fatalPatterns = [
    /OpenDesk FATAL/i,
    /uncaughtException/i,
    /unhandledRejection/i,
    /TypeError:/i,
    /ReferenceError:/i,
    /SyntaxError:/i,
    /ERR_MODULE_NOT_FOUND/i,
    /LLM Request Auto Retry/i,
    /Connection error/i
];

function parseArgs(argv) {
    const args = {
        cli: defaultCli,
        output: defaultOutput,
        keepTemp: false
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cli' && argv[i + 1]) {
            args.cli = argv[++i];
        } else if (arg.startsWith('--cli=')) {
            args.cli = arg.slice('--cli='.length);
        } else if (arg === '--output' && argv[i + 1]) {
            args.output = path.resolve(argv[++i]);
        } else if (arg.startsWith('--output=')) {
            args.output = path.resolve(arg.slice('--output='.length));
        } else if (arg === '--keep-temp') {
            args.keepTemp = true;
        }
    }
    return args;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function keyBytes(key) {
    switch (key) {
        case 'enter':
            return '\r';
        case 'escape':
            return '\x1b';
        default:
            throw new Error(`unknown key: ${key}`);
    }
}

function bytesToPrintfEscapes(value, encoding = 'binary') {
    return Array.from(Buffer.from(value, encoding))
        .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
        .join('');
}

function inputPipelineScript(steps) {
    const commands = [];
    for (const step of steps) {
        if (step.waitMs) {
            commands.push(`sleep ${(step.waitMs / 1000).toFixed(3)}`);
        }
        if (step.text) {
            commands.push(`printf '%b' ${shellQuote(bytesToPrintfEscapes(step.text, 'utf8'))}`);
        }
        if (step.key) {
            commands.push(`printf '%b' ${shellQuote(bytesToPrintfEscapes(keyBytes(step.key), 'binary'))}`);
        }
    }
    return `{ ${commands.join('; ')}; }`;
}

async function writeTempSetting(configDir) {
    await mkdir(path.join(configDir, 'apps', 'filemgr'), { recursive: true });
    await writeFile(path.join(configDir, 'apps', 'filemgr', 'scan.lock'), '');
    const setting = {
        locale: 'en-US',
        default_model: 'pi-tui-channel-fixture',
        providers: [
            {
                name: 'pi-tui-channel-fixture-provider',
                provider_type: 'openai',
                base_url: 'http://127.0.0.1:9/v1',
                api_key: 'pi-tui-channel-fixture',
                enabled: true
            }
        ],
        models: [
            {
                alias: 'pi-tui-channel-fixture',
                provider_name: 'pi-tui-channel-fixture-provider',
                model_name: 'pi-tui-channel-fixture',
                model_type: 'chat',
                context_length: 8192
            }
        ],
        cli_config: {
            shortcuts: {
                switch_mode: 'ctrl+k',
                switch_model: 'f2',
                endline: 'ctrl+j',
                show_help: 'ctrl+h',
                clear_input: 'ctrl+c',
                list_tasks: 'ctrl+l'
            },
            use_isolated_python: false,
            inherit_venv: false
        },
        debug: {
            developer_mode: false,
            experimental_feature: false,
            log_raw_llm_request: false
        }
    };
    await writeFile(path.join(configDir, 'setting.json'), JSON.stringify(setting, null, 4) + '\n');
}

async function installFixture(configDir) {
    const extensionsDir = path.join(configDir, 'extensions');
    const packageDir = path.join(extensionsDir, 'node_modules', '@opendesk-test', 'channel-fixture');
    await mkdir(path.dirname(packageDir), { recursive: true });
    await cp(fixtureSourceDir, packageDir, { recursive: true });
    const installRecord = {
        id: pluginId,
        npmSpec: pluginPackageName,
        installedAt: new Date().toISOString(),
        enabled: true,
        source: 'local',
        path: packageDir
    };
    await writeFile(path.join(extensionsDir, 'plugins.json'), JSON.stringify([installRecord], null, 4) + '\n');
    return { extensionsDir, packageDir, installRecord };
}

async function prepareTempEnvironment() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-channel-fixture-'));
    const workspace = path.join(tempRoot, 'workspace');
    const configDir = path.join(tempRoot, 'config');
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeTempSetting(configDir);
    const fixture = await installFixture(configDir);
    return { tempRoot, workspace, configDir, fixture };
}

async function runTuiFixture({ cliPath, workspace, configDir, logFile }) {
    const commandSteps = (command) => [
        { key: 'escape' },
        { waitMs: 400 },
        { text: command },
        { key: 'enter' },
        { waitMs: 1_700 },
        { key: 'escape' },
        { waitMs: 500 }
    ];
    const input = [
        { waitMs: 3_000 },
        ...commandSteps('/channels list'),
        ...commandSteps('/channels status'),
        ...commandSteps('/plugins list'),
        ...commandSteps(`/plugins disable ${pluginId}`),
        ...commandSteps(`/plugins enable ${pluginId}`),
        ...commandSteps('/channels status'),
        { text: '/quit' },
        { key: 'enter' },
        { waitMs: 700 },
        { key: 'enter' }
    ];
    const command = [
        'stty cols 120 rows 30 2>/dev/null || true',
        `exec ${shellQuote(cliPath)} --workspace ${shellQuote(workspace)} --config-directory ${shellQuote(configDir)} --language en-US --render-interval 20`
    ].join('; ');
    const scriptCommand = [
        inputPipelineScript(input),
        `${shellQuote(scriptBin)} -q ${shellQuote(logFile)} /bin/bash -c ${shellQuote(command)}`
    ].join(' | ');

    const child = spawn('/bin/bash', ['-c', scriptCommand], {
        cwd: repoRoot,
        env: {
            ...process.env,
            COLUMNS: '120',
            LINES: '30',
            TERM: process.env.TERM || 'xterm-256color',
            NO_COLOR: ''
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    const exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }, 35_000);

    const exit = await exitPromise;
    clearTimeout(timer);

    return {
        logFile,
        stdout,
        stderr,
        transcript: existsSync(logFile) ? readFileSync(logFile, 'utf8') : `${stdout}\n${stderr}`,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut
    };
}

function validateRun(run) {
    const text = `${run.transcript}\n${run.stdout}\n${run.stderr}`;
    const problems = [];
    if (run.timedOut) {
        problems.push('timed out');
    }
    if (run.exitCode !== 0) {
        problems.push(`exit code ${run.exitCode}`);
    }
    for (const pattern of fatalPatterns) {
        if (pattern.test(text)) {
            problems.push(`matched fatal pattern ${pattern}`);
        }
    }
    for (const expected of [channelId, channelLabel, accountId]) {
        if (!text.includes(expected)) {
            problems.push(`missing expected output ${JSON.stringify(expected)}`);
        }
    }
    return problems;
}

async function main() {
    const args = parseArgs(process.argv);
    const cliPath = path.resolve(repoRoot, args.cli);
    assert(existsSync(scriptBin), `missing PTY helper ${scriptBin}`);
    assert(existsSync(cliPath), `missing built CLI ${cliPath}; run npm run build-cli first`);
    assert(existsSync(fixtureSourceDir), `missing fixture source ${fixtureSourceDir}`);

    const env = await prepareTempEnvironment();
    const evidenceDir = path.join(path.dirname(args.output), 'channel_fixture_evidence', 'post_migration');
    await mkdir(evidenceDir, { recursive: true });
    const logFile = path.join(evidenceDir, 'channel-fixture-tui.ansi.txt');

    try {
        const run = await runTuiFixture({
            cliPath,
            workspace: env.workspace,
            configDir: env.configDir,
            logFile
        });
        const failures = validateRun(run);
        const record = {
            schemaVersion: 1,
            phase: 'post_migration',
            generatedAt: new Date().toISOString(),
            purpose:
                'Validate Channel Manager plugin list/status/enable/disable TUI flows with a no-network local fixture plugin.',
            fixture: {
                pluginId,
                packageName: pluginPackageName,
                channelId,
                accountId,
                source: 'src/tests/resources/channel-plugins/opendesk-channel-fixture',
                tempInstallRecordShape: {
                    id: pluginId,
                    npmSpec: pluginPackageName,
                    enabled: true,
                    source: 'local'
                }
            },
            environment: `${os.type()} ${os.release()}, node ${process.version}, script PTY`,
            cli: path.relative(repoRoot, cliPath),
            result: {
                status: failures.length === 0 ? 'passed' : 'failed',
                evidence: path.relative(repoRoot, logFile),
                exitCode: run.exitCode,
                signal: run.signal,
                timedOut: run.timedOut,
                failures,
                stdoutPreview: run.stdout.slice(0, 500),
                stderrPreview: run.stderr.slice(0, 500),
                transcriptPreview: run.transcript.slice(0, 1000)
            }
        };
        await mkdir(path.dirname(args.output), { recursive: true });
        await writeFile(args.output, JSON.stringify(record, null, 4) + '\n');
        assert(failures.length === 0, `channel fixture E2E failed: ${failures.join(', ')}`);
        console.log(`channel fixture E2E passed: ${args.output}`);
    } finally {
        if (args.keepTemp) {
            console.log(`kept temp environment: ${env.tempRoot}`);
        } else {
            await rm(env.tempRoot, { recursive: true, force: true });
        }
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
