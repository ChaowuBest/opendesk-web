#!/usr/bin/env node
// 统计 AI 代码占比数据，生成 HTML 图表
// 方法论对齐 scripts/count_ai_code.py：CODE_FILE_EXTS 白名单、排除空行
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';

const REPO = '/Users/liyi/Projects/OpenDesk';
const STATS_DIR = join(REPO, 'scripts/ai-code-stats');

function run(cmd) {
    try {
        return execSync(cmd, { cwd: REPO, encoding: 'utf8', maxBuffer: 500 * 1024 * 1024, timeout: 600000 });
    } catch (e) {
        console.error(`Command failed: ${cmd.substring(0, 80)}...`);
        return '';
    }
}

// ============================================================
// File filtering (aligned with count_ai_code.py)
// ============================================================
const CODE_FILE_EXTS = new Set([
    '.py',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.vue',
    '.svelte',
    '.java',
    '.kt',
    '.kts',
    '.scala',
    '.groovy',
    '.c',
    '.cpp',
    '.cc',
    '.cxx',
    '.h',
    '.hpp',
    '.m',
    '.mm',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.swift',
    '.cs',
    '.fs',
    '.fsx',
    '.html',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.styl',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.xml',
    '.ini',
    '.cfg',
    '.conf',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.bat',
    '.cmd',
    '.sql',
    '.graphql',
    '.gql',
    '.md',
    '.txt',
    '.rst',
    '.adoc',
    '.r',
    '.R',
    '.lua',
    '.pl',
    '.pm',
    '.t',
    '.pro',
    '.dockerfile',
    '.makefile',
    '.mk',
    '.tf',
    '.tfvars',
    '.hcl',
    '.cue',
    '.mjs',
    '.cjs',
    '.mts',
    '.cts'
]);
const SPECIAL_FILES = new Set(['Makefile', 'Dockerfile', 'Vagrantfile', 'Gemfile', 'Rakefile', 'CMakeLists.txt']);
const EXCLUDE_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    'out',
    '__pycache__',
    '.cache',
    '.venv',
    'venv',
    '.env'
]);

function isCodeFile(f) {
    const parts = f.replace(/\\/g, '/').split('/');
    for (const p of parts) {
        if (EXCLUDE_DIRS.has(p)) return false;
        if (p.endsWith('.min.js') || p.endsWith('.min.css') || p.endsWith('.bundle.js') || p.endsWith('.bundle.css'))
            return false;
    }
    if (f === 'package-lock.json' || f === 'yarn.lock' || f === 'pnpm-lock.yaml') return false;
    const ext = '.' + f.split('.').pop()?.toLowerCase();
    if (CODE_FILE_EXTS.has(ext)) return true;
    const base = f.split('/').pop();
    return SPECIAL_FILES.has(base);
}

// ============================================================
// AI marker parsing
// ============================================================
function parseAIMarkers(message) {
    const lines = message.split('\n');
    let agent = null;
    let model = null;
    let foundMadeWith = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Skip user's own co-authored-by (not an AI marker)
        if (/co[- ]?authored[- ]?by:\s*uv0xab/i.test(trimmed)) continue;
        if (/co[- ]?authored[- ]?by:\s*liyi\.fm/i.test(trimmed)) continue;
        if (/reviewed[- ]?by:/i.test(trimmed)) continue;
        if (/signed[- ]?off[- ]?by:/i.test(trimmed)) continue;

        const coAuthMatch = trimmed.match(/co[- ]?authored[- ]?by:\s*(.+)/i);
        const madeWithMatch = trimmed.match(/made[- ]?with:\s*(.+)/i);

        let info = null;
        let isMadeWith = false;
        if (coAuthMatch) {
            info = coAuthMatch[1].trim();
        } else if (madeWithMatch) {
            info = madeWithMatch[1].trim();
            isMadeWith = true;
            foundMadeWith = true;
        } else {
            continue;
        }

        const modelMatch = info.match(/\(model:\s*([^)]+)\)/i);
        if (modelMatch) {
            model = normalizeModelName(modelMatch[1].trim());
            info = info.replace(/\(model:\s*[^)]+\)/i, '').trim();
        }

        const bracketMatch = info.match(/^([^(<]+)/);
        const rawAgent = bracketMatch ? bracketMatch[1].trim() : info.trim();

        // For Co-authored-by: only accept if it looks like a known AI tool
        // (e.g. Cursor, Roo Code, Claude, Codex, Trae, etc.)
        // This excludes human collaborators like Stella__
        if (!isMadeWith && !looksLikeAITool(rawAgent)) {
            continue;
        }

        agent = normalizeAgentName(rawAgent);

        if (agent && model) break;
    }

    if (agent) return { isAI: true, agent: agent || 'Unknown', model: model || 'Unspecified' };
    return { isAI: false, agent: 'Human', model: 'Human' };
}

// Known AI coding tool name patterns (case-insensitive match)
function looksLikeAITool(name) {
    const lower = name.toLowerCase().trim();
    const aiPatterns = [
        'cursor',
        'roo code',
        'roo',
        'claude',
        'codex',
        'trae',
        'opendesk',
        'kilo code',
        'kilo',
        'genspark'
        // Also catch model-only entries from direct AI commits
    ];
    for (const p of aiPatterns) {
        if (lower.includes(p)) return true;
    }
    // Also accept if the name has a recognizable model pattern "(model: xxx)"
    // (caught earlier, but just in case)
    return false;
}

function normalizeAgentName(name) {
    const map = {
        opendesk: 'OpenDesk',
        'trae-cli': 'Trae CLI',
        'trae cli': 'Trae CLI',
        'kilo code': 'Kilo Code',
        'openai codex': 'OpenAI Codex'
    };
    const lower = name.toLowerCase();
    if (map[lower]) return map[lower];
    return name
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function normalizeModelName(name) {
    const map = {
        'minimax-m2.7': 'MiniMax-M2.7',
        'minimax m2.7': 'MiniMax-M2.7',
        'minimax-m2-7': 'MiniMax-M2.7',
        'glm-5.1': 'GLM-5.1',
        'glm-5': 'GLM-5',
        'glm-5.2': 'GLM-5.2',
        'gpt-5': 'GPT-5',
        'gpt-5.5': 'GPT-5.5',
        'claude-4.6-opus': 'Claude-4.6-Opus',
        'claude-4.6-opus-thinking': 'Claude-4.6-Opus-Thinking',
        'claude-4.6-sonnet': 'Claude-4.6-Sonnet',
        'claude-opus-4-7': 'Claude-Opus-4.7',
        'claude-opus-4-8': 'Claude-Opus-4.8',
        'claude opus 4.6': 'Claude-Opus-4.6',
        'claude-opus-4.6': 'Claude-Opus-4.6',
        'claude-opus-4-6': 'Claude-Opus-4.6',
        'claude sonnet 4.6': 'Claude-Sonnet-4.6',
        'claude-sonnet-4.6': 'Claude-Sonnet-4.6',
        'claude-sonnet-4-6': 'Claude-Sonnet-4.6',
        'deepseek-v4-pro': 'DeepSeek-V4-Pro',
        'qwen3.5-plus': 'Qwen3.5-Plus',
        'qwen3.5-397b-a17b': 'Qwen3.5-397B',
        'qwen3.6-plus': 'Qwen3.6-Plus',
        'qwen3.7-plus': 'Qwen3.7-Plus',
        'doubao-seed-2.0-code': 'Doubao-Seed-2.0',
        'kimi-k2.5': 'Kimi-K2.5',
        'gemini-3.1-pro': 'Gemini-3.1-Pro',
        auto: 'Auto'
    };
    const lower = name
        .toLowerCase()
        .replace(/[-_\s]+/g, '-')
        .trim();
    if (map[lower]) return map[lower];
    return name;
}

// ============================================================
// Step 1: Extract all commits with --numstat (per-file diffs)
// ============================================================
console.log('Extracting all commits with numstat...');
const rawOutput = run(`git log --reverse --format="---COMMIT---%n%H%n%aI%n%an%n%B---ENDMSG---" --numstat`);

const commits = [];
const blocks = rawOutput.split('---COMMIT---\n').filter((b) => b.trim());
for (const block of blocks) {
    const parts = block.split('---ENDMSG---');
    if (parts.length < 2) continue;
    const headerPart = parts[0];
    const numstatText = parts.slice(1).join('\n').trim();

    const headerLines = headerPart.trim().split('\n');
    if (headerLines.length < 3) continue;

    const hash = headerLines[0].trim();
    const dateStr = headerLines[1].trim();
    const message = headerLines.slice(3).join('\n').trim();

    // Parse numstat: each line is "insertions\tdeletions\tfilename"
    // Filter by CODE_FILE_EXTS
    let insertions = 0,
        deletions = 0;
    for (const nsLine of numstatText.split('\n')) {
        const t = nsLine.trim();
        if (!t) continue;
        const cols = t.split('\t');
        if (cols.length < 3) continue;
        // Binary files show "-" instead of numbers
        if (cols[0] === '-' || cols[1] === '-') continue;
        const filename = cols.slice(2).join('\t');
        if (isCodeFile(filename)) {
            insertions += parseInt(cols[0], 10) || 0;
            deletions += parseInt(cols[1], 10) || 0;
        }
    }

    const aiInfo = parseAIMarkers(message);

    commits.push({
        hash,
        date: dateStr,
        insertions,
        deletions,
        totalChanges: insertions + deletions,
        ...aiInfo
    });
}

console.log(`Total commits: ${commits.length}`);
console.log(`AI commits: ${commits.filter((c) => c.isAI).length}`);

// Print breakdowns for verification
const agentCheck = {};
for (const c of commits) {
    const a = c.isAI ? c.agent : 'Human';
    if (!agentCheck[a]) agentCheck[a] = { commits: 0, changes: 0 };
    agentCheck[a].commits++;
    agentCheck[a].changes += c.totalChanges;
}
console.log('\nAgent breakdown (code files only):');
for (const [name, s] of Object.entries(agentCheck).sort((a, b) => b[1].changes - a[1].changes)) {
    console.log(`  ${name}: ${s.commits} commits, ${s.changes.toLocaleString()} changes`);
}

const modelCheck = {};
for (const c of commits) {
    const m = c.model;
    if (!modelCheck[m]) modelCheck[m] = { commits: 0, changes: 0 };
    modelCheck[m].commits++;
    modelCheck[m].changes += c.totalChanges;
}
console.log('\nModel breakdown (code files only):');
for (const [name, s] of Object.entries(modelCheck).sort((a, b) => b[1].changes - a[1].changes)) {
    console.log(`  ${name}: ${s.commits} commits, ${s.changes.toLocaleString()} changes`);
}

writeFileSync(join(STATS_DIR, 'commits_data.json'), JSON.stringify(commits, null, 2));
console.log('\nCommits data saved.');

// ============================================================
// Chart 1: Weekly AI commit ratio
// ============================================================
console.log('Computing weekly AI commit ratios...');
function getWeekKey(dateStr) {
    const d = new Date(dateStr);
    const dayOfWeek = d.getUTCDay();
    const mondayDate = d.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), mondayDate));
    return monday.toISOString().slice(0, 10);
}

const weeklyData = {};
for (const c of commits) {
    const wk = getWeekKey(c.date);
    if (!weeklyData[wk]) weeklyData[wk] = { aiChanges: 0, totalChanges: 0 };
    if (c.isAI) weeklyData[wk].aiChanges += c.totalChanges;
    weeklyData[wk].totalChanges += c.totalChanges;
}

const weeklyKeys = Object.keys(weeklyData).sort();
const chart1Labels = [];
const chart1Values = [];
for (const wk of weeklyKeys) {
    const d = weeklyData[wk];
    chart1Labels.push(wk);
    chart1Values.push(d.totalChanges > 0 ? +((d.aiChanges / d.totalChanges) * 100).toFixed(1) : 0);
}

// ============================================================
// Chart 2: Git blame analysis (aligned with count_ai_code.py)
// ============================================================
console.log('Running git blame...');
const allFiles = run(`git ls-files`)
    .split('\n')
    .filter((f) => f.trim());
const fileList = allFiles.filter(isCodeFile);
console.log(`Files to blame: ${fileList.length} (filtered from ${allFiles.length})`);

const aiCommitSet = new Set(commits.filter((c) => c.isAI).map((c) => c.hash));
const commitDateMap = {};
for (const c of commits) commitDateMap[c.hash] = c.date;

const linesByWeek = {};
let blamedFiles = 0;
let totalBlameLines = 0,
    totalBlameAI = 0;

for (const file of fileList) {
    try {
        const blameOutput = run(`git blame --line-porcelain HEAD -- "${file}"`);
        if (!blameOutput) continue;

        let currentHash = null;
        for (const line of blameOutput.split('\n')) {
            if (/^[0-9a-f]{40}/.test(line)) {
                currentHash = line.split(' ')[0];
                continue;
            }
            if (line.startsWith('\t') && currentHash) {
                const content = line.substring(1);
                if (!content.trim()) {
                    currentHash = null;
                    continue;
                } // skip blanks
                const date = commitDateMap[currentHash];
                if (!date) {
                    currentHash = null;
                    continue;
                }
                const wk = getWeekKey(date);
                if (!linesByWeek[wk]) linesByWeek[wk] = { ai: 0, total: 0 };
                linesByWeek[wk].total++;
                totalBlameLines++;
                if (aiCommitSet.has(currentHash)) {
                    linesByWeek[wk].ai++;
                    totalBlameAI++;
                }
                currentHash = null;
            }
        }
        blamedFiles++;
        if (blamedFiles % 100 === 0) console.log(`  Blamed ${blamedFiles}/${fileList.length} files...`);
    } catch (e) {
        /* skip */
    }
}

console.log(`Blame lines (code only, no blanks): ${totalBlameLines}`);
console.log(
    `AI blame lines: ${totalBlameAI} (${totalBlameLines > 0 ? ((totalBlameAI / totalBlameLines) * 100).toFixed(1) : 0}%)`
);

// Generate week range
const firstDate = new Date(commits[0].date);
const lastDate = new Date();
const allWeeks = [];
{
    const d = new Date(firstDate);
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - dow + (dow === 0 ? -6 : 1));
    d.setUTCHours(0, 0, 0, 0);
    while (d <= lastDate) {
        allWeeks.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 7);
    }
}

let cumAI = 0,
    cumTotal = 0;
const chart2Labels = [],
    chart2Values = [];
const chart2bAIValues = [],
    chart2bTotalValues = [];
for (const wk of allWeeks) {
    if (linesByWeek[wk]) {
        cumAI += linesByWeek[wk].ai;
        cumTotal += linesByWeek[wk].total;
    }
    chart2Labels.push(wk);
    chart2Values.push(cumTotal > 0 ? +((cumAI / cumTotal) * 100).toFixed(1) : 0);
    chart2bAIValues.push(cumAI);
    chart2bTotalValues.push(cumTotal);
}

// ============================================================
// Chart 3: Agent/Model breakdown (code files only)
// ============================================================
console.log('Computing agent/model breakdown (code files only)...');
const agentStats = {};
const modelStats = {};

for (const c of commits) {
    const agent = c.isAI ? c.agent : 'Human';
    const model = c.isAI ? c.model : 'N/A';
    if (!agentStats[agent]) agentStats[agent] = { insertions: 0, deletions: 0, totalChanges: 0, commits: 0 };
    agentStats[agent].insertions += c.insertions;
    agentStats[agent].deletions += c.deletions;
    agentStats[agent].totalChanges += c.totalChanges;
    agentStats[agent].commits++;
    if (!modelStats[model]) modelStats[model] = { insertions: 0, deletions: 0, totalChanges: 0, commits: 0 };
    modelStats[model].insertions += c.insertions;
    modelStats[model].deletions += c.deletions;
    modelStats[model].totalChanges += c.totalChanges;
    modelStats[model].commits++;
}

// ============================================================
// Generate HTML (white theme)
// ============================================================
console.log('Generating HTML...');

const agentEntries = Object.entries(agentStats).sort((a, b) => b[1].totalChanges - a[1].totalChanges);
// Model chart: exclude Human (not applicable), Unknown already renamed to Unspecified
const modelEntries = Object.entries(modelStats)
    .filter(([name]) => name !== 'Human')
    .sort((a, b) => b[1].totalChanges - a[1].totalChanges);
const totalAllChanges = commits.reduce((s, c) => s + c.totalChanges, 0);
const totalAIChanges = commits.filter((c) => c.isAI).reduce((s, c) => s + c.totalChanges, 0);
const aiPct = totalAllChanges > 0 ? ((totalAIChanges / totalAllChanges) * 100).toFixed(1) : '0';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenDesk AI 代码统计</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
    <style>
        :root {
            --bg: #fafafa;
            --card-bg: #ffffff;
            --text: #1a1a2e;
            --text-secondary: #6b7280;
            --accent: #6c5ce7;
            --accent2: #00b894;
            --border: #e5e7eb;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Consolas', monospace;
            background: var(--bg);
            color: var(--text);
            padding: 32px 24px;
            min-height: 100vh;
        }
        h1 {
            text-align: center;
            font-size: 1.6rem;
            margin-bottom: 6px;
            color: var(--text);
            font-weight: 700;
            letter-spacing: 1px;
        }
        h1 span { color: var(--accent); }
        .subtitle {
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.78rem;
            margin-bottom: 28px;
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 14px;
            max-width: 1300px;
            margin: 0 auto 28px;
        }
        .stat-box {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 18px;
            text-align: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04);
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .stat-box:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(108,92,231,0.1); }
        .stat-box .num {
            font-size: 1.6rem;
            font-weight: 700;
            color: var(--accent);
            font-variant-numeric: tabular-nums;
        }
        .stat-box .label {
            font-size: 0.75rem;
            color: var(--text-secondary);
            margin-top: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 24px;
            max-width: 1300px;
            margin: 0 auto;
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 22px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        }
        .card h2 {
            font-size: 1rem;
            margin-bottom: 16px;
            color: var(--text);
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .card .chart-wrap {
            position: relative;
            width: 100%;
            height: 380px;
        }
        .card .chart-wrap canvas { width: 100% !important; height: 100% !important; }
        .pie-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
            max-width: 1300px;
            margin: 24px auto 0;
        }
        .pie-row .card .chart-wrap { height: 320px; }
        .legend-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 12px;
            font-size: 0.76rem;
        }
        .legend-table th {
            text-align: left;
            color: var(--text-secondary);
            padding: 5px 8px;
            border-bottom: 1px solid var(--border);
            font-weight: 500;
            font-size: 0.7rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .legend-table td {
            padding: 5px 8px;
            border-bottom: 1px solid var(--border);
        }
        .legend-table tr:hover { background: #f9fafb; }
        .legend-table .num { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
        .legend-table .pct { text-align: right; color: var(--accent); font-weight: 600; }
        .dot {
            display: inline-block;
            width: 10px; height: 10px;
            border-radius: 3px;
            margin-right: 8px;
            vertical-align: middle;
            flex-shrink: 0;
        }
        @media (max-width: 900px) {
            .pie-row, .summary { grid-template-columns: 1fr; }
            .stat-box .num { font-size: 1.3rem; }
        }
    </style>
</head>
<body>

<h1>OpenDesk <span>·</span> AI 代码贡献统计</h1>
<p class="subtitle">
    ${commits[0].date.slice(0, 10)} → ${commits[commits.length - 1].date.slice(0, 10)}  ·
    ${commits.length} commits  ·
    ${commits.filter((c) => c.isAI).length} AI-generated  ·
    仅统计代码文件（${CODE_FILE_EXTS.size} 种扩展名）
</p>

<div class="summary">
    <div class="stat-box">
        <div class="num">${commits.length}</div>
        <div class="label">Total Commits</div>
    </div>
    <div class="stat-box">
        <div class="num">${commits.filter((c) => c.isAI).length}</div>
        <div class="label">AI Commits</div>
    </div>
    <div class="stat-box">
        <div class="num">${totalAllChanges.toLocaleString()}</div>
        <div class="label">Changed Lines (code files)</div>
    </div>
    <div class="stat-box">
        <div class="num">${aiPct}%</div>
        <div class="label">AI Line Share</div>
    </div>
</div>

<div class="grid">
    <div class="card">
        <h2>📈 每周 AI 提交变更行数占比<span style="font-weight:400;font-size:0.75rem;color:var(--text-secondary);margin-left:4px;">（代码文件 insertions+deletions）</span></h2>
        <div class="chart-wrap"><canvas id="chart1"></canvas></div>
    </div>
    <div class="card">
        <h2>📊 每周 AI 代码行存量占比<span style="font-weight:400;font-size:0.75rem;color:var(--text-secondary);margin-left:4px;">（git blame，排除空行）</span></h2>
        <div class="chart-wrap"><canvas id="chart2"></canvas></div>
    </div>
    <div class="card">
        <h2>📉 每周代码行数变化<span style="font-weight:400;font-size:0.75rem;color:var(--text-secondary);margin-left:4px;">（AI 行数 vs 总行数，累积）</span></h2>
        <div class="chart-wrap"><canvas id="chart2b"></canvas></div>
    </div>
</div>

<div class="pie-row">
    <div class="card">
        <h2>🤖 Agent 变更行数占比<span style="font-weight:400;font-size:0.75rem;color:var(--text-secondary);margin-left:4px;">（代码文件）</span></h2>
        <div class="chart-wrap"><canvas id="chart3agent"></canvas></div>
        <table class="legend-table">
            <thead><tr><th>Agent</th><th class="num">Commits</th><th class="num">Lines</th><th class="pct">Share</th></tr></thead>
            <tbody id="agentLegend"></tbody>
        </table>
    </div>
    <div class="card">
        <h2>🧠 Model 变更行数占比<span style="font-weight:400;font-size:0.75rem;color:var(--text-secondary);margin-left:4px;">（代码文件）</span></h2>
        <div class="chart-wrap"><canvas id="chart3model"></canvas></div>
        <table class="legend-table">
            <thead><tr><th>Model</th><th class="num">Commits</th><th class="num">Lines</th><th class="pct">Share</th></tr></thead>
            <tbody id="modelLegend"></tbody>
        </table>
    </div>
</div>

<script>
// ========== Chart 1: Weekly AI commit line ratio ==========
new Chart(document.getElementById('chart1'), {
    type: 'line',
    data: {
        labels: ${JSON.stringify(chart1Labels)},
        datasets: [{
            label: 'AI 占比',
            data: ${JSON.stringify(chart1Values)},
            borderColor: '#6c5ce7',
            backgroundColor: 'rgba(108, 92, 231, 0.08)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#6c5ce7',
            borderWidth: 2
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#fff',
                borderColor: '#e5e7eb',
                borderWidth: 1,
                titleColor: '#1a1a2e',
                bodyColor: '#1a1a2e',
                callbacks: { label: ctx => 'AI 占比: ' + ctx.parsed.y.toFixed(1) + '%' }
            }
        },
        scales: {
            x: {
                ticks: { color: '#9ca3af', maxTicksLimit: 18, font: { size: 9 } },
                grid: { color: '#f3f4f6' }
            },
            y: {
                ticks: { color: '#9ca3af', callback: v => v + '%', font: { size: 9 } },
                grid: { color: '#f3f4f6' }, min: 0, max: 100
            }
        },
        interaction: { intersect: false, mode: 'index' }
    }
});

// ========== Chart 2: Weekly blame proportion ==========
new Chart(document.getElementById('chart2'), {
    type: 'line',
    data: {
        labels: ${JSON.stringify(chart2Labels)},
        datasets: [{
            label: 'AI 代码占比',
            data: ${JSON.stringify(chart2Values)},
            borderColor: '#00b894',
            backgroundColor: 'rgba(0, 184, 148, 0.08)',
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#00b894',
            borderWidth: 2
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#fff',
                borderColor: '#e5e7eb',
                borderWidth: 1,
                titleColor: '#1a1a2e',
                bodyColor: '#1a1a2e',
                callbacks: { label: ctx => 'AI 代码占比: ' + ctx.parsed.y.toFixed(1) + '%' }
            }
        },
        scales: {
            x: {
                ticks: { color: '#9ca3af', maxTicksLimit: 18, font: { size: 9 } },
                grid: { color: '#f3f4f6' }
            },
            y: {
                ticks: { color: '#9ca3af', callback: v => v + '%', font: { size: 9 } },
                grid: { color: '#f3f4f6' }, min: 0, max: 100
            }
        },
        interaction: { intersect: false, mode: 'index' }
    }
});

// ========== Chart 2b: Weekly code line counts (AI vs Total) ==========
new Chart(document.getElementById('chart2b'), {
    type: 'line',
    data: {
        labels: ${JSON.stringify(chart2Labels)},
        datasets: [
            {
                label: '总行数',
                data: ${JSON.stringify(chart2bTotalValues)},
                borderColor: '#6c5ce7',
                backgroundColor: 'rgba(108, 92, 231, 0.06)',
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderWidth: 2,
                yAxisID: 'y'
            },
            {
                label: 'AI 行数',
                data: ${JSON.stringify(chart2bAIValues)},
                borderColor: '#00b894',
                backgroundColor: 'rgba(0, 184, 148, 0.06)',
                fill: true,
                tension: 0.35,
                pointRadius: 0,
                pointHoverRadius: 4,
                borderWidth: 2,
                yAxisID: 'y'
            }
        ]
    },
    options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: {
                    color: '#1a1a2e',
                    font: { size: 11, family: "'JetBrains Mono', monospace" },
                    usePointStyle: true,
                    pointStyleWidth: 8
                }
            },
            tooltip: {
                backgroundColor: '#fff',
                borderColor: '#e5e7eb',
                borderWidth: 1,
                titleColor: '#1a1a2e',
                bodyColor: '#1a1a2e',
                callbacks: {
                    label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' 行'
                }
            }
        },
        scales: {
            x: {
                ticks: { color: '#9ca3af', maxTicksLimit: 18, font: { size: 9 } },
                grid: { color: '#f3f4f6' }
            },
            y: {
                type: 'linear',
                display: true,
                position: 'left',
                ticks: {
                    color: '#9ca3af',
                    callback: v => (v / 1000).toFixed(0) + 'K',
                    font: { size: 9 }
                },
                grid: { color: '#f3f4f6' }
            }
        },
        interaction: { intersect: false, mode: 'index' }
    }
});

// ========== Chart 3: Pie charts ==========
const colors = [
    '#6c5ce7', '#00b894', '#e17055', '#fdcb6e', '#74b9ff',
    '#a29bfe', '#fd79a8', '#00cec9', '#55efc4', '#fab1a0',
    '#81ecec', '#dfe6e9', '#ffeaa7', '#636e72', '#d63031',
    '#0984e3', '#6c5ce7', '#00b894', '#e17055', '#fdcb6e',
    '#a29bfe', '#81ecec', '#fd79a8', '#ffeaa7', '#636e72'
];

const agentEntries = ${JSON.stringify(agentEntries)};
const modelEntries = ${JSON.stringify(modelEntries)};
const totalAgentChanges = agentEntries.reduce((s, e) => s + e[1].totalChanges, 0);
const totalModelChanges = modelEntries.reduce((s, e) => s + e[1].totalChanges, 0);

// Agent doughnut
new Chart(document.getElementById('chart3agent'), {
    type: 'doughnut',
    data: {
        labels: agentEntries.map(e => e[0]),
        datasets: [{
            data: agentEntries.map(e => e[1].totalChanges),
            backgroundColor: colors.slice(0, agentEntries.length),
            borderColor: '#ffffff',
            borderWidth: 2
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#fff',
                borderColor: '#e5e7eb',
                borderWidth: 1,
                titleColor: '#1a1a2e',
                bodyColor: '#1a1a2e',
                callbacks: {
                    label: ctx => {
                        const pct = (ctx.parsed / totalAgentChanges * 100).toFixed(1);
                        return ' ' + ctx.label + ': ' + pct + '%';
                    }
                }
            }
        }
    }
});

// Model doughnut
new Chart(document.getElementById('chart3model'), {
    type: 'doughnut',
    data: {
        labels: modelEntries.map(e => e[0]),
        datasets: [{
            data: modelEntries.map(e => e[1].totalChanges),
            backgroundColor: colors.slice(0, modelEntries.length),
            borderColor: '#ffffff',
            borderWidth: 2
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#fff',
                borderColor: '#e5e7eb',
                borderWidth: 1,
                titleColor: '#1a1a2e',
                bodyColor: '#1a1a2e',
                callbacks: {
                    label: ctx => {
                        const pct = (ctx.parsed / totalModelChanges * 100).toFixed(1);
                        return ' ' + ctx.label + ': ' + pct + '%';
                    }
                }
            }
        }
    }
});

// Legends
const agentLegend = document.getElementById('agentLegend');
agentEntries.forEach(([name, stats], i) => {
    const pct = (stats.totalChanges / totalAgentChanges * 100).toFixed(1);
    agentLegend.innerHTML += \`<tr>
        <td><span class="dot" style="background:\${colors[i]}"></span>\${name}</td>
        <td class="num">\${stats.commits}</td>
        <td class="num">\${stats.totalChanges.toLocaleString()}</td>
        <td class="pct">\${pct}%</td></tr>\`;
});

const modelLegend = document.getElementById('modelLegend');
modelEntries.forEach(([name, stats], i) => {
    const pct = (stats.totalChanges / totalModelChanges * 100).toFixed(1);
    modelLegend.innerHTML += \`<tr>
        <td><span class="dot" style="background:\${colors[i]}"></span>\${name}</td>
        <td class="num">\${stats.commits}</td>
        <td class="num">\${stats.totalChanges.toLocaleString()}</td>
        <td class="pct">\${pct}%</td></tr>\`;
});
</script>

</body>
</html>`;

writeFileSync(join(STATS_DIR, 'ai_code_stats.html'), html);
console.log('HTML saved: stats/ai_code_stats.html');
console.log('Done!');
