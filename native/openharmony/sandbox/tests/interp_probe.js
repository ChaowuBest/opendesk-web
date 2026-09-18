#!/usr/bin/env node
// interp_probe.js — Node.js 解释器侧的权限拦截验证（在沙箱内运行）。
//
// 覆盖：允许区读/写/执行放行，拒绝区读/写/删/枚举/执行全部拦下。
// 输出每项一行；全部符合预期时退出码为 0。
//
// 用法: interp_probe.js <allow-dir> <deny-dir>
'use strict';
const fs = require('fs');
const cp = require('child_process');

const A = process.argv[2];
const D = process.argv[3];
let fails = 0;

function chk(name, expect, actual) {
    if (actual === expect) {
        console.log('ok   ' + name);
    } else {
        console.log('FAIL ' + name + ' (got ' + actual + ' want ' + expect + ')');
        fails++;
    }
}

function attempt(fn) {
    try { fn(); return 'ok'; } catch (e) { return 'blocked'; }
}

const rd = (p) => attempt(() => fs.readFileSync(p));
const wr = (p) => attempt(() => fs.writeFileSync(p, 'x'));
const dl = (p) => attempt(() => fs.unlinkSync(p));
const ls = (p) => attempt(() => fs.readdirSync(p));
const ex = (p) => attempt(() => cp.execFileSync(p, { stdio: 'ignore' }));

chk('js: read allow',   'ok',      rd(A + '/in.txt'));
chk('js: write allow',  'ok',      wr(A + '/js-out.txt'));
chk('js: read deny',    'blocked', rd(D + '/secret.txt'));
chk('js: write deny',   'blocked', wr(D + '/js-hack.txt'));
chk('js: delete deny',  'blocked', dl(D + '/data.txt'));
chk('js: list deny',    'blocked', ls(D));
chk('js: exec allow',   'ok',      ex(A + '/ok.sh'));
chk('js: exec deny',    'blocked', ex(D + '/no.sh'));

process.exit(fails ? 1 : 0);
