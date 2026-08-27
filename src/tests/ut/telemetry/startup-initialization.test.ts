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
});
