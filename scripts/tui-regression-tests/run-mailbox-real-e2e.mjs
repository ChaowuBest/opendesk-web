#!/usr/bin/env node
/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Imap from 'node-imap';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const defaultCli = 'dist/cli/opendesk-debug';
const defaultOutput = path.join(
    repoRoot,
    'docs/reports/pi_tui_migration_pl_review/artifacts/mailbox_real_e2e_post_migration.json'
);
const scriptBin = '/usr/bin/script';
const defaultEnvFile = '/tmp/opendesk-mail-test.env';
const focusRegressionSentinel = 'mailbox-focus-regression-sentinel';
const fatalPatterns = [
    /OpenDesk FATAL/i,
    /uncaughtException/i,
    /unhandledRejection/i,
    /TypeError:/i,
    /ReferenceError:/i,
    /SyntaxError:/i,
    /ERR_MODULE_NOT_FOUND/i,
    /LLM Request Auto Retry/i
];

function parseArgs(argv) {
    const args = {
        cli: defaultCli,
        output: defaultOutput,
        envFile: process.env.OPENDESK_TEST_MAIL_ENV_FILE || defaultEnvFile,
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
        } else if (arg === '--env-file' && argv[i + 1]) {
            args.envFile = argv[++i];
        } else if (arg.startsWith('--env-file=')) {
            args.envFile = arg.slice('--env-file='.length);
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

function maskEmail(email) {
    const [local, domain] = String(email).split('@');
    if (!local || !domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
}

function parseEnvContent(content) {
    const values = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

async function loadMailCredentials(envFile) {
    let fileEnv = {};
    if (envFile && existsSync(envFile)) {
        fileEnv = parseEnvContent(await readFile(envFile, 'utf8'));
    }
    const email = process.env.OPENDESK_TEST_MAIL_EMAIL || fileEnv.OPENDESK_TEST_MAIL_EMAIL || '';
    const rawAuthCode = process.env.OPENDESK_TEST_MAIL_AUTH_CODE || fileEnv.OPENDESK_TEST_MAIL_AUTH_CODE || '';
    const authCode = rawAuthCode.replace(/[^A-Za-z0-9]/g, '');
    const protocol = process.env.OPENDESK_TEST_MAIL_PROTOCOL || fileEnv.OPENDESK_TEST_MAIL_PROTOCOL || 'imap';
    assert(email.includes('@'), 'missing OPENDESK_TEST_MAIL_EMAIL');
    assert(authCode.length > 0, 'missing OPENDESK_TEST_MAIL_AUTH_CODE');
    assert(protocol === 'imap' || protocol === 'pop3', `unsupported OPENDESK_TEST_MAIL_PROTOCOL ${protocol}`);
    return { email, authCode, protocol };
}

function providerForEmail(email) {
    const domain = email.split('@').pop()?.toLowerCase();
    if (domain === 'qq.com' || domain === 'foxmail.com') {
        return {
            name: 'QQ Mail',
            imap: { host: 'imap.qq.com', port: 993, tls: true },
            pop3: { host: 'pop.qq.com', port: 995, tls: true },
            smtp: { host: 'smtp.qq.com', port: 465, tls: true }
        };
    }
    throw new Error(`unsupported real mailbox provider for ${maskEmail(email)}`);
}

function withTimeout(promise, ms, label) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 'error', error: `${label} timed out` }), ms);
        promise
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((err) => {
                clearTimeout(timer);
                resolve({ status: 'error', error: err?.message || String(err) });
            });
    });
}

async function verifyImap({ email, authCode, provider }) {
    return withTimeout(
        new Promise((resolve) => {
            const imap = new Imap({
                user: email,
                password: authCode,
                host: provider.imap.host,
                port: provider.imap.port,
                tls: provider.imap.tls,
                tlsOptions: { rejectUnauthorized: false },
                connTimeout: 15000,
                authTimeout: 15000
            });
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                try {
                    imap.end();
                } catch {
                    /* ignore */
                }
                resolve(result);
            };
            imap.once('ready', () => finish({ status: 'success', protocol: 'imap' }));
            imap.once('error', (err) =>
                finish({ status: 'error', protocol: 'imap', error: err?.message || String(err) })
            );
            imap.connect();
        }),
        20000,
        'IMAP verify'
    );
}

async function verifySmtp({ email, authCode, provider }) {
    return withTimeout(
        (async () => {
            const transporter = nodemailer.createTransport({
                host: provider.smtp.host,
                port: provider.smtp.port,
                secure: provider.smtp.tls && provider.smtp.port === 465,
                auth: { user: email, pass: authCode },
                tls: { rejectUnauthorized: false },
                connectionTimeout: 15000,
                greetingTimeout: 10000
            });
            try {
                await transporter.verify();
                return { status: 'success' };
            } finally {
                transporter.close();
            }
        })(),
        20000,
        'SMTP verify'
    );
}

async function writeTempSetting(configDir, credentials, provider) {
    await mkdir(path.join(configDir, 'apps', 'filemgr'), { recursive: true });
    await writeFile(path.join(configDir, 'apps', 'filemgr', 'scan.lock'), '');
    const setting = {
        locale: 'en-US',
        default_model: 'pi-tui-mailbox-real-e2e',
        providers: [
            {
                name: 'pi-tui-mailbox-real-e2e-provider',
                provider_type: 'openai',
                base_url: 'http://127.0.0.1:9/v1',
                api_key: 'pi-tui-mailbox-real-e2e',
                enabled: true
            }
        ],
        models: [
            {
                alias: 'pi-tui-mailbox-real-e2e',
                provider_name: 'pi-tui-mailbox-real-e2e-provider',
                model_name: 'pi-tui-mailbox-real-e2e',
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
            mailbox: {
                currentProfileId: credentials.email,
                profiles: [
                    {
                        name: credentials.email,
                        username: credentials.email,
                        email: credentials.email,
                        password: credentials.authCode,
                        inbox: {
                            protocol: credentials.protocol,
                            imap: provider.imap,
                            pop3: provider.pop3
                        },
                        outbox: {
                            smtp: {
                                account: credentials.email,
                                ...provider.smtp
                            }
                        }
                    }
                ]
            }
        }
    };
    await writeFile(path.join(configDir, 'setting.json'), JSON.stringify(setting, null, 4) + '\n', { mode: 0o600 });
}

async function prepareTempEnvironment(credentials, provider) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-mailbox-real-e2e-'));
    const workspace = path.join(tempRoot, 'workspace');
    const configDir = path.join(tempRoot, 'config');
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeTempSetting(configDir, credentials, provider);
    return { tempRoot, workspace, configDir };
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
        case 'up':
            return '\x1b[A';
        case 'down':
            return '\x1b[B';
        case 'right':
            return '\x1b[C';
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

function hasMailboxEvidence(transcript, email) {
    const plain = stripAnsi(transcript);
    return (
        plain.includes('OPENDESK MAIL') &&
        plain.includes('1:全部') &&
        plain.includes('2:未读') &&
        plain.includes('5:已发送') &&
        plain.includes(email)
    );
}

async function runMailboxTui({ cliPath, workspace, configDir, rawLogFile, email }) {
    const inputFifo = path.join(path.dirname(rawLogFile), 'mailbox-real-input.fifo');
    await new Promise((resolve, reject) => {
        const mkfifo = spawn('mkfifo', [inputFifo], { stdio: 'ignore' });
        mkfifo.once('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`mkfifo failed with exit code ${code}`));
            }
        });
        mkfifo.once('error', reject);
    });

    const command = [
        'stty cols 120 rows 30 2>/dev/null || true',
        `exec ${shellQuote(cliPath)} --workspace ${shellQuote(workspace)} --config-directory ${shellQuote(configDir)} --language en-US --render-interval 20`
    ].join('; ');
    const scriptCommand = [
        `cat ${shellQuote(inputFifo)}`,
        `${shellQuote(scriptBin)} -q ${shellQuote(rawLogFile)} /bin/bash -c ${shellQuote(command)}`
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
    const input = createWriteStream(inputFifo);
    input.on('error', () => {});

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
    let controlledTermination = false;
    let evidenceCaptured = false;

    const send = (steps) => {
        if (!input.writable) return;
        let delayMs = 0;
        for (const step of steps) {
            if (step.waitMs) {
                delayMs += step.waitMs;
                continue;
            }
            const write = () => {
                if (!input.writable) return;
                if (step.text) {
                    input.write(step.text);
                }
                if (step.key) {
                    input.write(keyBytes(step.key));
                }
            };
            if (delayMs > 0) {
                setTimeout(write, delayMs);
            } else {
                write();
            }
            delayMs += 150;
        }
    };

    const sendImmediate = (steps) => {
        if (!input.writable) return;
        for (const step of steps) {
            if (step.text) {
                input.write(step.text);
            }
            if (step.key) {
                input.write(keyBytes(step.key));
            }
        }
    };

    const openMail = () => {
        sendImmediate([{ key: 'escape' }]);
        setTimeout(() => {
            send([{ text: '/mail' }, { key: 'enter' }]);
        }, 500);
    };

    const firstOpenTimer = setTimeout(openMail, 8_000);
    const secondOpenTimer = setTimeout(() => {
        if (!evidenceCaptured) openMail();
    }, 25_000);

    const evidenceTimer = setInterval(() => {
        const transcript = existsSync(rawLogFile) ? readFileSync(rawLogFile, 'utf8') : `${stdout}\n${stderr}`;
        if (hasMailboxEvidence(transcript, email)) {
            evidenceCaptured = true;
            controlledTermination = true;
            clearInterval(evidenceTimer);
            send([
                { text: '2' },
                { waitMs: 500 },
                { text: '1' },
                { waitMs: 500 },
                { key: 'right' },
                { waitMs: 250 },
                { key: 'right' },
                { waitMs: 250 },
                { key: 'up' },
                { waitMs: 250 },
                { key: 'down' },
                { waitMs: 250 },
                { key: 'escape' },
                { waitMs: 900 },
                { text: focusRegressionSentinel }
            ]);
            setTimeout(() => {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                } catch {
                    child.kill('SIGTERM');
                }
            }, 4_000);
        }
    }, 1_000);

    const timer = setTimeout(() => {
        timedOut = true;
        controlledTermination = true;
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }, 75_000);

    const exit = await exitPromise;
    clearTimeout(timer);
    clearTimeout(firstOpenTimer);
    clearTimeout(secondOpenTimer);
    clearInterval(evidenceTimer);
    input.end();

    const transcript = existsSync(rawLogFile) ? readFileSync(rawLogFile, 'utf8') : `${stdout}\n${stderr}`;
    return {
        stdout,
        stderr,
        transcript,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut,
        controlledTermination,
        evidenceCaptured
    };
}

function stripAnsi(value) {
    return String(value)
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/(?:\x1B\])?8;;[^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function safeError(value) {
    if (!value) return undefined;
    return stripAnsi(value).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}

function redactTranscript(raw, email) {
    const plain = stripAnsi(raw)
        .replaceAll(email, maskEmail(email))
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const safeNeedles = [
        'OPENDESK MAIL',
        '正在加载邮件',
        '同步中',
        '1:全部',
        '2:未读',
        '3:收藏',
        '4:草稿',
        '5:已发送',
        '暂无邮件',
        '已加载',
        'ESC 关闭',
        '选择',
        '筛选',
        focusRegressionSentinel,
        maskEmail(email)
    ];
    const selected = [];
    for (const line of plain) {
        if (safeNeedles.some((needle) => line.includes(needle))) {
            selected.push(line.slice(0, 180));
        }
        if (selected.length >= 80) break;
    }
    const uniqueSelected = Array.from(new Set(selected));
    if (
        stripAnsi(raw).includes(focusRegressionSentinel) &&
        !uniqueSelected.some((line) => line.includes(focusRegressionSentinel))
    ) {
        uniqueSelected.push(`${focusRegressionSentinel}: observed in raw PTY transcript`);
    }
    return uniqueSelected.join('\n') + '\n';
}

function validateRun(run, email) {
    const text = `${run.transcript}\n${run.stdout}\n${run.stderr}`;
    const plain = stripAnsi(text);
    const failures = [];
    if (run.timedOut && !run.controlledTermination) failures.push('timed out');
    if (run.exitCode !== 0 && !run.controlledTermination) failures.push(`exit code ${run.exitCode}`);
    for (const pattern of fatalPatterns) {
        if (pattern.test(text)) failures.push(`matched fatal pattern ${pattern}`);
    }
    for (const expected of ['OPENDESK MAIL', '1:全部', '2:未读', '5:已发送']) {
        if (!plain.includes(expected)) failures.push(`missing expected output ${JSON.stringify(expected)}`);
    }
    if (!plain.includes(email)) {
        failures.push('missing configured mailbox account in TUI output');
    }
    if (!plain.includes(focusRegressionSentinel)) {
        failures.push('mailbox focus regression: sentinel missing after right/right/up/down/escape');
    }
    return failures;
}

async function main() {
    const args = parseArgs(process.argv);
    const cliPath = path.resolve(repoRoot, args.cli);
    assert(existsSync(scriptBin), `missing PTY helper ${scriptBin}`);
    assert(existsSync(cliPath), `missing built CLI ${cliPath}; run npm run build-cli first`);

    const credentials = await loadMailCredentials(args.envFile);
    const provider = providerForEmail(credentials.email);
    const [inboxVerify, smtpVerify] = await Promise.all([
        credentials.protocol === 'imap'
            ? verifyImap({ email: credentials.email, authCode: credentials.authCode, provider })
            : Promise.resolve({ status: 'skipped', protocol: credentials.protocol }),
        verifySmtp({ email: credentials.email, authCode: credentials.authCode, provider })
    ]);

    const env = await prepareTempEnvironment(credentials, provider);
    const evidenceDir = path.join(path.dirname(args.output), 'mailbox_real_evidence', 'post_migration');
    await mkdir(evidenceDir, { recursive: true });
    const rawLogFile = path.join(env.tempRoot, 'mailbox-real-tui.raw.ansi.txt');
    const redactedLogFile = path.join(evidenceDir, 'mailbox-real-tui.redacted.txt');

    try {
        const run = await runMailboxTui({
            cliPath,
            workspace: env.workspace,
            configDir: env.configDir,
            rawLogFile,
            email: credentials.email
        });
        const failures = validateRun(run, credentials.email);
        if (inboxVerify.status !== 'success') {
            failures.push(`${credentials.protocol.toUpperCase()} verify failed`);
        }
        if (smtpVerify.status !== 'success') {
            failures.push('SMTP verify failed');
        }

        const rawHash = createHash('sha256').update(run.transcript).digest('hex');
        const redactedTranscript = redactTranscript(
            `${run.transcript}\n${run.stdout}\n${run.stderr}`,
            credentials.email
        );
        await writeFile(redactedLogFile, redactedTranscript);

        const record = {
            schemaVersion: 1,
            phase: 'post_migration_real_mailbox_e2e',
            generatedAt: new Date().toISOString(),
            purpose:
                'Validate real QQ Mail account connectivity and Mailbox TUI list/filter/sync/close flows after pi-tui migration.',
            privacyPolicy:
                'The authorization code is read only from environment or a local env file. Raw PTY logs and temp config stay in a temporary directory and are removed by default. Repository evidence stores only redacted UI lines, hashes, byte counts, and structural status.',
            account: {
                provider: provider.name,
                emailMasked: maskEmail(credentials.email),
                protocol: credentials.protocol,
                authCodePresent: credentials.authCode.length > 0,
                authCodeLength: credentials.authCode.length
            },
            serverPreset: {
                imap: { host: provider.imap.host, port: provider.imap.port, tls: provider.imap.tls },
                pop3: { host: provider.pop3.host, port: provider.pop3.port, tls: provider.pop3.tls },
                smtp: { host: provider.smtp.host, port: provider.smtp.port, tls: provider.smtp.tls }
            },
            environment: `${os.type()} ${os.release()}, node ${process.version}, script PTY, temp OpenDesk config`,
            cli: path.relative(repoRoot, cliPath),
            connectivity: {
                inbox: { ...inboxVerify, error: safeError(inboxVerify.error) },
                smtp: { ...smtpVerify, error: safeError(smtpVerify.error) }
            },
            tuiFlow: {
                status: failures.length === 0 ? 'passed' : 'failed',
                steps: [
                    'launch CLI with temporary config',
                    'open /mail overlay',
                    'verify configured account is rendered',
                    'switch unread/all filters',
                    'press right/right/up/down and close with Escape',
                    'type a sentinel in the main input after closing to prove focus recovery',
                    'close overlay',
                    'terminate PTY after evidence capture because real mailbox sync may continue in the background'
                ],
                evidence: path.relative(repoRoot, redactedLogFile),
                exitCode: run.exitCode,
                signal: run.signal,
                timedOut: run.timedOut,
                controlledTermination: run.controlledTermination,
                rawLogSha256: rawHash,
                rawLogBytes: Buffer.byteLength(run.transcript),
                failures,
                stdoutPreview: safeError(run.stdout.slice(0, 500)),
                stderrPreview: safeError(run.stderr.slice(0, 500))
            }
        };

        await mkdir(path.dirname(args.output), { recursive: true });
        await writeFile(args.output, JSON.stringify(record, null, 4) + '\n');
        assert(failures.length === 0, `mailbox real E2E failed: ${failures.join(', ')}`);
        console.log(`mailbox real E2E passed: ${args.output}`);
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
