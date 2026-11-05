import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { exportLogEntries } from '../../../main/utils/export-log.js';
import { createLocalExportDestinationHost } from '../../../main/utils/export-local-destination.js';
import { LogStream } from '../../../main/utils/logger.js';

function loadHandler(directory: string, canceled = false) {
    const source = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
    const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2022, true);
    let handlerSource = '';
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(parsed) === 'ipcMain.handle' &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === 'setting:exportLogEntries'
        ) {
            handlerSource = node.getText(parsed);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    const handle = jest.fn();
    const formatEntries = jest.fn(() => 'formatted log content');
    jest.spyOn(LogStream, 'getStream').mockReturnValue({ formatEntries } as unknown as LogStream);
    runInNewContext(
        ts.transpileModule(handlerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
        {
            ipcMain: { handle },
            app: { getPath: () => directory },
            path,
            t: (key: string) => key,
            globalMainWindow: null,
            dialog: { showSaveDialog: async () => ({ canceled, filePath: path.join(directory, 'logs.txt') }) },
            createLocalExportDestinationHost,
            exportLogEntries,
            logger: { error: jest.fn() }
        }
    );
    return {
        handler: handle.mock.calls[0][1] as (_event: object, options: unknown) => Promise<unknown>,
        formatEntries
    };
}

describe('Electron log export consumes the shared transaction', () => {
    let directory: string;
    beforeEach(async () => {
        directory = await mkdtemp(path.join(tmpdir(), 'opendesk-log-export-'));
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await rm(directory, { recursive: true, force: true });
    });

    test('exports formatted content to the selected local target and preserves the existing result shape', async () => {
        const { handler, formatEntries } = loadHandler(directory);
        expect(await handler({}, { scope: 'filtered', filter: ' warning ' })).toEqual({
            status: 'ok',
            data: { canceled: false, filePath: path.join(directory, 'logs.txt') }
        });
        expect(formatEntries).toHaveBeenCalledWith({ filter: 'warning' });
        expect(await readFile(path.join(directory, 'logs.txt'), 'utf8')).toBe('formatted log content');
        expect(await readdir(directory)).toEqual(['logs.txt']);
    });

    test('canceling the Electron chooser does not generate content or leave artifacts', async () => {
        const { handler, formatEntries } = loadHandler(directory, true);
        expect(await handler({}, {})).toEqual({ status: 'ok', data: { canceled: true } });
        expect(formatEntries).not.toHaveBeenCalled();
        expect(await readdir(directory)).toEqual([]);
    });
});
