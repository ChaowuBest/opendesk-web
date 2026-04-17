import os from 'os';
import path from 'path';
import { expandPath } from '../../../../main/tui/components/file-completions';

describe('/import task path expansion', () => {
    test('expandPath should expand ~/ prefix', () => {
        const input = '~/Projects/task.json';
        const output = expandPath(input).replace(/\\/g, '/');
        const expected = `${os.homedir().replace(/\\/g, '/')}/Projects/task.json`;

        expect(output).toBe(expected);
    });

    test('expandPath should expand ~\\ prefix', () => {
        const input = '~\\Projects\\task.json';
        const output = expandPath(input).replace(/\\/g, '/');
        const expected = `${os.homedir().replace(/\\/g, '/')}/Projects/task.json`;

        expect(output).toBe(expected);
    });

    test('resolved import path should not contain literal "~" segment', () => {
        const resolved = path.resolve(expandPath('~/Projects/task.json')).replace(/\\/g, '/');

        expect(resolved.includes('/~/')).toBe(false);
        expect(resolved.endsWith('/Projects/task.json')).toBe(true);
    });
});
