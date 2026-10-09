import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const repoRoot = path.resolve(here, '../../../..');
const runtimeDir = path.join(repoRoot, 'native/linux/sandbox/runtime/x86_64-unknown-linux-gnu');
const libPath = path.join(runtimeDir, 'libdynobox.so');
const buildLibPath = path.join(repoRoot, 'native/linux/sandbox/build/libdynobox.so');

/**
 * libdynobox.so 里的 64KB `_Thread_local` ask 响应缓冲区会把整个进程的静态
 * TLS 撑到 64KB。glibc 的 allocate_stack 在分配线程栈时会把静态 TLS 一起
 * 算进最小栈要求：
 *
 *     size += guardsize;
 *     if (size < ((guardsize + tls_static_size_for_stack
 *                 + MINIMAL_REST_STACK + pagesize_m1) & ~pagesize_m1))
 *         return EINVAL;
 *
 * 于是任何申请 <=64KB 栈的线程（Node 的 V8 平台线程用 32KB）都会拿到
 * EINVAL，表现为 "pthread_create: Invalid argument"。
 */

/** 读取 .so 里 PT_TLS 段的 memsz（纯 .tbss 时文件大小为 0，运行时才分配）。 */
function readTlsMemsz(soPath: string): number {
    const out = execFileSync('readelf', ['-lW', soPath], { encoding: 'utf8' });
    let total = 0;
    let found = false;
    for (const line of out.split('\n')) {
        // 形如: "  TLS  0x... 0x... 0x... 0x000000 0x010004 R  0x4"
        const m = line.match(/^\s*TLS\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+0x([0-9a-f]+)\s/i);
        if (m) {
            found = true;
            total += parseInt(m[1], 16);
        }
    }
    return found ? total : 0;
}

const soPath = existsSync(libPath) ? libPath : buildLibPath;

/** 静态 TLS 必须远小于 64KB —— 这是线程栈下限的直接决定因素。 */
test('libdynobox.so 的静态 TLS 不得撑爆线程栈（PT_TLS memsz < 8KB）', () => {
    assert.ok(existsSync(soPath), `未找到 libdynobox.so：${soPath}（请先 npm run build-sandbox:linux）`);
    const memsz = readTlsMemsz(soPath);
    assert.ok(
        memsz < 8 * 1024,
        `libdynobox.so 的 PT_TLS memsz=${memsz}B 过大，会把 glibc 线程栈下限抬到 ` +
            `${memsz + 4096 * 2}B，导致 32KB/64KB 栈的 pthread_create 返回 EINVAL`
    );
});

/**
 * 端到端：挂载 libdynobox.so 后创建小栈线程必须成功。
 * 这是 bug 的直接表现，也是唯一能覆盖「真实动态链接器 + 真实 glibc」的断言。
 */
test('挂载 libdynobox.so 后仍能创建 32KB / 64KB 小栈线程', () => {
    assert.ok(existsSync(soPath), `未找到 libdynobox.so：${soPath}`);

    const probe = path.join(here, 'fixtures', 'small-stack-thread.c');
    assert.ok(existsSync(probe), `未找到测试探针：${probe}`);

    // 编译探针（-lpthread 显式链接，避免依赖 glibc 2.34+ 的合并 libpthread）
    const bin = path.join(os.tmpdir(), 'dbox-small-stack-probe');
    execFileSync('gcc', ['-O0', '-o', bin, probe, '-lpthread']);

    // 64KB 栈正是 glibc 判定边界的敏感区：静态 TLS 每多 1 字节，下限就抬 1 字节。
    const env = { ...process.env, LD_PRELOAD: soPath };
    delete (env as Record<string, string | undefined>).DYNOBOX_CFG;
    delete (env as Record<string, string | undefined>).DYNOBOX_SANDBOX;

    const stdout = execFileSync(bin, [], { encoding: 'utf8', env });
    const codes = stdout
        .trim()
        .split('\n')
        .map((line) => {
            const m = line.match(/^(\d+):(\d+)$/);
            return m ? { stacksize: Number(m[1]), rc: Number(m[2]) } : null;
        })
        .filter((v): v is { stacksize: number; rc: number } => v !== null);

    assert.ok(codes.length > 0, `探针无有效输出：${JSON.stringify(stdout)}`);
    for (const { stacksize, rc } of codes) {
        assert.equal(rc, 0, `挂载 libdynobox.so 后 ${stacksize} 字节栈的 pthread_create 返回 ${rc}（期望 0）`);
    }
});

/** 回归锚点：ASK_IO_BUF 仍是 64KB，说明修复没有靠缩小缓冲区蒙混过关。 */
test('ask 响应缓冲区容量保持 64KB（缓冲区未被缩水掩盖问题）', () => {
    const src = readFileSync(path.join(repoRoot, 'native/openharmony/sandbox/src/ask.c'), 'utf8');
    const m = src.match(/#define\s+ASK_IO_BUF\s+(\d+)/);
    assert.ok(m, 'ask.c 中未找到 ASK_IO_BUF 定义');
    assert.equal(Number(m[1]), 65536);
});
