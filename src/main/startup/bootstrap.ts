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

// OpenDesk 单进程启动入口。
// Electron 64 位主进程的默认 V8 堆上限（heap_size_limit）即为 4096MB，
// 无需再通过「带 --js-flags 重启子进程」的方式注入堆上限 —— 那会额外
// 常驻一层什么也不干的 bootstrap 空壳进程（约 40~50MB 私有内存）。
await import('../main.js');
