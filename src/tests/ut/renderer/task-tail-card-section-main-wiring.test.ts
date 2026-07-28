import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');

describe('task TailCard section production wiring', () => {
    test('registers the handlers directly with the other task manager IPC handlers', () => {
        const start = mainSource.indexOf('const registerTaskManagerAPIHandlers = () => {');
        const firstExistingHandler = mainSource.indexOf("ipcMain.handle('taskManager:createTask'", start);
        const assemblyPrefix = mainSource.slice(start, firstExistingHandler);

        for (const channel of [
            'taskManager:listFrontendTailCardSections',
            'taskManager:setFrontendTailCardSection',
            'taskManager:removeFrontendTailCardSection'
        ]) {
            expect(assemblyPrefix.match(new RegExp(`ipcMain\\.handle\\(\\s*'${channel}'`, 'g'))).toHaveLength(1);
        }
    });
});
