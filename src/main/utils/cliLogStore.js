/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * CLI 模式下日志内存存储，供 Ink 界面订阅显示，避免直接打到 stdout 与界面冲突。
 */

const lines = [];
const listeners = new Set();
const MAX_LINES = 300;

function addLine(line) {
  if (typeof line !== 'string') line = String(line);
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  listeners.forEach((cb) => cb());
}

function getLines() {
  return [...lines];
}

function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export { addLine, getLines, subscribe };
