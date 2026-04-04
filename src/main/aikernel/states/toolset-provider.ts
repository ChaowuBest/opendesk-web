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

import { BaseToolset } from '../tool.js';

/**
 * 工具集提供者接口
 * 用于解耦 aikernel 与 applications 层，由外部实现具体的工具集提供逻辑
 */
export interface ToolsetProvider {
    /**
     * 获取所有可用的工具集
     * @returns 工具集数组
     */
    listAvailableToolsets(): Promise<BaseToolset[]>;
}

/**
 * 空实现的 ToolsetProvider，用于不需要应用工具集的场景
 */
export class EmptyToolsetProvider implements ToolsetProvider {
    async listAvailableToolsets(): Promise<BaseToolset[]> {
        return [];
    }
}
