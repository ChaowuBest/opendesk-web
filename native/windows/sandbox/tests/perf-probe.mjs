// 沙箱性能定量探针：stat / read / 缓存命中 三类微基准（宿主持久缓存目录外执行）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-bench-'));
const N = 2000;
const files = [];
for (let i = 0; i < N; i++) {
    const f = path.join(work, `f${i}.txt`);
    fs.writeFileSync(f, 'x'.repeat(200));
    files.push(f);
}
// 每轮访问前把交给缓存的“已存在但未 stat 过”变为不同路径拼法
const uniq = [];
for (let i = 0; i < N; i++) files.push(path.join(work, `g${i}.txt`)); // 不存在目标

const t = (fn) => {
    const s = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - s) / 1e6;
};

// 1) 首次 stat 2000 个真实文件（unique 路径，冷缓存）
const t1 = t(() => { for (const f of files.slice(0, N)) fs.statSync(f); });
// 2) 重复 stat 同一批（缓存友好：镜像层 TTL 内）
const t2 = t(() => { for (const f of files.slice(0, N)) fs.statSync(f); });
// 3) ENOENT stat 2000 个不存在的路径（负缓存）
const miss = [];
for (let i = 0; i < N; i++) miss.push(path.join(work, `miss${i}.dat`));
const t3 = t(() => { for (const f of miss) { try { fs.statSync(f); } catch {} } });
const t4 = t(() => { for (const f of miss) { try { fs.statSync(f); } catch {} } });
// 4) 顺序读 200 个 50KB 文件
const reads = [];
const bigDir = path.join(work, 'big');
fs.mkdirSync(bigDir);
for (let i = 0; i < 200; i++) {
    const f = path.join(bigDir, `b${i}.bin`);
    fs.writeFileSync(f, Buffer.alloc(50 * 1024, i));
    reads.push(f);
}
const t5 = t(() => { for (const f of reads) fs.readFileSync(f); });

console.log(JSON.stringify({
    statColdMs: +t1.toFixed(1),
    statWarmMs: +t2.toFixed(1),
    enoentColdMs: +t3.toFixed(1),
    enoentWarmMs: +t4.toFixed(1),
    read200x50kMs: +t5.toFixed(1),
    perStatColdUs: +(t1 / N * 1000).toFixed(1),
    perStatWarmUs: +(t2 / N * 1000).toFixed(1),
    sbxRoot: process.env.SBX_ROOT ?? '',
}));