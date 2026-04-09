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
 * storage npm 包导出入口
 *
 * 导出分两层：
 * - 公共业务 API：业务方（filemgr、mailbox 等）接入存储的唯一正确入口
 * - 内部兼容导出：平台工厂、底层适配层、测试使用；业务方不应直接依赖
 */

// ── 公共业务 API ─────────────────────────────────────────────────────
export * from './abstract-storage.js';

// Indexer 抽象、平台工厂（*-factory.ts）、平台判断（platform.ts）、
// 具体实现类（Node.js/HM/WASM）均为内部实现，
// 由 abstract-storage 通过 import 链间接引入，不在此导出。
