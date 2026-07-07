#!/usr/bin/env node
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioPath = path.join(repoRoot, 'src/tests/pi-tui-migration/pl-acceptance-scenarios.json');
const reportDir = path.join(repoRoot, 'docs/reports/pi_tui_migration_inventory/20260706');
const scriptBin = '/usr/bin/script';
const realEnvPath = '/tmp/opendesk-pl-real-model.env';
const fatalPatterns = [
    /OpenDesk FATAL/i,
    /uncaughtException/i,
    /unhandledRejection/i,
    /TypeError:/i,
    /ReferenceError:/i,
    /SyntaxError:/i,
    /ERR_MODULE_NOT_FOUND/i,
    /Stream Completion Failed/i,
    /LLM Request Auto Retry/i,
    /Connection error/i
];

function parseArgs(argv) {
    const args = {
        cli: 'dist/cli/opendesk-debug',
        mode: 'fake',
        output: undefined,
        list: false,
        verifyOnly: false
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--list') {
            args.list = true;
        } else if (arg === '--verify-only') {
            args.verifyOnly = true;
        } else if (arg === '--mode' && argv[i + 1]) {
            args.mode = argv[++i];
        } else if (arg.startsWith('--mode=')) {
            args.mode = arg.slice('--mode='.length);
        } else if (arg === '--cli' && argv[i + 1]) {
            args.cli = argv[++i];
        } else if (arg.startsWith('--cli=')) {
            args.cli = arg.slice('--cli='.length);
        } else if (arg === '--output' && argv[i + 1]) {
            args.output = path.resolve(argv[++i]);
        } else if (arg.startsWith('--output=')) {
            args.output = path.resolve(arg.slice('--output='.length));
        }
    }
    return args;
}

function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
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
        case 'tab':
            return '\t';
        case 'shift-tab':
            return '\x1b[Z';
        case 'backspace':
            return '\x7f';
        case 'ctrl-c':
            return '\x03';
        case 'ctrl-j':
            return '\n';
        case 'ctrl-h':
            return '\x08';
        case 'ctrl-l':
            return '\x0c';
        case 'ctrl-k':
            return '\x0b';
        case 'ctrl-backspace':
            return '\x17';
        case 'left':
            return '\x1b[D';
        case 'right':
            return '\x1b[C';
        case 'up':
            return '\x1b[A';
        case 'down':
            return '\x1b[B';
        case 'page-up':
            return '\x1b[5~';
        case 'page-down':
            return '\x1b[6~';
        case 'shift-enter':
            return '\x1b[13;2u';
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
    for (const step of steps ?? []) {
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

function parseEnvFile(file) {
    if (!existsSync(file)) return {};
    const result = {};
    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}

async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileText(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

async function findNodePtyForConfig(configDir) {
    const { stdout: psOutput } = await execFileText('/bin/ps', ['-axo', 'pid=,command=', '-ww']);
    const candidates = psOutput
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes(configDir) && line.includes('node') && line.includes('--config-directory'));
    if (candidates.length === 0) {
        throw new Error(`could not find running OpenDesk node process for ${configDir}`);
    }

    const pid = candidates[0].match(/^(\d+)/)?.[1];
    if (!pid) {
        throw new Error(`could not parse OpenDesk node pid from: ${candidates[0]}`);
    }

    const { stdout: lsofOutput } = await execFileText('/usr/sbin/lsof', ['-a', '-p', pid, '-d', '1']);
    const tty = lsofOutput.match(/(\/dev\/tty\S+)/)?.[1];
    if (!tty) {
        throw new Error(`could not find stdout PTY for OpenDesk node pid ${pid}`);
    }

    return { pid, tty };
}

async function readTtySize(tty) {
    const { stdout } = await execFileText('/bin/stty', ['-f', tty, 'size']);
    const [rows, cols] = stdout.trim().split(/\s+/).map(Number);
    return { cols, rows };
}

async function setTtySize(tty, size) {
    await execFileText('/bin/stty', ['-f', tty, 'cols', String(size.cols), 'rows', String(size.rows)]);
}

function createFakeModelServer() {
    const state = {
        requests: [],
        chatCompletionCount: 0
    };
    const chunks = [
        '# PL Fake Model Complex Task\n\n',
        '这是一个用于 pi-tui 迁移验收的复杂任务输出，包含中文、English text, and streamed markdown.\n\n',
        '- item one: resize should keep this list readable\n',
        '- item two: autocomplete and shortcuts remain independent\n\n',
        '| module | assertion |\n| --- | --- |\n| TUI | status bar visible |\n| resize | no crash |\n\n',
        '```ts\nconst migrationGate = "pl-acceptance";\nconsole.log(migrationGate);\n```\n\n',
        'Final marker: PL_FAKE_COMPLEX_TASK_DONE.\n'
    ];

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/v1/models') {
            res.setHeader('content-type', 'application/json');
            res.end(
                JSON.stringify({
                    object: 'list',
                    data: [{ id: 'pl-fake-model', object: 'model', created: 0, owned_by: 'opendesk-test' }]
                })
            );
            return;
        }
        if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
            res.statusCode = 404;
            res.end('not found');
            return;
        }

        let body = '';
        for await (const chunk of req) {
            body += chunk.toString('utf8');
        }
        const request = body ? JSON.parse(body) : {};
        state.requests.push({
            model: request.model,
            stream: request.stream === true,
            messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
            hasTools: Array.isArray(request.tools)
        });
        state.chatCompletionCount += 1;

        if (request.stream === true) {
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive'
            });
            const created = Math.floor(Date.now() / 1000);
            res.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-pl-fake',
                    object: 'chat.completion.chunk',
                    created,
                    model: 'pl-fake-model',
                    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
                })}\n\n`
            );
            for (const content of chunks) {
                await delay(900);
                res.write(
                    `data: ${JSON.stringify({
                        id: 'chatcmpl-pl-fake',
                        object: 'chat.completion.chunk',
                        created,
                        model: 'pl-fake-model',
                        choices: [{ index: 0, delta: { content }, finish_reason: null }]
                    })}\n\n`
                );
            }
            await delay(80);
            res.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-pl-fake',
                    object: 'chat.completion.chunk',
                    created,
                    model: 'pl-fake-model',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 200, completion_tokens: 90, total_tokens: 290 }
                })}\n\n`
            );
            res.end('data: [DONE]\n\n');
            return;
        }

        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                id: 'chatcmpl-pl-fake',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'pl-fake-model',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: chunks.join('') },
                        finish_reason: 'stop'
                    }
                ],
                usage: { prompt_tokens: 200, completion_tokens: 90, total_tokens: 290 }
            })
        );
    });

    return {
        state,
        async start() {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert(address && typeof address === 'object', 'fake model server did not bind a TCP port');
            return `http://127.0.0.1:${address.port}/v1`;
        },
        async stop() {
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

function modelConfigFor(mode, fakeBaseUrl) {
    if (mode === 'fake') {
        return {
            providerName: 'pl-fake-provider',
            modelAlias: 'pl-fake-model',
            modelName: 'pl-fake-model',
            baseUrl: fakeBaseUrl,
            apiKey: 'pl-fake-key'
        };
    }

    const fileEnv = parseEnvFile(realEnvPath);
    const env = { ...fileEnv, ...process.env };
    const baseUrl = env.OPENDESK_PL_MODEL_BASE_URL;
    const apiKey = env.OPENDESK_PL_MODEL_API_KEY;
    const modelName = env.OPENDESK_PL_MODEL_NAME;
    if (!baseUrl || !apiKey || !modelName) {
        return undefined;
    }
    return {
        providerName: 'pl-real-provider',
        modelAlias: 'pl-real-model',
        modelName,
        baseUrl,
        apiKey
    };
}

async function writeTempSetting(configDir, modelConfig) {
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(configDir, 'apps', 'filemgr'), { recursive: true });
    await mkdir(path.join(configDir, 'apps', 'skills', 'resources', 'pl-smoke-skill'), { recursive: true });
    await writeFile(path.join(configDir, 'apps', 'filemgr', 'scan.lock'), '');
    await writeFile(
        path.join(configDir, 'apps', 'skills', 'resources', 'pl-smoke-skill', 'SKILL.md'),
        [
            '---',
            'name: pl-smoke-skill',
            'description: Deterministic skill used only by the pi-tui PL acceptance autocomplete test.',
            'user-invocable: true',
            'disable-model-invocation: true',
            'argument-hint: "<topic>"',
            '---',
            '',
            'This skill is a local fixture for TUI autocomplete verification.'
        ].join('\n') + '\n'
    );

    const setting = {
        locale: 'en-US',
        default_model: modelConfig.modelAlias,
        providers: [
            {
                name: modelConfig.providerName,
                provider_type: 'openai',
                base_url: modelConfig.baseUrl,
                api_key: modelConfig.apiKey,
                enabled: true
            }
        ],
        models: [
            {
                alias: modelConfig.modelAlias,
                provider_name: modelConfig.providerName,
                model_name: modelConfig.modelName,
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
        },
        applications: {
            skillmgr: {
                external_paths: []
            }
        }
    };
    await writeFile(path.join(configDir, 'setting.json'), JSON.stringify(setting, null, 4));
}

async function runOnePty({ cliPath, scenario, modelConfig, size, mode, evidenceDir }) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `opendesk-pi-tui-pl-${mode}-`));
    const workspace = path.join(tempRoot, 'workspace');
    const configDir = path.join(tempRoot, 'config');
    const homeDir = path.join(tempRoot, 'home');
    const piDebugDir = path.join(homeDir, '.pi', 'agent');
    const piDebugLog = path.join(piDebugDir, 'pi-debug.log');
    await mkdir(workspace, { recursive: true });
    await mkdir(piDebugDir, { recursive: true });
    await writeTempSetting(configDir, modelConfig);

    const logFile = path.join(evidenceDir, `${scenario.id}-${size.cols}x${size.rows}.ansi.txt`);
    const commandArgs = [
        '--workspace',
        workspace,
        '--config-directory',
        configDir,
        '--language',
        'en-US',
        '--render-interval',
        '20',
        ...(scenario.automation.command ? ['-c', scenario.automation.command, '--task-name', scenario.id] : [])
    ];
    const command = [
        `stty cols ${size.cols} rows ${size.rows} 2>/dev/null || true`,
        `exec ${shellQuote(cliPath)} ${commandArgs.map(shellQuote).join(' ')}`
    ].join('; ');
    const scriptCommand = [
        inputPipelineScript(scenario.automation.input),
        `${shellQuote(scriptBin)} -q ${shellQuote(logFile)} /bin/bash -c ${shellQuote(command)}`
    ].join(' | ');

    const child = spawn('/bin/bash', ['-c', scriptCommand], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: homeDir,
            COLUMNS: String(size.cols),
            LINES: String(size.rows),
            ...(scenario.automation.resizeSteps?.length ? { PI_DEBUG_REDRAW: '1' } : {}),
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

    let exited = false;
    const exitPromise = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
            exited = true;
            resolve({ code, signal });
        });
    });

    const resizeObservations = [];
    const resizeErrors = [];
    if (scenario.automation.resizeSteps?.length) {
        try {
            await delay(500);
            const { pid, tty } = await findNodePtyForConfig(configDir);
            for (const step of scenario.automation.resizeSteps) {
                if (exited) {
                    resizeErrors.push(`process exited before resize ${step.cols}x${step.rows}`);
                    break;
                }
                await delay(step.waitMs ?? 0);
                await setTtySize(tty, step);
                await delay(step.settleMs ?? 250);
                resizeObservations.push({
                    pid,
                    tty,
                    requested: { cols: step.cols, rows: step.rows },
                    actual: await readTtySize(tty),
                    expectDebugPattern: step.expectDebugPattern
                });
            }
        } catch (err) {
            resizeErrors.push(err instanceof Error ? err.message : String(err));
        }
    }

    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }, scenario.automation.timeoutMs ?? 15_000);

    const exit = await exitPromise;
    clearTimeout(timer);

    const transcript = existsSync(logFile) ? readFileSync(logFile, 'utf8') : `${stdout}\n${stderr}`;
    const debugRedrawLog = existsSync(piDebugLog) ? readFileSync(piDebugLog, 'utf8') : '';
    await rm(tempRoot, { recursive: true, force: true });

    return {
        logFile,
        transcript,
        stdout,
        stderr,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut,
        resizeObservations,
        resizeErrors,
        debugRedrawLog
    };
}

function validateRun(run, scenario) {
    const text = `${run.transcript}\n${run.stdout}\n${run.stderr}`;
    const problems = [];
    const controlledTermination =
        scenario.automation.allowControlledTermination === true &&
        run.timedOut &&
        run.signal === 'SIGTERM' &&
        run.exitCode === null;
    if (run.timedOut && !controlledTermination) {
        problems.push('timed out');
    }
    if (run.exitCode !== 0 && !controlledTermination) {
        problems.push(`exit code ${run.exitCode}`);
    }
    for (const pattern of fatalPatterns) {
        if (pattern.test(text)) {
            problems.push(`matched fatal pattern ${pattern}`);
        }
    }
    for (const expected of scenario.automation.expect ?? []) {
        if (!text.includes(expected)) {
            problems.push(`missing expected output ${JSON.stringify(expected)}`);
        }
    }
    for (const rawPattern of scenario.automation.reject ?? []) {
        const pattern = new RegExp(rawPattern, 'i');
        if (pattern.test(text)) {
            problems.push(`matched rejected output ${rawPattern}`);
        }
    }
    if (scenario.automation.resizeSteps?.length) {
        if (run.resizeErrors.length > 0) {
            problems.push(`resize errors: ${run.resizeErrors.join('; ')}`);
        }
        for (const step of scenario.automation.resizeSteps) {
            const observation = run.resizeObservations.find(
                (item) =>
                    item.requested.cols === step.cols &&
                    item.requested.rows === step.rows &&
                    item.actual.cols === step.cols &&
                    item.actual.rows === step.rows
            );
            if (!observation) {
                problems.push(`missing resize observation ${step.cols}x${step.rows}`);
            }
            if (step.expectDebugPattern) {
                const pattern = new RegExp(step.expectDebugPattern);
                if (!pattern.test(run.debugRedrawLog)) {
                    problems.push(`missing resize redraw evidence ${step.expectDebugPattern}`);
                }
            }
        }
    }
    return problems;
}

async function executeScenarios({ scenarios, cliPath, mode, modelConfig, fakeState, evidenceDir }) {
    const results = [];
    for (const scenario of scenarios.scenarios) {
        if (scenario.modes && !scenario.modes.includes(mode)) {
            results.push({
                scenarioId: scenario.id,
                status: 'skipped',
                reason: `scenario mode filter excludes ${mode}`,
                executedAt: new Date().toISOString()
            });
            continue;
        }
        const size = scenario.automation.size ?? { cols: 120, rows: 30 };
        const fakeBefore = fakeState?.chatCompletionCount ?? 0;
        const run = await runOnePty({ cliPath, scenario, modelConfig, size, mode, evidenceDir });
        const problems = validateRun(run, scenario);
        if (scenario.requiresModelCompletion === true && fakeState && fakeState.chatCompletionCount <= fakeBefore) {
            problems.push('fake model did not receive a chat completion request');
        }
        results.push({
            scenarioId: scenario.id,
            status: problems.length === 0 ? 'passed' : 'failed',
            executedAt: new Date().toISOString(),
            environment: `${os.type()} ${os.release()}, node ${process.version}, script PTY, ${mode}`,
            evidence: path.relative(repoRoot, run.logFile),
            failures: problems,
            exitCode: run.exitCode,
            signal: run.signal,
            timedOut: run.timedOut,
            controlledTermination:
                scenario.automation.allowControlledTermination === true &&
                run.timedOut &&
                run.signal === 'SIGTERM' &&
                run.exitCode === null,
            resizeObservations: run.resizeObservations,
            resizeErrors: run.resizeErrors,
            fakeModelRequests: fakeState ? fakeState.chatCompletionCount - fakeBefore : undefined,
            debugRedrawPreview: run.debugRedrawLog.slice(0, 1_000),
            transcriptPreview: run.transcript.slice(0, 1_000),
            stdoutPreview: run.stdout.slice(0, 500),
            stderrPreview: run.stderr.slice(0, 500)
        });
    }
    return results;
}

function validateResults(scenarios, resultFile, mode) {
    assert(existsSync(resultFile), `missing PL acceptance result file: ${resultFile}`);
    const results = readJson(resultFile);
    assert(results.schemaVersion === 1, 'PL acceptance result schemaVersion must be 1');
    assert(results.mode === mode, `PL acceptance result mode must be ${mode}`);
    assert(Array.isArray(results.results), 'PL acceptance result file must contain results[]');
    if (results.status === 'skipped') {
        return results;
    }

    const resultById = new Map(results.results.map((result) => [result.scenarioId, result]));
    const missing = scenarios.scenarios
        .filter((scenario) => !scenario.modes || scenario.modes.includes(mode))
        .filter((scenario) => !resultById.has(scenario.id))
        .map((scenario) => scenario.id);
    assert(missing.length === 0, `missing PL acceptance results for scenarios: ${missing.join(', ')}`);

    const failed = [];
    for (const scenario of scenarios.scenarios) {
        if (scenario.modes && !scenario.modes.includes(mode)) continue;
        const result = resultById.get(scenario.id);
        if (result.status !== scenarios.requiredResultStatus) {
            failed.push(`${scenario.id}:${result.status ?? 'missing-status'}`);
        }
        assert(
            typeof result.evidence === 'string' && result.evidence.trim().length > 0,
            `${scenario.id} lacks evidence`
        );
        assert(
            typeof result.executedAt === 'string' && result.executedAt.trim().length > 0,
            `${scenario.id} lacks executedAt`
        );
    }
    assert(failed.length === 0, `PL acceptance scenarios not passed: ${failed.join(', ')}`);
    return results;
}

async function execute(mode, outputFile, cli) {
    assert(mode === 'fake' || mode === 'real', `unknown mode: ${mode}`);
    assert(existsSync(scriptBin), `missing PTY helper ${scriptBin}`);
    const cliPath = path.resolve(repoRoot, cli);
    assert(existsSync(cliPath), `missing built CLI ${cliPath}; run npm run build-cli first`);

    const scenarios = readJson(scenarioPath);
    const fakeServer = mode === 'fake' ? createFakeModelServer() : undefined;
    let fakeBaseUrl;
    try {
        if (fakeServer) {
            fakeBaseUrl = await fakeServer.start();
        }
        const modelConfig = modelConfigFor(mode, fakeBaseUrl);
        if (!modelConfig) {
            const skippedRecord = {
                schemaVersion: 1,
                mode,
                status: 'skipped',
                generatedAt: new Date().toISOString(),
                reason:
                    `missing ${realEnvPath} or OPENDESK_PL_MODEL_BASE_URL, ` +
                    'OPENDESK_PL_MODEL_API_KEY, OPENDESK_PL_MODEL_NAME environment variables',
                results: []
            };
            await mkdir(path.dirname(outputFile), { recursive: true });
            await writeFile(outputFile, JSON.stringify(skippedRecord, null, 4) + '\n');
            console.log(`PL real-model acceptance skipped: ${skippedRecord.reason}`);
            return outputFile;
        }

        const evidenceDir = path.join(path.dirname(outputFile), 'pl_acceptance_evidence', mode);
        await mkdir(evidenceDir, { recursive: true });
        const results = await executeScenarios({
            scenarios,
            cliPath,
            mode,
            modelConfig,
            fakeState: fakeServer?.state,
            evidenceDir
        });
        const record = {
            schemaVersion: 1,
            mode,
            status: 'completed',
            generatedAt: new Date().toISOString(),
            cli: path.relative(repoRoot, cliPath),
            resultStatusContract: scenarios.requiredResultStatus,
            fakeModelRequestSummary: fakeServer
                ? {
                      chatCompletionCount: fakeServer.state.chatCompletionCount,
                      requests: fakeServer.state.requests
                  }
                : undefined,
            results
        };
        await mkdir(path.dirname(outputFile), { recursive: true });
        await writeFile(outputFile, JSON.stringify(record, null, 4) + '\n');
        validateResults(scenarios, outputFile, mode);
        return outputFile;
    } finally {
        await fakeServer?.stop();
    }
}

const args = parseArgs(process.argv);
const scenarios = readJson(scenarioPath);
const defaultOutput =
    args.mode === 'real'
        ? path.join(reportDir, 'pl_acceptance_real_model.json')
        : path.join(reportDir, 'pl_acceptance_fake_model.json');
const outputFile = args.output || defaultOutput;

if (args.list) {
    for (const scenario of scenarios.scenarios) {
        console.log(`${scenario.id}\t${scenario.category}\t${scenario.modes?.join(',') ?? 'fake,real'}`);
    }
    process.exit(0);
}

try {
    if (args.verifyOnly) {
        validateResults(scenarios, outputFile, args.mode);
    } else {
        await execute(args.mode, outputFile, args.cli);
    }
    console.log(`PL ${args.mode} acceptance evidence ready: ${outputFile}`);
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
