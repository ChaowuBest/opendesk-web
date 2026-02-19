#!/usr/bin/env bash
# 分析 dist/cli/opendesk 打包产物的体积来源
# 通过 esbuild metafile 获取每个输入模块对最终产物的字节贡献，
# 再按 npm 包 / 项目源码 分组汇总。

set -euo pipefail
cd "$(dirname "$0")/.."

METAFILE="dist/cli/.meta.json"
OUTFILE="dist/cli/opendesk"

echo "==> 构建并生成 metafile ..."
npx esbuild src/main/cli.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile="$OUTFILE" \
  --external:node-screenshots \
  --external:vectra \
  --external:number-to-alphabet \
  --metafile="$METAFILE" \
  --log-level=warning

echo ""

# 用 node 解析 metafile 并汇总
node --input-type=module -e "
import { readFileSync } from 'fs';

const meta = JSON.parse(readFileSync('$METAFILE', 'utf8'));
const inputs = meta.inputs;

// 按包名分组
const groups = {};
let totalBytes = 0;

for (const [filePath, info] of Object.entries(inputs)) {
  const bytes = info.bytes;
  totalBytes += bytes;

  let group;
  const nmIdx = filePath.indexOf('node_modules/');
  if (nmIdx !== -1) {
    const afterNm = filePath.slice(nmIdx + 'node_modules/'.length);
    if (afterNm.startsWith('@')) {
      group = afterNm.split('/').slice(0, 2).join('/');
    } else {
      group = afterNm.split('/')[0];
    }
  } else {
    group = '📦 opendesk (项目源码)';
  }

  if (!groups[group]) {
    groups[group] = { bytes: 0, files: 0 };
  }
  groups[group].bytes += bytes;
  groups[group].files += 1;
}

// 按大小排序
const sorted = Object.entries(groups).sort((a, b) => b[1].bytes - a[1].bytes);

// 读取产物总行数
const outputContent = readFileSync('$OUTFILE', 'utf8');
const totalLines = outputContent.split('\n').length;

console.log('━'.repeat(72));
console.log('  打包产物分析: dist/cli/opendesk');
console.log('━'.repeat(72));
console.log('  产物总大小: ' + (totalBytes / 1024).toFixed(1) + ' KB (源码合计, 不含 esbuild 胶水代码)');
console.log('  产物总行数: ' + totalLines.toLocaleString());
console.log('  输入文件数: ' + Object.keys(inputs).length);
console.log('━'.repeat(72));
console.log('');
console.log('  ' + '来源'.padEnd(42) + '大小 (KB)'.padStart(10) + '占比'.padStart(8) + '文件数'.padStart(8));
console.log('  ' + '─'.repeat(68));

for (const [name, data] of sorted) {
  const kb = (data.bytes / 1024).toFixed(1);
  const pct = ((data.bytes / totalBytes) * 100).toFixed(1) + '%';
  const label = name.length > 40 ? name.slice(0, 37) + '...' : name;
  console.log('  ' + label.padEnd(42) + kb.padStart(10) + pct.padStart(8) + String(data.files).padStart(8));
}

console.log('  ' + '─'.repeat(68));
console.log('  ' + '合计'.padEnd(42) + (totalBytes / 1024).toFixed(1).padStart(10) + '100.0%'.padStart(8) + String(Object.keys(inputs).length).padStart(8));
console.log('');
"

rm -f "$METAFILE"
