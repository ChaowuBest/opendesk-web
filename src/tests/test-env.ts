import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMP_DIRECTORY_PREFIX = 'opendesk-test-data-';
// 单个测试文件的运行时长远小于该阈值，超时的目录必然是历史残留
const STALE_TEMP_DIRECTORY_MS = 2 * 60 * 60 * 1000;

// node:test / jest 的 worker 进程可能被宿主强杀，依赖 process exit 事件清理会泄漏，
// 因此在每次测试进程启动时顺带回收超过阈值的残留目录（自身目录由 exit 兜底清理）
function removeStaleIsolatedDirectories(): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(os.tmpdir());
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.startsWith(TEMP_DIRECTORY_PREFIX)) {
            continue;
        }
        const directory = path.join(os.tmpdir(), entry);
        try {
            if (Date.now() - fs.statSync(directory).mtimeMs > STALE_TEMP_DIRECTORY_MS) {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        } catch {
            // 并发的其他测试进程可能正在使用同名目录，忽略即可
        }
    }
}

// 测试进程若不隔离，Setting 会把数据目录解析到真实用户目录（如 %APPDATA%/opendesk），
// 任何触达任务/设置/日志的测试都会在其中留下 task_list.json、task_*.json 等残留，
// GUI 启动后这些残留会以“未命名任务”的形式出现在任务列表里。
// Jest 通过 setupFiles 加载本模块，node:test 通过 `tsx --test --import` 加载；
// 测试用例自行显式设置 OPENDESK_CONFIG_DIRECTORY 时以用例设置为准。
if (process.env.OPENDESK_CONFIG_DIRECTORY === undefined && process.env.OPENDDESK_CONFIG_DIRECTORY === undefined) {
    removeStaleIsolatedDirectories();
    const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX));
    process.env.OPENDESK_CONFIG_DIRECTORY = isolatedDirectory;
    process.on('exit', () => {
        try {
            fs.rmSync(isolatedDirectory, { recursive: true, force: true });
        } catch {
            // 临时目录清理失败不影响测试进程退出，残留由下次启动时的回收逻辑兜底
        }
    });
}
