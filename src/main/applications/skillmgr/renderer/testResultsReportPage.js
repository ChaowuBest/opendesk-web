/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { escapeHtml } from '../../../../common/utils/escape.js';

export const TEST_RESULTS_REPORT_MODAL_CLASS = 'test-report-modal-dialog';

const FAILURE_REASON_LABELS = {
    misconfigured: '未正确配置',
    dependency_runtime: '依赖与运行时问题',
    input_data: '输入数据问题',
    external_service: '外部服务问题',
    skill_implementation: 'Skill 实现问题',
    uncategorized: '未分类'
};

const FAILURE_REASON_DESCRIPTIONS = {
    misconfigured: '运行环境不满足前置条件，如缺少环境变量',
    dependency_runtime: '需要的库、命令或运行时不可用',
    input_data: '测试输入、样例数据或前置数据不符合预期',
    external_service: '外部服务问题，如网络、模型服务不可用',
    skill_implementation: '满足测试运行的前置条件，失败来自 skill 能力实现缺陷，如边界情况未处理',
    uncategorized: '未分类。'
};

const PASS_RATE_BUCKETS = [
    { id: 'eq0', label: '0%', test: (rate) => rate === 0 },
    { id: '0-20', label: '(0%, 20%]', test: (rate) => rate > 0 && rate <= 20 },
    { id: '20-40', label: '(20%, 40%]', test: (rate) => rate > 20 && rate <= 40 },
    { id: '40-60', label: '(40%, 60%]', test: (rate) => rate > 40 && rate <= 60 },
    { id: '60-80', label: '(60%, 80%]', test: (rate) => rate > 60 && rate <= 80 },
    { id: '80-100', label: '(80%, 100%)', test: (rate) => rate > 80 && rate < 100 },
    { id: 'eq100', label: '100%', test: (rate) => rate === 100 }
];

const FAILURE_COLORS = ['#ff4d4f', '#fa8c16', '#faad14', '#722ed1', '#13c2c2', '#8c8c8c'];

export const TEST_RESULTS_REPORT_STYLE = `
    /* ── Test report modal ── */
    .analyze-modal-dialog.test-report-modal-dialog {
        width: min(790px, calc(100vw - 64px)); max-width: calc(100vw - 64px);
        max-height: min(820px, calc(100vh - 64px)); border-radius: 8px;
    }
    .analyze-modal-dialog.test-report-modal-dialog .analyze-modal-header {
        padding: 18px 24px 14px;
    }
    .analyze-modal-dialog.test-report-modal-dialog .analyze-modal-header h3 {
        font-size: 18px; line-height: 26px;
    }
    .analyze-modal-dialog.test-report-modal-dialog .analyze-modal-close {
        border-radius: 6px; background: transparent;
    }
    .analyze-modal-dialog.test-report-modal-dialog .analyze-modal-body {
        padding: 18px 24px 24px; background: #fbfbfb;
    }
    .test-report-content {
        min-width: 0; color: rgba(0,0,0,0.88); font-size: 12px;
    }
    .test-report-subtitle {
        margin: 0 0 16px; color: rgba(0,0,0,0.45); font-size: 12px; line-height: 1.5;
    }
    .test-report-stat-grid {
        display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px; margin-bottom: 16px;
    }
    .test-report-card {
        background: #fff; border: 1px solid #f0f0f0; border-radius: 8px;
    }
    .test-report-stat-card {
        padding: 14px 16px;
    }
    .test-report-stat-label {
        color: rgba(0,0,0,0.45); font-size: 12px;
    }
    .test-report-stat-value {
        margin-top: 6px; font-size: 24px; line-height: 32px; font-weight: 600;
        font-variant-numeric: tabular-nums;
    }
    .test-report-stat-extra {
        margin-top: 4px; color: rgba(0,0,0,0.45); font-size: 11px; line-height: 1.4;
    }
    .test-report-main-grid {
        display: grid; grid-template-columns: minmax(240px, 0.9fr) minmax(0, 1.1fr);
        gap: 16px; align-items: start;
    }
    .test-report-section {
        overflow: visible;
    }
    .test-report-section-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; padding: 14px 16px; border-bottom: 1px solid #f0f0f0;
    }
    .test-report-section-title {
        font-size: 14px; font-weight: 600; color: rgba(0,0,0,0.88);
    }
    .test-report-section-subtitle {
        margin-top: 2px; color: rgba(0,0,0,0.45); font-size: 11px; line-height: 1.4;
    }
    .test-report-section-body {
        padding: 14px 16px 16px;
    }
    .test-report-threshold-list {
        display: flex; flex-direction: column; gap: 10px;
    }
    .test-report-threshold-item {
        padding: 12px; border: 1px solid #f0f0f0; border-radius: 8px; background: #fff;
    }
    .test-report-threshold-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .test-report-threshold-title {
        font-weight: 600; color: rgba(0,0,0,0.88);
    }
    .test-report-threshold-count {
        color: #1677ff; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .test-report-threshold-names {
        display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px;
    }
    .test-report-tag {
        display: inline-flex; align-items: center; justify-content: center;
        min-height: 22px; max-width: 100%; padding: 0 8px;
        border-radius: 4px; font-size: 11px; line-height: 20px;
        border: 1px solid; white-space: nowrap;
    }
    .test-report-tag-success {
        color: #389e0d; background: #f6ffed; border-color: #b7eb8f;
    }
    .test-report-tag-warning {
        color: #d48806; background: #fffbe6; border-color: #ffe58f;
    }
    .test-report-tag-error {
        color: #cf1322; background: #fff1f0; border-color: #ffa39e;
    }
    .test-report-tag-blue {
        color: #0958d9; background: #e6f4ff; border-color: #91caff;
    }
    .test-report-tag-gray {
        color: rgba(0,0,0,0.65); background: #fafafa; border-color: #d9d9d9;
    }
    .test-report-summary-row {
        display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px;
    }
    .test-report-pie-card {
        padding: 14px; border: 1px solid #f0f0f0; border-radius: 8px; background: #fff;
    }
    .test-report-pie-title {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 8px; color: rgba(0,0,0,0.65); font-size: 12px;
    }
    .test-report-pie-content {
        display: grid; grid-template-columns: 96px minmax(0, 1fr);
        align-items: center; gap: 12px;
    }
    .test-report-pie-chart {
        width: 96px; aspect-ratio: 1; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.04);
    }
    .test-report-pie-center {
        width: 58px; aspect-ratio: 1; border-radius: 50%;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.04);
    }
    .test-report-pie-center-value {
        font-size: 15px; line-height: 19px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .test-report-pie-center-label {
        margin-top: 2px; color: rgba(0,0,0,0.45); font-size: 11px;
    }
    .test-report-pie-legend {
        min-width: 0; display: flex; flex-direction: column; gap: 7px;
    }
    .test-report-pie-legend-item {
        position: relative; display: flex; align-items: center; gap: 7px; min-width: 0;
        color: rgba(0,0,0,0.65); font-size: 11px;
    }
    .test-report-pie-legend-item[data-tooltip] {
        cursor: help;
    }
    .test-report-pie-legend-item[data-tooltip]::after {
        content: attr(data-tooltip); position: absolute; left: 0; bottom: calc(100% + 6px);
        width: max-content; max-width: 260px; padding: 7px 9px; border-radius: 6px;
        color: #fff; background: rgba(0,0,0,0.82); font-size: 11px; line-height: 1.45;
        white-space: normal; box-shadow: 0 6px 16px rgba(0,0,0,0.16);
        opacity: 0; pointer-events: none; transform: translateY(4px);
        transition: opacity 0.12s ease, transform 0.12s ease; z-index: 2;
    }
    .test-report-pie-legend-item[data-tooltip]:hover::after {
        opacity: 1; transform: translateY(0);
    }
    .test-report-pie-legend-dot {
        width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .test-report-pie-legend-label {
        min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .test-report-pie-legend-value {
        flex-shrink: 0; color: rgba(0,0,0,0.88); font-variant-numeric: tabular-nums;
    }
    .test-report-muted,
    .test-report-empty {
        color: rgba(0,0,0,0.45);
    }
    .test-report-empty {
        padding: 18px 0; text-align: center; font-size: 13px;
    }
`;

function pct(value, total) {
    if (!total) return 0;
    return Math.round((value / total) * 1000) / 10;
}

function getSkillStats(testCases) {
    const cases = Array.isArray(testCases) ? testCases : [];
    const passed = cases.filter((tc) => tc?.status === 'passed').length;
    const failed = cases.filter((tc) => tc?.status === 'failed').length;
    const skipped = cases.filter((tc) => tc?.status === 'skipped').length;
    const pending = cases.filter((tc) => tc?.status === 'pending').length;
    const total = passed + failed;

    return {
        total,
        passed,
        failed,
        skipped,
        pending,
        passRate: pct(passed, total)
    };
}

function getRateTagClass(passRate) {
    if (passRate === 100) return 'test-report-tag-success';
    if (passRate >= 80) return 'test-report-tag-blue';
    if (passRate >= 40) return 'test-report-tag-warning';
    return 'test-report-tag-error';
}

function renderPieCard({ title, centerValue, centerLabel, items }) {
    const visibleItems = items.filter((item) => item.value > 0);
    const totalValue = visibleItems.reduce((sum, item) => sum + item.value, 0);
    let cursor = 0;
    const gradient =
        totalValue > 0
            ? visibleItems
                  .map((item) => {
                      const start = cursor;
                      cursor += (item.value / totalValue) * 100;
                      return `${item.color} ${start}% ${cursor}%`;
                  })
                  .join(', ')
            : '#f0f0f0 0% 100%';

    return `
        <div class="test-report-pie-card">
            <div class="test-report-pie-title">
                <span>${escapeHtml(title)}</span>
                <strong>${totalValue} 个</strong>
            </div>
            <div class="test-report-pie-content">
                <div class="test-report-pie-chart" style="background: conic-gradient(${gradient});">
                    <div class="test-report-pie-center">
                        <div class="test-report-pie-center-value">${escapeHtml(String(centerValue))}</div>
                        <div class="test-report-pie-center-label">${escapeHtml(centerLabel)}</div>
                    </div>
                </div>
                <div class="test-report-pie-legend">
                    ${
                        visibleItems.length
                            ? visibleItems
                                  .map((item) => {
                                      const description = item.description || '';
                                      const tooltipAttrs = description
                                          ? ` data-tooltip="${escapeHtml(description)}" aria-label="${escapeHtml(`${item.label}：${description}`)}"`
                                          : '';
                                      return `
                                          <div class="test-report-pie-legend-item"${tooltipAttrs}>
                                              <span class="test-report-pie-legend-dot" style="background:${item.color}"></span>
                                              <span class="test-report-pie-legend-label">${escapeHtml(item.label)}</span>
                                              <span class="test-report-pie-legend-value">${item.value} / ${pct(item.value, totalValue)}%</span>
                                          </div>
                                      `;
                                  })
                                  .join('')
                            : '<span class="test-report-muted">暂无数据</span>'
                    }
                </div>
            </div>
        </div>
    `;
}

function buildReportModel({ skillIds, skills, results }) {
    const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
    const skillRows = [];
    let unrunSkillCount = 0;
    let excludedSkillCount = 0;

    for (const skillId of skillIds) {
        const testCases = results?.[skillId]?.testCases;
        if (!Array.isArray(testCases) || testCases.length === 0) {
            excludedSkillCount++;
            continue;
        }

        const stats = getSkillStats(testCases);
        if (stats.total === 0) {
            if (stats.pending > 0 || stats.skipped > 0) {
                unrunSkillCount++;
            } else {
                excludedSkillCount++;
            }
            continue;
        }

        const skill = skillMap.get(skillId);
        skillRows.push({
            id: skillId,
            name: skill?.name || skillId,
            description: skill?.description || '',
            testCases,
            stats
        });
    }

    return {
        selectedCount: skillIds.length,
        skillRows,
        unrunSkillCount,
        excludedSkillCount,
        hasTestInfo: skillRows.length > 0 || unrunSkillCount > 0,
        hasRunResults: skillRows.length > 0
    };
}

function renderSelectedExtra(model) {
    if (
        model.selectedCount === model.skillRows.length &&
        model.unrunSkillCount === 0 &&
        model.excludedSkillCount === 0
    ) {
        return '全部已纳入本次统计';
    }

    const parts = [`从 ${model.selectedCount} 个选中项中筛选有运行结果项`];
    if (model.unrunSkillCount > 0) {
        parts.push(`${model.unrunSkillCount} 个已生成未运行`);
    }
    if (model.excludedSkillCount > 0) {
        parts.push(`${model.excludedSkillCount} 个无测试信息已排除`);
    }
    return parts.join('，');
}

function renderReport(model) {
    const { skillRows } = model;
    const total = skillRows.reduce((sum, skill) => sum + skill.stats.total, 0);
    const passed = skillRows.reduce((sum, skill) => sum + skill.stats.passed, 0);
    const failed = skillRows.reduce((sum, skill) => sum + skill.stats.failed, 0);
    const skipped = skillRows.reduce((sum, skill) => sum + skill.stats.skipped, 0);
    const pending = skillRows.reduce((sum, skill) => sum + skill.stats.pending, 0);
    const passRate = pct(passed, total);
    const failureBuckets = {};

    for (const skill of skillRows) {
        for (const testCase of skill.testCases) {
            if (testCase?.status !== 'failed') continue;
            const key = testCase.failureReasonCategory || 'uncategorized';
            failureBuckets[key] = (failureBuckets[key] || 0) + 1;
        }
    }

    const bucketRows = PASS_RATE_BUCKETS.map((bucket) => ({
        ...bucket,
        matched: skillRows.filter((skill) => bucket.test(skill.stats.passRate))
    })).filter((row) => row.matched.length > 0);
    const failureRows = Object.entries(failureBuckets)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({
            key,
            label: FAILURE_REASON_LABELS[key] || key,
            count
        }));
    const resultPieHtml = renderPieCard({
        title: '运行结果分布',
        centerValue: `${passRate}%`,
        centerLabel: '成功率',
        items: [
            { label: '通过', value: passed, color: '#52c41a' },
            { label: '失败', value: failed, color: '#ff4d4f' }
        ]
    });
    const failurePieHtml = renderPieCard({
        title: '失败原因分布',
        centerValue: failed,
        centerLabel: '失败用例',
        items: failureRows.map((row, index) => ({
            label: row.label,
            description: FAILURE_REASON_DESCRIPTIONS[row.key] || '未提供该失败原因分类的说明。',
            value: row.count,
            color: row.key === 'uncategorized' ? '#8c8c8c' : FAILURE_COLORS[index % FAILURE_COLORS.length]
        }))
    });
    const skippedPendingText =
        skipped > 0 || pending > 0
            ? `另有 ${skipped} 条 skipped${pending > 0 ? ` / ${pending} 条未运行` : ''}`
            : '无 skipped / 未运行用例';

    return `
        <div class="test-report-content">
            <p class="test-report-subtitle">当前选中 ${model.selectedCount} 个 skills，其中 ${skillRows.length} 个有测试运行结果，${model.unrunSkillCount} 个有测试信息但未运行；统计口径不包含 skipped 和未运行用例。</p>
            <div class="test-report-stat-grid">
                <div class="test-report-card test-report-stat-card">
                    <div class="test-report-stat-label">选中 Skills</div>
                    <div class="test-report-stat-value">${skillRows.length}</div>
                    <div class="test-report-stat-extra">${escapeHtml(renderSelectedExtra(model))}</div>
                </div>
                <div class="test-report-card test-report-stat-card">
                    <div class="test-report-stat-label">运行测试用例</div>
                    <div class="test-report-stat-value">${total}</div>
                    <div class="test-report-stat-extra">${escapeHtml(skippedPendingText)}</div>
                </div>
                <div class="test-report-card test-report-stat-card">
                    <div class="test-report-stat-label">整体成功率</div>
                    <div class="test-report-stat-value">${passRate}%</div>
                    <div class="test-report-stat-extra">${passed} 通过 / ${failed} 失败</div>
                </div>
            </div>

            <div class="test-report-main-grid">
                <section class="test-report-card test-report-section">
                    <div class="test-report-section-header">
                        <div>
                            <div class="test-report-section-title">通过率分层</div>
                            <div class="test-report-section-subtitle">仅显示有 skill 命中的互斥区间；每层最多显示 3 个</div>
                        </div>
                    </div>
                    <div class="test-report-section-body">
                        <div class="test-report-threshold-list">
                            ${
                                bucketRows.length
                                    ? bucketRows
                                          .map(
                                              (row) => `
                                                  <div class="test-report-threshold-item">
                                                      <div class="test-report-threshold-head">
                                                          <span class="test-report-threshold-title">通过率 ${escapeHtml(row.label)}</span>
                                                          <span class="test-report-threshold-count">${row.matched.length}</span>
                                                      </div>
                                                      <div class="test-report-threshold-names">
                                                          ${row.matched
                                                              .slice(0, 3)
                                                              .map(
                                                                  (skill) =>
                                                                      `<span class="test-report-tag ${getRateTagClass(skill.stats.passRate)}">${escapeHtml(skill.name)} ${skill.stats.passRate}%</span>`
                                                              )
                                                              .join('')}
                                                          ${row.matched.length > 3 ? `<span class="test-report-tag test-report-tag-gray">+${row.matched.length - 3}</span>` : ''}
                                                      </div>
                                                  </div>
                                              `
                                          )
                                          .join('')
                                    : '<div class="test-report-empty">暂无运行结果</div>'
                            }
                        </div>
                    </div>
                </section>

                <section class="test-report-card test-report-section">
                    <div class="test-report-section-header">
                        <div>
                            <div class="test-report-section-title">整体测试用例统计</div>
                        </div>
                    </div>
                    <div class="test-report-section-body">
                        <div class="test-report-summary-row">
                            ${resultPieHtml}
                            ${failurePieHtml}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    `;
}

export function buildSelectedSkillTestReportPage({ skillIds, skills, results }) {
    const model = buildReportModel({ skillIds, skills, results });
    return {
        hasTestInfo: model.hasTestInfo,
        hasRunResults: model.hasRunResults,
        html: model.hasTestInfo ? renderReport(model) : ''
    };
}
