#!/usr/bin/env node
// t_adversarial.js — Node.js 侧的对抗性边界探针（在沙箱内运行）。
//
//    must-block : 正常 fs / child_process API，策略必须拦住
//    boundary   : README 已声明的机制限制（libuv 内部直接发 statx 系统调用，
//                 因此属性查询天然不受拦截层约束）
// 退出码 0 = 与预期一致，1 = 不一致。
//
// 用法: t_adversarial.js <technique> <sentinel> <allow-dir>
'use strict';
const fs = require('fs');
const cp = require('child_process');

const MARK = 'TOP-SECRET';

function finish(tech, expectBlocked, leaked) {
    console.log('ADV ' + tech.padEnd(16) + ' expect=' +
                (expectBlocked ? 'must-block' : 'boundary').padEnd(10) +
                ' result=' + (leaked ? 'leaked' : 'blocked'));
    const ok = expectBlocked ? !leaked : leaked;
    process.exit(ok ? 0 : 1);
}

const tech = process.argv[2];
const sent = process.argv[3];

if (tech === 'js-read') {
    try {
        finish(tech, true, fs.readFileSync(sent, 'utf8').includes(MARK));
    } catch (e) {
        finish(tech, true, false);
    }
}

if (tech === 'js-open') {
    try {
        const fd = fs.openSync(sent, 'r');
        const b = Buffer.alloc(256);
        const n = fs.readSync(fd, b, 0, 256, 0);
        fs.closeSync(fd);
        finish(tech, true, b.toString('utf8', 0, n).includes(MARK));
    } catch (e) {
        finish(tech, true, false);
    }
}

if (tech === 'js-stat') {
    // 已知边界：libuv 用 syscall(SYS_statx) 取属性，绕过 LD_PRELOAD 层
    try {
        fs.statSync(sent);
        finish(tech, false, true);
    } catch (e) {
        finish(tech, false, false);
    }
}

if (tech === 'js-child') {
    try {
        finish(tech, true, cp.execFileSync('/bin/cat', [sent], { encoding: 'utf8' })
            .includes(MARK));
    } catch (e) {
        finish(tech, true, false);
    }
}

console.error('unknown technique: ' + tech);
process.exit(2);
