#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioPath = path.join(repoRoot, 'src/tests/tui-regression/behavior-smoke-scenarios.json');
const scriptBin = '/usr/bin/script';
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
        cli: 'dist/cli/opendesk-debug',
        list: false,
        phase: 'compare',
        output: undefined,
        repeat: undefined,
        verifyOnly: false
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--list') {
            args.list = true;
        } else if (arg === '--verify-only') {
            args.verifyOnly = true;
        } else if (arg === '--phase' && argv[i + 1]) {
            args.phase = argv[++i];
        } else if (arg.startsWith('--phase=')) {
            args.phase = arg.slice('--phase='.length);
        } else if (arg === '--cli' && argv[i + 1]) {
            args.cli = argv[++i];
        } else if (arg.startsWith('--cli=')) {
            args.cli = arg.slice('--cli='.length);
        } else if (arg === '--output' && argv[i + 1]) {
            args.output = path.resolve(argv[++i]);
        } else if (arg.startsWith('--output=')) {
            args.output = path.resolve(arg.slice('--output='.length));
        } else if (arg === '--repeat' && argv[i + 1]) {
            args.repeat = Number(argv[++i]);
        } else if (arg.startsWith('--repeat=')) {
            args.repeat = Number(arg.slice('--repeat='.length));
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
        case 'ctrl-backspace':
            return '\x17';
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

function defaultAutomationForScenario(scenario) {
    const exitSequence = [{ waitMs: 400 }, { text: '/quit' }, { key: 'enter' }, { waitMs: 700 }, { key: 'enter' }];
    const common = {
        cols: 120,
        rows: 30,
        timeoutMs: 12_000,
        repeat: 1,
        expect: ['Current workspace'],
        reject: fatalPatterns.map((pattern) => pattern.source)
    };

    if (scenario.id === 'gate4-main-input-editor-flow') {
        return {
            ...common,
            input: [
                { waitMs: 900 },
                { text: 'baseline smoke' },
                { key: 'shift-enter' },
                { text: 'next line' },
                { key: 'ctrl-j' },
                { text: 'ctrl j line' },
                { key: 'backspace' },
                { key: 'ctrl-backspace' },
                { key: 'ctrl-h' },
                { waitMs: 700 },
                { key: 'escape' },
                ...exitSequence
            ]
        };
    }

    if (scenario.id === 'gate4-prompt-focus-queue-flow') {
        return {
            ...common,
            input: [
                { waitMs: 900 },
                { key: 'ctrl-h' },
                { waitMs: 700 },
                { key: 'escape' },
                { key: 'ctrl-l' },
                { waitMs: 700 },
                { key: 'down' },
                { key: 'up' },
                { key: 'page-down' },
                { key: 'page-up' },
                { key: 'escape' },
                ...exitSequence
            ]
        };
    }

    if (scenario.id === 'gate5-calendar-mailbox-flow') {
        return {
            ...common,
            input: [
                { waitMs: 900 },
                { text: '/dashboard' },
                { key: 'enter' },
                { waitMs: 700 },
                { key: 'escape' },
                ...exitSequence
            ]
        };
    }

    if (scenario.id === 'gate5-skill-channel-manager-flow') {
        return {
            ...common,
            input: [
                { waitMs: 900 },
                { text: '/skills' },
                { key: 'enter' },
                { waitMs: 700 },
                { key: 'down' },
                { key: 'up' },
                { key: 'escape' },
                ...exitSequence
            ]
        };
    }

    if (scenario.id === 'gate6-terminal-rendering-and-keyboard-flow') {
        return {
            ...common,
            allowControlledTermination: true,
            timeoutMs: 4_000,
            sizes: [
                { cols: 80, rows: 24 },
                { cols: 120, rows: 30 },
                { cols: 160, rows: 40 }
            ],
            resizeSteps: [
                {
                    waitMs: 1_200,
                    cols: 80,
                    rows: 20,
                    expectDebugPattern: 'terminal width changed .* -> 80'
                },
                {
                    waitMs: 1_200,
                    cols: 160,
                    rows: 40,
                    expectDebugPattern: 'terminal width changed .* -> 160'
                },
                {
                    waitMs: 1_200,
                    cols: 120,
                    rows: 30,
                    expectDebugPattern: 'terminal width changed .* -> 120'
                }
            ],
            input: [
                { waitMs: 900 },
                { key: 'ctrl-h' },
                { waitMs: 400 },
                { key: 'escape' },
                { text: '中文 smoke ```code``` \u001b[32mansi\u001b[0m' },
                { key: 'ctrl-j' },
                { waitMs: 1_000 }
            ]
        };
    }

    if (scenario.id === 'gate7-intermittent-crash-regressions') {
        return {
            ...common,
            repeat: 3,
            input: [
                { waitMs: 700 },
                { key: 'ctrl-h' },
                { waitMs: 300 },
                { key: 'escape' },
                { key: 'ctrl-l' },
                { waitMs: 300 },
                { key: 'escape' },
                ...exitSequence
            ]
        };
    }

    return { ...common, input: [{ waitMs: 900 }, ...exitSequence] };
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

async function writeTempSetting(configDir) {
    await mkdir(configDir, { recursive: true });
    await mkdir(path.join(configDir, 'apps', 'filemgr'), { recursive: true });
    await writeFile(path.join(configDir, 'apps', 'filemgr', 'scan.lock'), '');
    const setting = {
        locale: 'en-US',
        default_model: 'pi-tui-smoke',
        providers: [
            {
                name: 'pi-tui-smoke-provider',
                provider_type: 'openai',
                base_url: 'http://127.0.0.1:9/v1',
                api_key: 'pi-tui-smoke',
                enabled: true
            }
        ],
        models: [
            {
                alias: 'pi-tui-smoke',
                provider_name: 'pi-tui-smoke-provider',
                model_name: 'pi-tui-smoke',
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
    await writeFile(path.join(configDir, 'setting.json'), JSON.stringify(setting, null, 4));
}

async function runOnePty({ cliPath, scenario, automation, size, iteration, phase, evidenceDir }) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `opendesk-pi-tui-${phase}-`));
    const workspace = path.join(tempRoot, 'workspace');
    const configDir = path.join(tempRoot, 'config');
    const homeDir = path.join(tempRoot, 'home');
    const piDebugDir = path.join(homeDir, '.pi', 'agent');
    const piDebugLog = path.join(piDebugDir, 'pi-debug.log');
    await mkdir(workspace, { recursive: true });
    await mkdir(piDebugDir, { recursive: true });
    await writeTempSetting(configDir);

    const logFile = path.join(evidenceDir, `${scenario.id}-${size.cols}x${size.rows}-${iteration}.log`);
    const command = [
        `stty cols ${size.cols} rows ${size.rows} 2>/dev/null || true`,
        `exec ${shellQuote(cliPath)} --workspace ${shellQuote(workspace)} --config-directory ${shellQuote(configDir)} --language en-US --render-interval 20`
    ].join('; ');
    const scriptCommand = [
        inputPipelineScript(automation.input),
        `${shellQuote(scriptBin)} -q ${shellQuote(logFile)} /bin/bash -c ${shellQuote(command)}`
    ].join(' | ');

    const child = spawn('/bin/bash', ['-c', scriptCommand], {
        cwd: repoRoot,
        env: {
            ...process.env,
            HOME: homeDir,
            COLUMNS: String(size.cols),
            LINES: String(size.rows),
            ...(automation.resizeSteps?.length ? { PI_DEBUG_REDRAW: '1' } : {}),
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
    if (automation.resizeSteps?.length) {
        try {
            await delay(500);
            const { pid, tty } = await findNodePtyForConfig(configDir);
            for (const step of automation.resizeSteps) {
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
    }, automation.timeoutMs ?? 10_000);

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

function validateTranscript(run, automation) {
    const text = `${run.transcript}\n${run.stdout}\n${run.stderr}`;
    const problems = [];
    const controlledTermination =
        automation.allowControlledTermination === true &&
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
    for (const expected of automation.expect ?? []) {
        if (!text.includes(expected)) {
            problems.push(`missing expected output ${JSON.stringify(expected)}`);
        }
    }
    for (const rawPattern of automation.reject ?? []) {
        const pattern = new RegExp(rawPattern, 'i');
        if (pattern.test(text)) {
            problems.push(`matched rejected output ${rawPattern}`);
        }
    }
    if (automation.resizeSteps?.length) {
        if (run.resizeErrors.length > 0) {
            problems.push(`resize errors: ${run.resizeErrors.join('; ')}`);
        }
        for (const step of automation.resizeSteps) {
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

async function executeScenario({ cliPath, scenario, phase, evidenceDir, repeatOverride }) {
    const automation = scenario.automation ?? defaultAutomationForScenario(scenario);
    const sizes = automation.sizes ?? [{ cols: automation.cols ?? 120, rows: automation.rows ?? 30 }];
    const repeat = repeatOverride ?? automation.repeat ?? 1;
    const runs = [];
    const failures = [];

    for (const size of sizes) {
        for (let i = 1; i <= repeat; i++) {
            const run = await runOnePty({
                cliPath,
                scenario,
                automation,
                size,
                iteration: i,
                phase,
                evidenceDir
            });
            const problems = validateTranscript(run, automation);
            runs.push({
                size,
                iteration: i,
                logFile: path.relative(repoRoot, run.logFile),
                exitCode: run.exitCode,
                signal: run.signal,
                timedOut: run.timedOut,
                controlledTermination:
                    automation.allowControlledTermination === true &&
                    run.timedOut &&
                    run.signal === 'SIGTERM' &&
                    run.exitCode === null,
                resizeObservations: run.resizeObservations,
                resizeErrors: run.resizeErrors,
                debugRedrawPreview: run.debugRedrawLog.slice(0, 1_000),
                stdoutPreview: run.stdout.slice(0, 500),
                stderrPreview: run.stderr.slice(0, 500),
                transcriptPreview: run.transcript.slice(0, 500)
            });
            if (problems.length > 0) {
                failures.push({ size, iteration: i, problems });
            }
        }
    }

    return {
        scenarioId: scenario.id,
        status: failures.length === 0 ? 'passed' : 'failed',
        executedAt: new Date().toISOString(),
        environment: `${os.type()} ${os.release()}, node ${process.version}, script PTY, ${phase}`,
        evidence: runs.map((run) => run.logFile).join(', '),
        runs,
        failures
    };
}

function validateResults(scenarios, resultFile, phase) {
    assert(existsSync(resultFile), `missing behavior result file: ${resultFile}`);
    const results = readJson(resultFile);
    assert(results.schemaVersion === 1, 'behavior result schemaVersion must be 1');
    assert(results.phase === phase, `behavior result phase must be ${phase}`);
    assert(Array.isArray(results.results), 'behavior result file must contain results[]');

    const resultById = new Map(results.results.map((result) => [result.scenarioId, result]));
    const missing = scenarios.scenarios
        .filter((scenario) => !resultById.has(scenario.id))
        .map((scenario) => scenario.id);
    assert(missing.length === 0, `missing behavior results for scenarios: ${missing.join(', ')}`);

    const failed = [];
    for (const scenario of scenarios.scenarios) {
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
        assert(
            typeof result.environment === 'string' && result.environment.trim().length > 0,
            `${scenario.id} lacks environment`
        );
    }
    assert(failed.length === 0, `behavior scenarios not passed: ${failed.join(', ')}`);
    return results;
}

function compareResults(scenarios, baselineFile, postFile) {
    const baseline = validateResults(scenarios, baselineFile, 'baseline_current');
    const post = validateResults(scenarios, postFile, 'post_migration');
    const baselineById = new Map(baseline.results.map((result) => [result.scenarioId, result]));
    const postById = new Map(post.results.map((result) => [result.scenarioId, result]));
    const regressions = [];
    for (const scenario of scenarios.scenarios) {
        const before = baselineById.get(scenario.id);
        const after = postById.get(scenario.id);
        if (before?.status !== 'passed' || after?.status !== 'passed') {
            regressions.push(
                `${scenario.id}:baseline-${before?.status ?? 'missing'}-post-${after?.status ?? 'missing'}`
            );
        }
    }
    assert(regressions.length === 0, `behavior comparison failed: ${regressions.join(', ')}`);
}

async function executePhase(scenarios, phase, outputFile, cli, repeatOverride) {
    assert(phase === 'baseline_current' || phase === 'post_migration', `cannot execute phase: ${phase}`);
    assert(existsSync(scriptBin), `missing PTY helper ${scriptBin}`);
    const cliPath = path.resolve(repoRoot, cli);
    assert(existsSync(cliPath), `missing built CLI ${cliPath}; run npm run build-cli first`);

    const evidenceDir = path.join(path.dirname(outputFile), 'behavior_evidence', phase);
    await mkdir(evidenceDir, { recursive: true });

    const results = [];
    for (const scenario of scenarios.scenarios) {
        results.push(await executeScenario({ cliPath, scenario, phase, evidenceDir, repeatOverride }));
    }

    const record = {
        schemaVersion: 1,
        phase,
        generatedAt: new Date().toISOString(),
        cli: path.relative(repoRoot, cliPath),
        resultStatusContract: scenarios.requiredResultStatus,
        results
    };

    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, JSON.stringify(record, null, 4) + '\n');
    validateResults(scenarios, outputFile, phase);
    return outputFile;
}

const args = parseArgs(process.argv);
const scenarios = readJson(scenarioPath);
const baselineFile = path.join(repoRoot, scenarios.resultFiles.baselineCurrent);
const postFile = path.join(repoRoot, scenarios.resultFiles.postMigration);

if (args.list) {
    for (const scenario of scenarios.scenarios) {
        console.log(`${scenario.id}\t${scenario.gate}\t${scenario.category}\t${scenario.execution}`);
    }
    process.exit(0);
}

try {
    if (args.phase === 'baseline_current') {
        const output = args.output || baselineFile;
        if (args.verifyOnly) {
            validateResults(scenarios, output, 'baseline_current');
        } else {
            await executePhase(scenarios, 'baseline_current', output, args.cli, args.repeat);
        }
        console.log(`baseline behavior evidence ready: ${output}`);
    } else if (args.phase === 'post_migration') {
        const output = args.output || postFile;
        if (args.verifyOnly) {
            validateResults(scenarios, output, 'post_migration');
        } else {
            await executePhase(scenarios, 'post_migration', output, args.cli, args.repeat);
        }
        console.log(`post-migration behavior evidence ready: ${output}`);
    } else if (args.phase === 'compare') {
        compareResults(scenarios, baselineFile, postFile);
        console.log(`behavior baseline/post comparison verified:\n  ${baselineFile}\n  ${postFile}`);
    } else {
        throw new Error(`unknown phase: ${args.phase}`);
    }
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
