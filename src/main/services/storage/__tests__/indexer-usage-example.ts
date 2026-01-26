/**
 * Storage Indexer 使用样例 - RAG 场景构建指南
 *
 * 本文件展示如何利用查询解释器（Indexer）构建自定义 RAG 场景。
 * 包含完整的端到端流程：从创建数据库、插入数据、单点查询到多索引器组合查询。
 *
 * 运行方式：
 * npx tsx src/main/services/storage/__tests__/indexer-usage-example.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';

// 导入所有 Indexer 和相关类型
import {
    BaseStorage,
    BaseIndexer,
    Item,
    ItemType,
    FilterCondition,
    ColumnSchema,
    SearchItem,
    VectorQuery,
} from '../object.js';
import { TagIndexer } from '../tag-indexer.js';
import { VectorIndexer } from '../vector-indexer.js';
import { BM25Indexer } from '../bm25-indexer.js';

// ============================================================================
// 工具函数
// ============================================================================

const SEPARATOR = '='.repeat(80);
const SUB_SEPARATOR = '-'.repeat(80);

function printHeader(title: string): void {
    console.log('\n' + SEPARATOR);
    console.log(`                    ${title}`);
    console.log(SEPARATOR);
}

function printSection(title: string): void {
    console.log('\n' + SUB_SEPARATOR);
    console.log(`[${title}]`);
    console.log(SUB_SEPARATOR);
}

function printSubSection(title: string): void {
    console.log(`\n>>> ${title}`);
}

function printResult(label: string, value: any): void {
    console.log(`  ${label}: ${JSON.stringify(value, null, 2)}`);
}

function printSuccess(message: string): void {
    console.log(`✓ ${message}`);
}

function printInfo(message: string): void {
    console.log(`  ${message}`);
}

function printSearchResults(results: Item[] | SearchItem[], showScore = false): void {
    if (results.length === 0) {
        console.log('  (无结果)');
        return;
    }
    results.forEach((r, i) => {
        const item = 'item' in r ? r.item : r;
        const scoreInfo = showScore && 'BM25Score' in r ? ` (BM25: ${(r as SearchItem).BM25Score?.toFixed(4)})` : '';
        const vecScoreInfo = showScore && 'VecScore' in r ? ` (Vec: ${(r as SearchItem).VecScore?.toFixed(4)})` : '';
        const title = item.mail_title || item.filename || item.text?.substring(0, 30) + '...';
        console.log(`  ${i + 1}. [${item.item_id}] ${title} [${item.tag}]${scoreInfo}${vecScoreInfo}`);
    });
}

// ============================================================================
// Part 1: 环境准备与数据模型定义
// ============================================================================

// 测试数据目录
const TEST_DIR = path.join(os.tmpdir(), `indexer-example-${Date.now()}`);

// 创建测试目录
function setupTestDirectory(): void {
    if (!fs.existsSync(TEST_DIR)) {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    printSuccess(`创建测试目录: ${TEST_DIR}`);
}

// 清理测试目录
function cleanupTestDirectory(): void {
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    printSuccess('清理测试目录完成');
}

// ColumnSchema 定义 - 支持文件、邮件、记忆三种类型
const SCHEMA: ColumnSchema = {
    columns: {
        // 核心字段
        'item_id': 'TEXT PRIMARY KEY',
        'item_type': 'TEXT NOT NULL',

        // 文件场景
        'filename': 'TEXT',
        'file_path': 'TEXT',
        'file_ext': 'TEXT',
        'size': 'INTEGER DEFAULT 0',
        'owner': 'TEXT',
        'creator': 'TEXT',
        'modifier': 'TEXT',

        // 邮件场景
        'mail_title': 'TEXT',
        'mail_ctx': 'TEXT',
        'mail_from': 'TEXT',
        'mail_to': 'TEXT',
        'mail_cc': 'TEXT',
        'mail_date': 'INTEGER',
        'sender': 'TEXT',
        'attachment_title': 'TEXT',
        'attachment_ctx': 'TEXT',

        // 通用元数据
        'tag': 'TEXT',
        'text': 'TEXT',
        'category': 'TEXT',
        'created_at': 'INTEGER',
        'updated_at': 'INTEGER',
    },
    needIndexers: {
        'tag': ['TagIndexer'],
        'text': ['BM25Indexer'],
        'filename': ['BaseIndexer'],
        'mail_from': ['BaseIndexer'],
        'mail_to': ['BaseIndexer'],
        'owner': ['BaseIndexer'],
    }
};

// ============================================================================
// 测试数据定义
// ============================================================================

// 文件数据（10 条）
const FILE_DATA: Item[] = [
    {
        item_id: 'file_001', item_type: 'file' as ItemType,
        filename: 'Q4_财务报告.pdf', file_path: '/docs/finance/Q4_财务报告.pdf', file_ext: 'pdf',
        size: 2048000, owner: 'alice', creator: 'alice', modifier: 'bob',
        tag: 'important,finance', category: 'finance',
        text: '2024年第四季度财务报告，包含收入分析、成本核算、利润预测等内容。本季度总收入达到1500万元，同比增长15%。',
        created_at: 1703001600000, updated_at: 1703088000000,
    },
    {
        item_id: 'file_002', item_type: 'file' as ItemType,
        filename: '项目会议纪要.docx', file_path: '/docs/meetings/项目会议纪要.docx', file_ext: 'docx',
        size: 512000, owner: 'bob', creator: 'bob', modifier: 'bob',
        tag: 'work,meeting', category: 'meeting',
        text: '2024年1月项目启动会议纪要。讨论了项目目标、时间节点、资源分配等关键议题。',
        created_at: 1704211200000, updated_at: 1704211200000,
    },
    {
        item_id: 'file_003', item_type: 'file' as ItemType,
        filename: '产品需求文档.pdf', file_path: '/docs/product/PRD_v2.pdf', file_ext: 'pdf',
        size: 1024000, owner: 'charlie', creator: 'alice', modifier: 'charlie',
        tag: 'important,product', category: 'product',
        text: '产品需求文档第二版，包含用户故事、功能规格、UI设计稿等。新增了AI助手功能模块。',
        created_at: 1704297600000, updated_at: 1704384000000,
    },
    {
        item_id: 'file_004', item_type: 'file' as ItemType,
        filename: '技术架构设计.md', file_path: '/docs/tech/architecture.md', file_ext: 'md',
        size: 256000, owner: 'david', creator: 'david', modifier: 'david',
        tag: 'tech,architecture', category: 'tech',
        text: '系统技术架构设计文档，采用微服务架构，包含API网关、用户服务、文件服务等模块。',
        created_at: 1704470400000, updated_at: 1704556800000,
    },
    {
        item_id: 'file_005', item_type: 'file' as ItemType,
        filename: '2024预算表.xlsx', file_path: '/docs/finance/Budget_2024.xlsx', file_ext: 'xlsx',
        size: 768000, owner: 'alice', creator: 'alice', modifier: 'alice',
        tag: 'important,budget,finance', category: 'finance',
        text: '2024年度预算规划表，包含各部门预算分配、季度目标、KPI指标等。总预算5000万元。',
        created_at: 1704643200000, updated_at: 1704729600000,
    },
    {
        item_id: 'file_006', item_type: 'file' as ItemType,
        filename: '员工手册.pdf', file_path: '/docs/hr/员工手册.pdf', file_ext: 'pdf',
        size: 3072000, owner: 'hr_admin', creator: 'hr_admin', modifier: 'hr_admin',
        tag: 'hr,policy', category: 'hr',
        text: '公司员工手册，包含入职流程、考勤制度、福利政策、行为规范等内容。',
        created_at: 1704816000000, updated_at: 1704816000000,
    },
    {
        item_id: 'file_007', item_type: 'file' as ItemType,
        filename: 'API接口文档.md', file_path: '/docs/tech/api_docs.md', file_ext: 'md',
        size: 384000, owner: 'david', creator: 'charlie', modifier: 'david',
        tag: 'tech,api', category: 'tech',
        text: 'RESTful API接口文档，包含用户认证、文件上传、搜索查询等接口说明。',
        created_at: 1704902400000, updated_at: 1704988800000,
    },
    {
        item_id: 'file_008', item_type: 'file' as ItemType,
        filename: '市场分析报告.pptx', file_path: '/docs/marketing/市场分析.pptx', file_ext: 'pptx',
        size: 5120000, owner: 'eve', creator: 'eve', modifier: 'eve',
        tag: 'marketing,analysis', category: 'marketing',
        text: '2024年Q1市场分析报告，包含竞品分析、用户画像、市场趋势预测等内容。',
        created_at: 1705075200000, updated_at: 1705161600000,
    },
    {
        item_id: 'file_009', item_type: 'file' as ItemType,
        filename: '测试用例集.xlsx', file_path: '/docs/qa/测试用例.xlsx', file_ext: 'xlsx',
        size: 640000, owner: 'frank', creator: 'frank', modifier: 'frank',
        tag: 'qa,testing', category: 'qa',
        text: '系统测试用例集，包含功能测试、性能测试、安全测试等500+测试用例。',
        created_at: 1705248000000, updated_at: 1705334400000,
    },
    {
        item_id: 'file_010', item_type: 'file' as ItemType,
        filename: '项目进度表.xlsx', file_path: '/docs/pm/项目进度.xlsx', file_ext: 'xlsx',
        size: 512000, owner: 'bob', creator: 'bob', modifier: 'alice',
        tag: 'work,project,important', category: 'pm',
        text: '项目整体进度跟踪表，包含里程碑、任务分解、责任人、完成状态等信息。',
        created_at: 1705420800000, updated_at: 1705507200000,
    },
];

// 邮件数据（10 条）
const MAIL_DATA: Item[] = [
    {
        item_id: 'mail_001', item_type: 'mail' as ItemType,
        mail_title: '【重要】Q4项目预算审批申请',
        mail_ctx: '各位领导好，附件是Q4项目预算申请表，请审批。本次预算主要用于：1.服务器扩容 2.第三方服务采购 3.团队建设。总金额50万元，请查阅。',
        mail_from: 'alice@company.com', mail_to: 'cfo@company.com,ceo@company.com', mail_cc: 'bob@company.com',
        mail_date: 1703001600000, sender: 'Alice Wang',
        attachment_title: 'Q4预算申请表.xlsx,预算说明.pdf',
        attachment_ctx: '预算申请表包含详细的费用明细和使用计划；预算说明文档解释了各项支出的必要性。',
        tag: 'important,budget,approval', category: 'finance',
        text: 'Q4项目预算审批申请 预算申请表 服务器扩容 第三方服务采购 团队建设 50万元',
        created_at: 1703001600000, updated_at: 1703001600000,
    },
    {
        item_id: 'mail_002', item_type: 'mail' as ItemType,
        mail_title: '本周工作周报 - 技术部',
        mail_ctx: '本周完成：1.完成用户模块重构 2.修复10个bug 3.代码review。下周计划：1.开始文件服务开发 2.性能优化。风险：服务器资源紧张。',
        mail_from: 'bob@company.com', mail_to: 'manager@company.com', mail_cc: 'team@company.com',
        mail_date: 1703088000000, sender: 'Bob Chen',
        attachment_title: '周报详情.docx',
        attachment_ctx: '周报详情包含本周工作的具体内容和时间分配。',
        tag: 'work,weekly,report', category: 'report',
        text: '技术部周报 用户模块重构 bug修复 代码review 文件服务开发 性能优化',
        created_at: 1703088000000, updated_at: 1703088000000,
    },
    {
        item_id: 'mail_003', item_type: 'mail' as ItemType,
        mail_title: 'Re: 产品需求评审会议邀请',
        mail_ctx: '收到，我会准时参加。另外建议邀请技术负责人一起参与，以便评估技术可行性。会议前请提前发送PRD文档。',
        mail_from: 'charlie@company.com', mail_to: 'alice@company.com', mail_cc: 'product@company.com',
        mail_date: 1703174400000, sender: 'Charlie Liu',
        attachment_title: '', attachment_ctx: '',
        tag: 'meeting,product', category: 'meeting',
        text: '产品需求评审会议 技术可行性评估 PRD文档',
        created_at: 1703174400000, updated_at: 1703174400000,
    },
    {
        item_id: 'mail_004', item_type: 'mail' as ItemType,
        mail_title: '【紧急】生产环境故障通知',
        mail_ctx: '生产环境于今日14:30出现服务不可用，影响范围：全部用户。原因：数据库连接池耗尽。已采取措施：重启服务、扩大连接池。目前已恢复。',
        mail_from: 'david@company.com', mail_to: 'all@company.com', mail_cc: 'ops@company.com',
        mail_date: 1703260800000, sender: 'David Zhang',
        attachment_title: '故障分析报告.pdf,监控截图.png',
        attachment_ctx: '故障分析报告详细说明了故障原因和改进措施；监控截图显示了故障期间的系统状态。',
        tag: 'urgent,incident,important', category: 'incident',
        text: '生产环境故障 数据库连接池 服务不可用 故障恢复 紧急',
        created_at: 1703260800000, updated_at: 1703260800000,
    },
    {
        item_id: 'mail_005', item_type: 'mail' as ItemType,
        mail_title: '新员工入职培训安排',
        mail_ctx: '欢迎新同事加入！本周五下午2点将进行新员工入职培训，内容包括：公司介绍、制度讲解、系统使用培训。请准时参加。',
        mail_from: 'hr@company.com', mail_to: 'newbies@company.com', mail_cc: 'manager@company.com',
        mail_date: 1703347200000, sender: 'HR Team',
        attachment_title: '入职指南.pdf,培训日程.docx',
        attachment_ctx: '入职指南包含公司文化、组织架构、常用系统等信息；培训日程列出了详细的培训安排。',
        tag: 'hr,training,onboarding', category: 'hr',
        text: '新员工入职培训 公司介绍 制度讲解 系统使用培训',
        created_at: 1703347200000, updated_at: 1703347200000,
    },
    {
        item_id: 'mail_006', item_type: 'mail' as ItemType,
        mail_title: '客户反馈汇总 - 2024年1月',
        mail_ctx: '本月共收到客户反馈156条，其中：功能建议45条、bug报告32条、使用咨询79条。重点问题：搜索功能响应慢、移动端适配问题。详见附件。',
        mail_from: 'support@company.com', mail_to: 'product@company.com,tech@company.com', mail_cc: 'ceo@company.com',
        mail_date: 1703433600000, sender: 'Customer Support',
        attachment_title: '客户反馈明细.xlsx,问题分类统计.pdf',
        attachment_ctx: '反馈明细包含每条反馈的详细内容和处理状态；统计报告展示了问题分布和趋势。',
        tag: 'feedback,customer,important', category: 'support',
        text: '客户反馈汇总 功能建议 bug报告 搜索功能 移动端适配',
        created_at: 1703433600000, updated_at: 1703433600000,
    },
    {
        item_id: 'mail_007', item_type: 'mail' as ItemType,
        mail_title: '合同续签提醒 - ABC公司',
        mail_ctx: 'ABC公司的服务合同将于下月15日到期，请及时跟进续签事宜。合同金额：100万/年。联系人：张经理 138xxxx。',
        mail_from: 'sales@company.com', mail_to: 'alice@company.com', mail_cc: 'legal@company.com',
        mail_date: 1703520000000, sender: 'Sales Team',
        attachment_title: '原合同扫描件.pdf,续签报价单.xlsx',
        attachment_ctx: '原合同包含服务范围和条款；报价单是新一年的服务报价。',
        tag: 'contract,sales,reminder', category: 'sales',
        text: '合同续签 ABC公司 服务合同 到期提醒 100万',
        created_at: 1703520000000, updated_at: 1703520000000,
    },
    {
        item_id: 'mail_008', item_type: 'mail' as ItemType,
        mail_title: '技术分享会通知 - 微服务架构实践',
        mail_ctx: '本周四下午3点，技术分享会主题：微服务架构实践经验分享。分享人：David。内容：服务拆分策略、通信机制、部署方案。欢迎参加！',
        mail_from: 'david@company.com', mail_to: 'tech@company.com', mail_cc: 'all@company.com',
        mail_date: 1703606400000, sender: 'David Zhang',
        attachment_title: '分享PPT.pptx',
        attachment_ctx: 'PPT包含微服务架构的核心概念、实践案例和经验总结。',
        tag: 'tech,sharing,learning', category: 'learning',
        text: '技术分享会 微服务架构 服务拆分 通信机制 部署方案',
        created_at: 1703606400000, updated_at: 1703606400000,
    },
    {
        item_id: 'mail_009', item_type: 'mail' as ItemType,
        mail_title: '【审批】服务器采购申请',
        mail_ctx: '申请采购4台高性能服务器用于扩容，配置：64核CPU、256G内存、4T SSD。预算：80万元。供应商：Dell。请审批。',
        mail_from: 'ops@company.com', mail_to: 'cfo@company.com', mail_cc: 'cto@company.com,alice@company.com',
        mail_date: 1703692800000, sender: 'Ops Team',
        attachment_title: '采购申请单.pdf,服务器配置清单.xlsx,供应商报价.pdf',
        attachment_ctx: '申请单包含采购理由和预算说明；配置清单详细列出了服务器规格；报价单是供应商的正式报价。',
        tag: 'approval,purchase,important', category: 'purchase',
        text: '服务器采购申请 高性能服务器 扩容 预算审批 80万元 Dell',
        created_at: 1703692800000, updated_at: 1703692800000,
    },
    {
        item_id: 'mail_010', item_type: 'mail' as ItemType,
        mail_title: '年度绩效评估通知',
        mail_ctx: '2024年度绩效评估即将开始，请各部门于本月底前完成自评和互评。评估维度：工作成果、团队协作、创新能力、职业发展。',
        mail_from: 'hr@company.com', mail_to: 'all@company.com', mail_cc: 'managers@company.com',
        mail_date: 1703779200000, sender: 'HR Team',
        attachment_title: '绩效评估表.xlsx,评估指南.pdf',
        attachment_ctx: '评估表是标准的绩效评估模板；指南说明了评估流程和评分标准。',
        tag: 'hr,performance,important', category: 'hr',
        text: '年度绩效评估 自评互评 工作成果 团队协作 创新能力',
        created_at: 1703779200000, updated_at: 1703779200000,
    },
];

// 记忆/笔记数据（5 条）
const MEMORY_DATA: Item[] = [
    {
        item_id: 'memory_001', item_type: 'memory' as ItemType,
        tag: 'idea,product', category: 'idea',
        text: '新功能设计思路：可以考虑增加智能标签推荐功能，基于文档内容自动生成标签建议。技术方案：使用NLP提取关键词，结合用户历史标签习惯进行推荐。',
        created_at: 1703001600000, updated_at: 1703001600000,
    },
    {
        item_id: 'memory_002', item_type: 'memory' as ItemType,
        tag: 'todo,work', category: 'todo',
        text: '待办事项：1.完成API文档更新 2.Review小王的PR 3.准备周五的技术分享 4.跟进服务器采购进度',
        created_at: 1703088000000, updated_at: 1703174400000,
    },
    {
        item_id: 'memory_003', item_type: 'memory' as ItemType,
        tag: 'note,budget,finance', category: 'note',
        text: '预算规划笔记：Q1预算重点-基础设施升级；Q2预算重点-产品研发；Q3预算重点-市场推广；Q4预算重点-团队扩张。需要与财务部门确认各季度具体额度。',
        created_at: 1703174400000, updated_at: 1703260800000,
    },
    {
        item_id: 'memory_004', item_type: 'memory' as ItemType,
        tag: 'meeting,summary', category: 'meeting',
        text: '项目复盘会议要点：1.需求变更频繁导致延期 2.测试覆盖率不足 3.文档更新不及时。改进措施：引入需求冻结期、提高单测覆盖率、文档与代码同步更新。',
        created_at: 1703260800000, updated_at: 1703260800000,
    },
    {
        item_id: 'memory_005', item_type: 'memory' as ItemType,
        tag: 'learning,tech', category: 'learning',
        text: '学习笔记-向量数据库：主流方案有Pinecone、Milvus、Qdrant。选型考虑：数据规模、查询性能、部署方式、成本。我们的场景适合使用Qdrant自部署方案。',
        created_at: 1703347200000, updated_at: 1703433600000,
    },
];

// 合并所有数据
const ALL_DATA: Item[] = [...FILE_DATA, ...MAIL_DATA, ...MEMORY_DATA];

// ============================================================================
// 向量生成工具
// ============================================================================

const VECTOR_DIMENSION = 384;

/**
 * 生成模拟向量
 * 为了演示相似度搜索，相关文档使用相近的向量
 */
function generateVector(seed: number, category?: string): Float32Array {
    const vector = new Float32Array(VECTOR_DIMENSION);

    // 基于 seed 生成基础向量
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
        vector[i] = Math.sin(seed * (i + 1) * 0.1) * 0.5;
    }

    // 根据类别添加特征偏移，使同类文档向量更相似
    const categoryOffsets: Record<string, number> = {
        'finance': 0.3,
        'tech': 0.5,
        'hr': 0.7,
        'meeting': 0.9,
        'product': 1.1,
    };

    if (category && categoryOffsets[category]) {
        for (let i = 0; i < 50; i++) {
            vector[i] += categoryOffsets[category];
        }
    }

    // 归一化
    let norm = 0;
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
        norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < VECTOR_DIMENSION; i++) {
        vector[i] /= norm;
    }

    return vector;
}

/**
 * 为所有数据生成向量
 */
function generateVectorsForData(data: Item[]): Map<string, Float32Array> {
    const vectors = new Map<string, Float32Array>();
    data.forEach((item, index) => {
        vectors.set(item.item_id, generateVector(index, item.category));
    });
    return vectors;
}

// 创建 item_id -> Item 的映射，用于从 VectorIndexer 结果中获取完整数据
const ALL_DATA_MAP = new Map<string, Item>();
ALL_DATA.forEach(item => ALL_DATA_MAP.set(item.item_id, item));

/**
 * 根据 item_id 获取完整的 Item 数据
 * VectorIndexer 只返回 item_id 和 item_type，需要从原始数据中获取其他字段
 */
function getFullItem(item: Item): Item {
    return ALL_DATA_MAP.get(item.item_id) || item;
}

/**
 * 获取 Item 的显示标题
 */
function getItemTitle(item: Item): string {
    const fullItem = getFullItem(item);
    return fullItem.mail_title || fullItem.filename || fullItem.text?.substring(0, 30) + '...' || item.item_id;
}

// ============================================================================
// Part 2: 单独使用各个 Indexer
// ============================================================================

/**
 * Part 2.1: TagIndexer 使用示例
 *
 * TagIndexer 用于基于标签的精确查询和过滤。
 * 支持的操作符：=, !=, >, <, >=, <=, like, in
 */
async function demonstrateTagIndexer(): Promise<void> {
    printSection('Part 2.1: TagIndexer 使用示例');

    console.log(`
TagIndexer 是基于 SQLite 的标签索引器，适用于：
- 按标签精确查询（tag = 'important'）
- 按类型过滤（item_type = 'mail'）
- 模糊搜索（text like '%预算%'）
- 多值查询（tag in ['work', 'meeting']）
`);

    // 创建 TagIndexer 实例
    const tagIndexer = new TagIndexer(path.join(TEST_DIR, 'tag-index.db'));
    await tagIndexer.initialize();
    printSuccess('TagIndexer 初始化完成');

    // 插入数据
    printSubSection('插入测试数据');
    await tagIndexer.insert(ALL_DATA);
    printSuccess(`插入 ${ALL_DATA.length} 条数据`);

    // 查询示例 1: 按标签精确查询
    printSubSection('查询示例 1: 按标签精确查询 (tag like \'%important%\')');
    const importantResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%important%' }
    ]);
    console.log(`  找到 ${importantResults.items.length} 条结果:`);
    printSearchResults(importantResults.items);

    // 查询示例 2: 按类型过滤
    printSubSection('查询示例 2: 按类型过滤 (item_type = \'mail\')');
    const mailResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'mail' }
    ]);
    console.log(`  找到 ${mailResults.items.length} 条邮件:`);
    printSearchResults(mailResults.items);

    // 查询示例 3: 模糊搜索
    printSubSection('查询示例 3: 模糊搜索 (text like \'%预算%\')');
    const budgetResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'text', operator: 'like', value: '%预算%' }
    ]);
    console.log(`  找到 ${budgetResults.items.length} 条包含"预算"的结果:`);
    printSearchResults(budgetResults.items);

    // 查询示例 4: 多条件组合
    printSubSection('查询示例 4: 多条件组合 (item_type = \'file\' AND tag like \'%finance%\')');
    const financeFileResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'file' },
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%finance%' }
    ]);
    console.log(`  找到 ${financeFileResults.items.length} 条财务相关文件:`);
    printSearchResults(financeFileResults.items);

    // 查询示例 5: 分页查询
    printSubSection('查询示例 5: 分页查询 (limit=3, offset=0)');
    const pagedResults = await tagIndexer.search(
        [{ indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'file' }],
        { limit: 3, offset: 0 }
    );
    console.log(`  第一页 (3 条):`);
    printSearchResults(pagedResults.items);

    tagIndexer.close();
    printSuccess('TagIndexer 示例完成');
}

/**
 * Part 2.2: BM25Indexer 使用示例
 *
 * BM25Indexer 用于全文搜索，基于 BM25 算法计算相关性分数。
 * 适用于关键词搜索、文档检索等场景。
 */
async function demonstrateBM25Indexer(): Promise<void> {
    printSection('Part 2.2: BM25Indexer 使用示例');

    console.log(`
BM25Indexer 是基于 BM25 算法的全文搜索索引器，适用于：
- 关键词搜索（搜索包含特定词汇的文档）
- 相关性排序（按 BM25 分数排序）
- Top-K 查询（返回最相关的 K 个结果）
`);

    // 创建 BM25Indexer 实例
    const bm25Indexer = new BM25Indexer(path.join(TEST_DIR, 'bm25-index.db'), { defaultTopK: 20 });
    await bm25Indexer.initialize();
    printSuccess('BM25Indexer 初始化完成');

    // 插入数据
    printSubSection('插入测试数据');
    await bm25Indexer.insert(ALL_DATA);
    printSuccess(`插入 ${ALL_DATA.length} 条数据，文档总数: ${bm25Indexer.getDocumentCount()}`);

    // 查询示例 1: 基础全文搜索
    printSubSection('查询示例 1: 全文搜索 (query = \'预算 审批\')');
    const budgetResults = await bm25Indexer.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: '预算 审批', topK: 5 }
        }
    ]);
    console.log(`  找到 ${budgetResults.items.length} 条结果 (按相关性排序):`);
    budgetResults.items.forEach((item, i) => {
        const score = budgetResults.scores?.get(item.item_id) ?? 0;
        const title = item.mail_title || item.filename || item.text?.substring(0, 30) + '...';
        console.log(`  ${i + 1}. [${item.item_id}] ${title} (BM25: ${score.toFixed(4)})`);
    });

    // 查询示例 2: 技术相关搜索
    printSubSection('查询示例 2: 技术相关搜索 (query = \'微服务 架构 API\')');
    const techResults = await bm25Indexer.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: '微服务 架构 API', topK: 5 }
        }
    ]);
    console.log(`  找到 ${techResults.items.length} 条结果:`);
    techResults.items.forEach((item, i) => {
        const score = techResults.scores?.get(item.item_id) ?? 0;
        const title = item.mail_title || item.filename || item.text?.substring(0, 30) + '...';
        console.log(`  ${i + 1}. [${item.item_id}] ${title} (BM25: ${score.toFixed(4)})`);
    });

    // 查询示例 3: 会议相关搜索
    printSubSection('查询示例 3: 会议相关搜索 (query = \'会议 项目 需求\')');
    const meetingResults = await bm25Indexer.search([
        {
            indexer: 'BM25Indexer',
            field: 'text',
            operator: 'bm25_match',
            value: { query: '会议 项目 需求', topK: 5 }
        }
    ]);
    console.log(`  找到 ${meetingResults.items.length} 条结果:`);
    meetingResults.items.forEach((item, i) => {
        const score = meetingResults.scores?.get(item.item_id) ?? 0;
        const title = item.mail_title || item.filename || item.text?.substring(0, 30) + '...';
        console.log(`  ${i + 1}. [${item.item_id}] ${title} (BM25: ${score.toFixed(4)})`);
    });

    bm25Indexer.close();
    printSuccess('BM25Indexer 示例完成');
}

/**
 * Part 2.3: VectorIndexer 使用示例
 *
 * VectorIndexer 用于向量相似度搜索，适用于语义搜索场景。
 * 支持的操作符：vector_similarity, vector_near, vector_not_similar, vector_range
 */
async function demonstrateVectorIndexer(): Promise<void> {
    printSection('Part 2.3: VectorIndexer 使用示例');

    console.log(`
VectorIndexer 是基于 sqlite-vec 的向量索引器，适用于：
- 语义相似度搜索（找到语义相近的文档）
- Top-K 最近邻查询（返回最相似的 K 个结果）
- 阈值过滤（只返回相似度超过阈值的结果）
- 支持多种距离度量：cosine, euclidean, dot_product, manhattan
`);

    // 创建 VectorIndexer 实例
    const vectorIndexer = new VectorIndexer(path.join(TEST_DIR, 'vector-index.db'), VECTOR_DIMENSION);
    await vectorIndexer.initialize();
    printSuccess(`VectorIndexer 初始化完成 (维度: ${VECTOR_DIMENSION})`);

    // 生成向量数据
    const vectors = generateVectorsForData(ALL_DATA);

    // 插入数据（带向量）
    printSubSection('插入测试数据（带向量嵌入）');
    const dataWithVectors = ALL_DATA.map(item => ({
        ...item,
        repr: vectors.get(item.item_id)!
    }));
    await vectorIndexer.insertWithVectors(dataWithVectors);
    printSuccess(`插入 ${ALL_DATA.length} 条数据（含向量）`);

    // 查询示例 1: 相似度搜索 - 查找与财务报告相似的文档
    printSubSection('查询示例 1: 相似度搜索 - 查找与财务报告相似的文档');
    const financeVector = vectors.get('file_001')!; // Q4财务报告的向量
    const similarResults = await vectorIndexer.search([
        {
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_similarity',
            value: financeVector,
            vectorQuery: { threshold: 0.5, metric: 'cosine', topK: 5 }
        }
    ]);
    console.log(`  以 file_001 (Q4财务报告) 为基准，找到 ${similarResults.items.length} 条相似文档:`);
    similarResults.items.forEach((item, i) => {
        const score = similarResults.scores?.get(item.item_id) ?? 0;
        const title = getItemTitle(item);
        console.log(`  ${i + 1}. [${item.item_id}] ${title} (相似度: ${score.toFixed(4)})`);
    });

    // 查询示例 2: Top-K 最近邻 - 查找与技术文档最相似的内容
    printSubSection('查询示例 2: Top-K 最近邻 - 查找与技术架构文档最相似的内容');
    const techVector = vectors.get('file_004')!; // 技术架构设计的向量
    const topKResults = await vectorIndexer.search([
        {
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_near',
            value: techVector,
            vectorQuery: { threshold: 0, topK: 5 }
        }
    ]);
    console.log(`  以 file_004 (技术架构设计) 为基准，Top-5 最近邻:`);
    topKResults.items.forEach((item, i) => {
        const score = topKResults.scores?.get(item.item_id) ?? 0;
        const title = getItemTitle(item);
        console.log(`  ${i + 1}. [${item.item_id}] ${title} (距离: ${score.toFixed(4)})`);
    });

    // 查询示例 3: 高阈值过滤 - 只返回高度相似的文档
    printSubSection('查询示例 3: 高阈值过滤 (threshold >= 0.8)');
    const hrVector = vectors.get('file_006')!; // 员工手册的向量
    const highThresholdResults = await vectorIndexer.search([
        {
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_similarity',
            value: hrVector,
            vectorQuery: { threshold: 0.8, metric: 'cosine', topK: 10 }
        }
    ]);
    console.log(`  以 file_006 (员工手册) 为基准，相似度 >= 0.8 的文档:`);
    if (highThresholdResults.items.length === 0) {
        console.log('  (无满足条件的结果，这说明阈值设置较高)');
    } else {
        highThresholdResults.items.forEach((item, i) => {
            const score = highThresholdResults.scores?.get(item.item_id) ?? 0;
            const title = getItemTitle(item);
            console.log(`  ${i + 1}. [${item.item_id}] ${title} (相似度: ${score.toFixed(4)})`);
        });
    }

    vectorIndexer.close();
    printSuccess('VectorIndexer 示例完成');
}

/**
 * Part 2.4: BaseIndexer 使用示例
 *
 * BaseIndexer 支持动态 Schema，适用于结构化数据的复杂查询。
 * 支持所有标量操作符，包括 between, in, notlike 等。
 */
async function demonstrateBaseIndexer(): Promise<void> {
    printSection('Part 2.4: BaseIndexer 使用示例');

    console.log(`
BaseIndexer 是支持动态 Schema 的 SQLite 索引器，适用于：
- 结构化数据查询（按字段精确匹配）
- 范围查询（size between 100000 and 1000000）
- 多值查询（owner in ['alice', 'bob']）
- 排序与分页
`);

    // 创建 BaseIndexer 实例
    const baseIndexer = new BaseIndexer(SCHEMA, path.join(TEST_DIR, 'base-index.db'));
    await baseIndexer.initialize();
    printSuccess('BaseIndexer 初始化完成');

    // 插入数据
    printSubSection('插入测试数据');
    await baseIndexer.insert(ALL_DATA);
    printSuccess(`插入 ${ALL_DATA.length} 条数据`);

    // 查询示例 1: 按所有者查询
    printSubSection('查询示例 1: 按所有者查询 (owner = \'alice\')');
    const aliceResults = await baseIndexer.search([
        { indexer: 'BaseIndexer', field: 'owner', operator: '=', value: 'alice' }
    ]);
    console.log(`  找到 ${aliceResults.items.length} 条 alice 的文件:`);
    printSearchResults(aliceResults.items);

    // 查询示例 2: 范围查询 - 文件大小
    printSubSection('查询示例 2: 范围查询 (size between 500000 and 2000000)');
    const sizeRangeResults = await baseIndexer.search([
        { indexer: 'BaseIndexer', field: 'size', operator: 'between', value: [500000, 2000000] }
    ]);
    console.log(`  找到 ${sizeRangeResults.items.length} 条文件 (500KB - 2MB):`);
    sizeRangeResults.items.forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.item_id}] ${item.filename} (${(item.size / 1024).toFixed(0)} KB)`);
    });

    // 查询示例 3: 多值查询
    printSubSection('查询示例 3: 多值查询 (owner in [\'alice\', \'bob\', \'david\'])');
    const multiOwnerResults = await baseIndexer.search([
        { indexer: 'BaseIndexer', field: 'owner', operator: 'in', value: ['alice', 'bob', 'david'] }
    ]);
    console.log(`  找到 ${multiOwnerResults.items.length} 条结果:`);
    multiOwnerResults.items.forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.item_id}] ${item.filename} (owner: ${item.owner})`);
    });

    // 查询示例 4: 按发件人查询邮件
    printSubSection('查询示例 4: 按发件人查询邮件 (mail_from like \'%@company.com\')');
    const companyMailResults = await baseIndexer.search([
        { indexer: 'BaseIndexer', field: 'mail_from', operator: 'like', value: '%alice@%' }
    ]);
    console.log(`  找到 ${companyMailResults.items.length} 条 Alice 发送的邮件:`);
    companyMailResults.items.forEach((item, i) => {
        console.log(`  ${i + 1}. [${item.item_id}] ${item.mail_title} (from: ${item.mail_from})`);
    });

    // 查询示例 5: 排序查询
    printSubSection('查询示例 5: 按更新时间排序 (最近更新的文件)');
    const sortedResults = await baseIndexer.search(
        [{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }],
        { orderBy: { field: 'updated_at', direction: 'DESC' }, limit: 5 }
    );
    console.log(`  最近更新的 5 个文件:`);
    sortedResults.items.forEach((item, i) => {
        const date = new Date(item.updated_at).toLocaleDateString();
        console.log(`  ${i + 1}. [${item.item_id}] ${item.filename} (更新: ${date})`);
    });

    baseIndexer.close();
    printSuccess('BaseIndexer 示例完成');
}

// ============================================================================
// Part 3: 多 Indexer 组合查询（RAG 核心）
// ============================================================================

/**
 * Part 3: 多 Indexer 组合查询
 *
 * 展示如何组合多个 Indexer 实现复杂的 RAG 查询流程。
 * 这是构建智能搜索系统的核心模式。
 */
async function demonstrateMultiIndexerQuery(): Promise<void> {
    printSection('Part 3: 多 Indexer 组合查询（RAG 核心）');

    console.log(`
多 Indexer 组合查询是 RAG 系统的核心，通过组合不同索引器实现：
- 标签过滤 + 全文搜索：先按标签缩小范围，再进行关键词搜索
- 标签过滤 + 向量搜索：先按标签过滤，再进行语义相似度搜索
- 全文搜索 + 向量重排序：BM25 粗筛 + 向量精排
- 完整 RAG Pipeline：多阶段过滤和排序
`);

    // 初始化所有 Indexer
    const tagIndexer = new TagIndexer(path.join(TEST_DIR, 'multi-tag-index.db'));
    const bm25Indexer = new BM25Indexer(path.join(TEST_DIR, 'multi-bm25-index.db'));
    const vectorIndexer = new VectorIndexer(path.join(TEST_DIR, 'multi-vector-index.db'), VECTOR_DIMENSION);

    await Promise.all([
        tagIndexer.initialize(),
        bm25Indexer.initialize(),
        vectorIndexer.initialize(),
    ]);
    printSuccess('所有 Indexer 初始化完成');

    // 插入数据
    const vectors = generateVectorsForData(ALL_DATA);
    await tagIndexer.insert(ALL_DATA);
    await bm25Indexer.insert(ALL_DATA);
    await vectorIndexer.insertWithVectors(ALL_DATA.map(item => ({
        ...item,
        repr: vectors.get(item.item_id)!
    })));
    printSuccess('数据插入完成');

    // ========================================
    // 场景 3.1: 标签 + 全文搜索
    // ========================================
    printSubSection('场景 3.1: 标签过滤 + 全文搜索');
    console.log('  需求: 找到所有标记为 "important" 且包含 "预算" 关键词的文档\n');

    // Step 1: TagIndexer 过滤
    console.log('  Step 1: TagIndexer 过滤 (tag like \'%important%\')');
    const tagResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%important%' }
    ]);
    console.log(`    → 找到 ${tagResults.items.length} 条候选结果`);

    // Step 2: BM25Indexer 在候选集中搜索
    console.log('  Step 2: BM25Indexer 搜索 (query = \'预算\')');
    const bm25Results = await bm25Indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '预算', topK: 10 } }],
        { existingResults: tagResults.items }
    );
    console.log(`    → 在候选中找到 ${bm25Results.items.length} 条匹配结果\n`);

    console.log('  最终结果:');
    bm25Results.items.forEach((item, i) => {
        const score = bm25Results.scores?.get(item.item_id) ?? 0;
        const title = item.mail_title || item.filename || item.text?.substring(0, 30) + '...';
        console.log(`    ${i + 1}. [${item.item_id}] ${title} (BM25: ${score.toFixed(4)})`);
    });

    // ========================================
    // 场景 3.2: 标签 + 向量相似度
    // ========================================
    printSubSection('场景 3.2: 标签过滤 + 向量相似度搜索');
    console.log('  需求: 在技术相关文档中，找到与"微服务架构"语义最相似的内容\n');

    // Step 1: TagIndexer 过滤技术标签
    console.log('  Step 1: TagIndexer 过滤 (tag like \'%tech%\')');
    const techTagResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%tech%' }
    ]);
    console.log(`    → 找到 ${techTagResults.items.length} 条技术相关文档`);

    // Step 2: VectorIndexer 语义搜索
    console.log('  Step 2: VectorIndexer 语义搜索 (基于技术架构文档的向量)');
    const techQueryVector = vectors.get('file_004')!; // 技术架构设计的向量
    const vectorResults = await vectorIndexer.search(
        [{
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_near',
            value: techQueryVector,
            vectorQuery: { threshold: 0, topK: 5 }
        }],
        { existingResults: techTagResults.items }
    );
    console.log(`    → 找到 ${vectorResults.items.length} 条语义相似结果\n`);

    console.log('  最终结果:');
    vectorResults.items.forEach((item, i) => {
        const score = vectorResults.scores?.get(item.item_id) ?? 0;
        const title = getItemTitle(item);
        console.log(`    ${i + 1}. [${item.item_id}] ${title} (相似度: ${score.toFixed(4)})`);
    });

    // ========================================
    // 场景 3.3: 完整 RAG Pipeline
    // ========================================
    printSubSection('场景 3.3: 完整 RAG Pipeline');
    console.log('  需求: 用户问题 "公司的预算规划和财务报告有哪些？"\n');
    console.log('  Pipeline: 类型过滤 → BM25 召回 → 向量重排序\n');

    // Step 1: 按类型过滤（排除 memory 类型）
    console.log('  Step 1: 类型过滤 (item_type in [\'file\', \'mail\'])');
    const typeFilterResults = await tagIndexer.search([
        { indexer: 'TagIndexer', field: 'item_type', operator: 'in', value: ['file', 'mail'] }
    ]);
    console.log(`    → 找到 ${typeFilterResults.items.length} 条文件和邮件`);

    // Step 2: BM25 召回
    console.log('  Step 2: BM25 召回 (query = \'预算 财务 报告\')');
    const recallResults = await bm25Indexer.search(
        [{ indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '预算 财务 报告', topK: 10 } }],
        { existingResults: typeFilterResults.items }
    );
    console.log(`    → 召回 ${recallResults.items.length} 条候选文档`);

    // Step 3: 向量重排序
    console.log('  Step 3: 向量重排序 (基于财务报告的语义向量)');
    const financeQueryVector = vectors.get('file_001')!; // 财务报告的向量
    const rerankResults = await vectorIndexer.search(
        [{
            indexer: 'VectorIndexer',
            field: 'repr',
            operator: 'vector_near',
            value: financeQueryVector,
            vectorQuery: { threshold: 0, topK: 5 }
        }],
        { existingResults: recallResults.items }
    );
    console.log(`    → 重排序后保留 ${rerankResults.items.length} 条结果\n`);

    console.log('  最终结果 (按语义相关性排序):');
    rerankResults.items.forEach((item, i) => {
        const vecScore = rerankResults.scores?.get(item.item_id) ?? 0;
        const bm25Score = recallResults.scores?.get(item.item_id) ?? 0;
        const title = getItemTitle(item);
        console.log(`    ${i + 1}. [${item.item_id}] ${title}`);
        console.log(`       BM25: ${bm25Score.toFixed(4)}, 向量相似度: ${vecScore.toFixed(4)}`);
    });

    // 清理
    tagIndexer.close();
    bm25Indexer.close();
    vectorIndexer.close();
    printSuccess('多 Indexer 组合查询示例完成');
}

// ============================================================================
// Part 4: 使用 BaseStorage 统一接口
// ============================================================================

/**
 * Part 4: BaseStorage 统一接口
 *
 * BaseStorage 封装了多个 Indexer，提供统一的 CRUD 和搜索接口。
 * 自动协调多个索引器的数据同步和查询。
 */
async function demonstrateBaseStorage(): Promise<void> {
    printSection('Part 4: BaseStorage 统一接口');

    console.log(`
BaseStorage 是多索引器的统一封装，提供：
- 统一的 CRUD 接口（insert, update, delete）
- 自动数据同步到所有相关 Indexer
- 跨 Indexer 的组合查询
- 按 Indexer 优先级自动处理查询顺序
`);

    // 创建 BaseStorage 实例
    const storage = new BaseStorage('example-storage', SCHEMA, path.join(TEST_DIR, 'base-storage'));
    await storage.initialize();
    printSuccess('BaseStorage 初始化完成');

    // 插入数据
    printSubSection('统一插入数据');
    await storage.insert(ALL_DATA);
    printSuccess(`通过 BaseStorage 插入 ${ALL_DATA.length} 条数据`);
    console.log('  数据自动同步到: TagIndexer, BM25Indexer, VectorIndexer, BaseIndexer');

    // 组合查询示例 1
    printSubSection('组合查询示例 1: TagIndexer + BaseIndexer');
    console.log('  查询: 标签包含 "important" 且 owner = "alice" 的文档\n');
    const result1 = await storage.search([], [
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%important%' },
        { indexer: 'BaseIndexer', field: 'owner', operator: '=', value: 'alice' }
    ]);
    console.log(`  找到 ${result1.length} 条结果:`);
    result1.forEach((r, i) => {
        const title = r.item.mail_title || r.item.filename || r.item.text?.substring(0, 30) + '...';
        console.log(`    ${i + 1}. [${r.item.item_id}] ${title} [${r.item.tag}]`);
    });

    // 组合查询示例 2
    printSubSection('组合查询示例 2: TagIndexer + BM25Indexer');
    console.log('  查询: 邮件类型 + 包含 "服务器" 关键词\n');
    const result2 = await storage.search([], [
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'mail' },
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '服务器', topK: 5 } }
    ]);
    console.log(`  找到 ${result2.length} 条结果:`);
    result2.forEach((r, i) => {
        const title = r.item.mail_title || r.item.filename || r.item.text?.substring(0, 30) + '...';
        console.log(`    ${i + 1}. [${r.item.item_id}] ${title} (BM25: ${r.BM25Score?.toFixed(4) ?? 'N/A'})`);
    });

    // 更新数据示例
    printSubSection('更新数据示例');
    const updateItem: Item = {
        item_id: 'file_001',
        item_type: 'file',
        filename: 'Q4_财务报告_v2.pdf',
        tag: 'important,finance,updated',
        text: '2024年第四季度财务报告（更新版），新增了利润分析章节。',
        owner: 'alice',
        updated_at: Date.now(),
    };
    await storage.update([updateItem]);
    printSuccess('更新 file_001 完成');

    // 验证更新
    const verifyResult = await storage.search([], [
        { indexer: 'TagIndexer', field: 'item_id', operator: '=', value: 'file_001' }
    ]);
    if (verifyResult.length > 0) {
        console.log(`  更新后的数据: ${verifyResult[0].item.filename} [${verifyResult[0].item.tag}]`);
    }

    // 删除数据示例
    printSubSection('删除数据示例');
    await storage.delete([{ item_id: 'memory_005', item_type: 'memory' }]);
    printSuccess('删除 memory_005 完成');

    // 验证删除
    const deleteVerify = await storage.search([], [
        { indexer: 'TagIndexer', field: 'item_id', operator: '=', value: 'memory_005' }
    ]);
    console.log(`  删除验证: 找到 ${deleteVerify.length} 条结果 (应为 0)`);

    storage.close();
    printSuccess('BaseStorage 示例完成');
}

// ============================================================================
// Part 5: 实际应用场景演示
// ============================================================================

/**
 * Part 5: 实际应用场景演示
 *
 * 展示如何将 Indexer 系统应用于实际的邮件/文件管理场景。
 */
async function demonstrateRealWorldScenarios(): Promise<void> {
    printSection('Part 5: 实际应用场景演示');

    console.log(`
以下演示三个实际应用场景：
1. 邮件搜索：找到特定发件人关于特定主题的重要邮件
2. 文件检索：查找特定类型、特定时间范围的文件
3. 智能问答：基于用户问题进行多路召回和结果融合
`);

    // 初始化
    const storage = new BaseStorage('scenario-storage', SCHEMA, path.join(TEST_DIR, 'scenario-storage'));
    await storage.initialize();
    await storage.insert(ALL_DATA);

    // ========================================
    // 场景 5.1: 邮件搜索
    // ========================================
    printSubSection('场景 5.1: 邮件搜索');
    console.log('  用户需求: "找到所有来自 Alice 的关于项目预算的重要邮件"\n');

    console.log('  解析用户意图:');
    console.log('    - 类型: mail');
    console.log('    - 发件人: alice');
    console.log('    - 关键词: 预算');
    console.log('    - 标签: important\n');

    const mailSearchResult = await storage.search([], [
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'mail' },
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%important%' },
        { indexer: 'BaseIndexer', field: 'mail_from', operator: 'like', value: '%alice%' },
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '预算', topK: 5 } }
    ]);

    console.log(`  搜索结果 (${mailSearchResult.length} 条):`);
    mailSearchResult.forEach((r, i) => {
        console.log(`    ${i + 1}. 标题: ${r.item.mail_title}`);
        console.log(`       发件人: ${r.item.sender} <${r.item.mail_from}>`);
        console.log(`       收件人: ${r.item.mail_to}`);
        console.log(`       附件: ${r.item.attachment_title || '无'}`);
        console.log(`       标签: [${r.item.tag}]`);
        console.log(`       BM25 分数: ${r.BM25Score?.toFixed(4) ?? 'N/A'}`);
        console.log('');
    });

    // ========================================
    // 场景 5.2: 文件检索
    // ========================================
    printSubSection('场景 5.2: 文件检索');
    console.log('  用户需求: "查找所有 PDF 格式的财务相关文件"\n');

    console.log('  解析用户意图:');
    console.log('    - 类型: file');
    console.log('    - 扩展名: pdf');
    console.log('    - 标签: finance\n');

    const fileSearchResult = await storage.search([], [
        { indexer: 'TagIndexer', field: 'item_type', operator: '=', value: 'file' },
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%finance%' },
        { indexer: 'BaseIndexer', field: 'file_ext', operator: '=', value: 'pdf' }
    ]);

    console.log(`  搜索结果 (${fileSearchResult.length} 条):`);
    fileSearchResult.forEach((r, i) => {
        const sizeKB = ((r.item.size || 0) / 1024).toFixed(0);
        const updateDate = new Date(r.item.updated_at).toLocaleDateString();
        console.log(`    ${i + 1}. 文件名: ${r.item.filename}`);
        console.log(`       路径: ${r.item.file_path}`);
        console.log(`       大小: ${sizeKB} KB`);
        console.log(`       所有者: ${r.item.owner}`);
        console.log(`       更新时间: ${updateDate}`);
        console.log(`       标签: [${r.item.tag}]`);
        console.log('');
    });

    // ========================================
    // 场景 5.3: 智能问答（RAG）
    // ========================================
    printSubSection('场景 5.3: 智能问答 (RAG)');
    console.log('  用户问题: "公司最近有什么技术分享活动？分享了什么内容？"\n');

    console.log('  RAG 处理流程:');
    console.log('    1. 意图识别: 技术分享、活动、内容');
    console.log('    2. 多路召回: BM25 关键词匹配');
    console.log('    3. 结果融合: 按相关性排序\n');

    const ragResult = await storage.search([], [
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: '技术分享 架构 微服务', topK: 5 } }
    ]);

    console.log(`  召回结果 (${ragResult.length} 条):`);
    ragResult.forEach((r, i) => {
        const title = r.item.mail_title || r.item.filename || '笔记';
        const content = r.item.mail_ctx || r.item.text || '';
        const preview = content.length > 100 ? content.substring(0, 100) + '...' : content;
        console.log(`    ${i + 1}. [${r.item.item_type}] ${title}`);
        console.log(`       内容预览: ${preview}`);
        console.log(`       BM25 分数: ${r.BM25Score?.toFixed(4) ?? 'N/A'}`);
        console.log('');
    });

    console.log('  生成回答 (基于召回结果):');
    console.log('  ─────────────────────────────────────────────────────────');
    console.log('  根据检索到的信息，公司最近有一场技术分享会：');
    console.log('  ');
    console.log('  主题：微服务架构实践经验分享');
    console.log('  分享人：David Zhang');
    console.log('  时间：周四下午3点');
    console.log('  ');
    console.log('  分享内容包括：');
    console.log('  - 服务拆分策略');
    console.log('  - 通信机制');
    console.log('  - 部署方案');
    console.log('  ');
    console.log('  相关资料：分享PPT.pptx（包含核心概念、实践案例和经验总结）');
    console.log('  ─────────────────────────────────────────────────────────');

    storage.close();
    printSuccess('实际应用场景演示完成');
}

// ============================================================================
// Part 6: 主函数
// ============================================================================

/**
 * 主函数 - 运行所有示例
 */
async function main(): Promise<void> {
    printHeader('Storage Indexer 使用样例 - RAG 系统构建指南');

    console.log(`
本示例展示如何使用 Storage Indexer 系统构建 RAG 应用。

包含以下内容：
- Part 1: 环境准备与数据模型定义
- Part 2: 单独使用各个 Indexer (Tag, BM25, Vector, Base)
- Part 3: 多 Indexer 组合查询
- Part 4: BaseStorage 统一接口
- Part 5: 实际应用场景演示
- Part 6: 清理与总结

测试数据：
- 文件: ${FILE_DATA.length} 条
- 邮件: ${MAIL_DATA.length} 条
- 笔记: ${MEMORY_DATA.length} 条
- 总计: ${ALL_DATA.length} 条
`);

    try {
        // Part 1: 环境准备
        printSection('Part 1: 环境准备与数据模型定义');
        setupTestDirectory();
        printSuccess('ColumnSchema 定义完成');
        console.log('  支持的字段: item_id, item_type, filename, file_path, file_ext, size, owner, ...');
        console.log('  支持的 Indexer: TagIndexer, BM25Indexer, VectorIndexer, BaseIndexer');

        // Part 2: 单独使用各个 Indexer
        await demonstrateTagIndexer();
        await demonstrateBM25Indexer();
        await demonstrateVectorIndexer();
        await demonstrateBaseIndexer();

        // Part 3: 多 Indexer 组合查询
        await demonstrateMultiIndexerQuery();

        // Part 4: BaseStorage 统一接口
        await demonstrateBaseStorage();

        // Part 5: 实际应用场景
        await demonstrateRealWorldScenarios();

        // Part 6: 清理
        printSection('Part 6: 清理与总结');
        cleanupTestDirectory();

        // 总结
        printHeader('测试完成 - 所有样例运行成功');
        console.log(`
总结：

1. TagIndexer: 适用于标签过滤、类型筛选、精确匹配
   - 操作符: =, !=, >, <, >=, <=, like, in

2. BM25Indexer: 适用于全文搜索、关键词匹配
   - 操作符: bm25_match
   - 返回 BM25 相关性分数

3. VectorIndexer: 适用于语义搜索、相似度匹配
   - 操作符: vector_similarity, vector_near, vector_not_similar, vector_range
   - 支持 cosine, euclidean, dot_product, manhattan 距离

4. BaseIndexer: 适用于结构化查询、范围查询
   - 操作符: =, !=, >, <, >=, <=, like, notlike, in, notin, between, notbetween

5. BaseStorage: 统一封装，自动协调多个 Indexer

RAG 最佳实践：
- 使用 TagIndexer 进行初步过滤（缩小搜索范围）
- 使用 BM25Indexer 进行关键词召回
- 使用 VectorIndexer 进行语义重排序
- 组合多个 Indexer 实现复杂查询
`);

    } catch (error) {
        console.error('\n错误:', error);
        cleanupTestDirectory();
        process.exit(1);
    }
}

// 运行主函数
main().catch(console.error);
