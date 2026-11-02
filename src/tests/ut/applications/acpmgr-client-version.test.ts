import fs from 'node:fs';
import path from 'node:path';
import { OPENDESK_RUNTIME_VERSION, isValidVersion } from '../../../main/utils/version';

const ACPMGR_DIR = path.resolve(process.cwd(), 'src/main/applications/acpmgr');

/** 递归收集 acpmgr 下的 TypeScript 源码 */
function listSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full);
    }
    return files;
}

// 硬编码的版本号会随发版漂移（历史上 clientInfo 一直停在 0.3.4），
// 统一从 utils/version 的 OPENDESK_RUNTIME_VERSION 取，这里从源头拦住。
const HARDCODED_VERSION = /version:\s*'\d+\.\d+\.\d+'/;
const CLIENT_INFO_VERSION = /clientInfo:[^\n]*version:/;

describe('ACP 客户端版本号', () => {
    test('宿主版本号本身是合法 SemVer', () => {
        expect(isValidVersion(OPENDESK_RUNTIME_VERSION)).toBe(true);
    });

    test('acpmgr 内不再出现硬编码版本号', () => {
        const offenders = listSourceFiles(ACPMGR_DIR)
            .filter((file) => HARDCODED_VERSION.test(fs.readFileSync(file, 'utf-8')))
            .map((file) => path.relative(process.cwd(), file));
        expect(offenders).toEqual([]);
    });

    test('clientInfo.version 一律引用宿主版本常量', () => {
        const offenders = listSourceFiles(ACPMGR_DIR)
            .filter((file) => {
                const content = fs.readFileSync(file, 'utf-8');
                return content
                    .split('\n')
                    .some((line) => CLIENT_INFO_VERSION.test(line) && !line.includes('OPENDESK_RUNTIME_VERSION'));
            })
            .map((file) => path.relative(process.cwd(), file));
        expect(offenders).toEqual([]);
    });
});
