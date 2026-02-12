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
 * Recall 应用渲染器入口
 * 
 * 此文件是应用加载系统的标准入口点。
 * 导出所有必要的组件以便应用容器能够正确加载 Recall 应用。
 */

// 导入主入口组件
import '../widgets/entry.js';

// 导入子页面组件
import '../widgets/recording/recordingPage.js';
import '../widgets/browser/browserPage.js';

// 导入浏览页面的子组件
import '../widgets/browser/components/activityList.js';

// 注意：所有组件都通过各自文件中的 customElements.define() 自动注册
// 此入口文件仅需确保所有必要的组件被导入即可
