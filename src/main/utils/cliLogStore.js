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
