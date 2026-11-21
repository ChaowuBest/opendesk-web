import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../../../main/cli.ts', import.meta.url), 'utf8');
const telemetryDocs = readFileSync(new URL('../../../../docs/telemetry.md', import.meta.url), 'utf8');

describe('telemetry startup initialization', () => {
    test('does not instrument GUI or CLI loading stages', () => {
        expect(mainSource).not.toContain('StartupTrace');
        expect(mainSource).not.toContain("createPhase('startup.");
        expect(cliSource).not.toContain('StartupTrace');
        expect(cliSource).not.toContain("createPhase('startup.");
        expect(telemetryDocs).not.toContain('startup-tracer.ts');
    });

    test('does not load the runtime telemetry module on the GUI import path', () => {
        expect(mainSource).not.toContain("from './telemetry/index.js'");
        expect(mainSource).toContain("import('./telemetry/index.js')");
    });

    test('initializes GUI telemetry after the main window is shown', () => {
        expect(mainSource).toContain('void mainWindowShown.then(() => void ensureTelemetryReady())');
        expect(mainSource).not.toContain("globalMainWindow.once('ready-to-show', triggerTelemetryInitialization)");
        expect(mainSource.indexOf('createWindow();')).toBeLessThan(
            mainSource.indexOf('void mainWindowShown.then(() => void ensureTelemetryReady())')
        );
    });

    test('initializes CLI telemetry after command infrastructure and TUI rendering', () => {
        const headlessBranch = cliSource.slice(
            cliSource.indexOf('if (args.headless && args.command)'),
            cliSource.indexOf('} else {', cliSource.indexOf('if (args.headless && args.command)'))
        );
        expect(headlessBranch.indexOf('await runner.setupLazyHarnessInit()')).toBeLessThan(
            headlessBranch.indexOf('await initTelemetry()')
        );

        const tuiBranch = cliSource.slice(cliSource.indexOf('} else {', cliSource.indexOf('if (args.headless')));
        expect(tuiBranch.indexOf('tui.start()')).toBeLessThan(tuiBranch.indexOf('await initTelemetry()'));
    });

    test('设备心跳统一交给 telemetry/heartbeat.ts，两个入口不再各写一份', () => {
        const heartbeatSource = readFileSync(new URL('../../../main/telemetry/heartbeat.ts', import.meta.url), 'utf8');
        expect(heartbeatSource).toContain('isFeatureDisabled(TELEMETRY_FEATURE_ID)');
        expect(heartbeatSource).toContain('export function syncHeartbeatReporter(): void {');

        // 启停判定只存在于 heartbeat.ts 一处：GUI 与 CLI 只声明启动时机
        expect(mainSource).not.toContain('function syncHeartbeatReporter(): void {');
        expect(cliSource).not.toContain('function syncHeartbeatReporter(): void {');
        expect(mainSource).not.toMatch(/from '\.\/utils\/reporter\.js'/);
        expect(cliSource).not.toMatch(/from '\.\/utils\/reporter\.js'/);
        expect(cliSource).toContain('function applyTelemetryFeatureGate(): void {');
        expect(cliSource.match(/applyTelemetryFeatureGate\(\);/g)?.length).toBe(2);
    });

    test('GUI 在插件宿主之后启动心跳，CLI 在宿主之前启动', () => {
        // GUI：插件 setup 里禁用 telemetry 时连首次上报都不发
        const guiStart = mainSource.indexOf("startHeartbeatReporter('desktop');");
        expect(guiStart).toBeGreaterThan(mainSource.indexOf('await initializePluginHost();'));

        // CLI：插件宿主初始化失败也照常上报；插件禁用后由特性变更订阅把调度停掉
        const cliStart = cliSource.indexOf("startHeartbeatReporter('cli');");
        expect(cliStart).toBeGreaterThan(cliSource.indexOf('initTempDir();'));
        expect(cliStart).toBeLessThan(cliSource.indexOf('await initializePluginHost();'));
    });
});
