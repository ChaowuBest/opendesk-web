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

/** 展平后的单个参数描述（技能中心 / MCP 详情的工具参数表格共用形态） */
export interface SchemaParamInfo {
    name: string;
    type: string;
    description: string;
    required: boolean;
}

/**
 * 把 JSON schema 的 properties 展平成参数描述列表。
 *
 * 纯数据变换、无运行时依赖，供技能中心（skill toolsets 与内部 MCP 工具）和
 * MCP 管理页的工具详情共用；渲染侧与主进程侧不要各自再实现一份。
 */
export function flattenSchemaParams(schema: Record<string, unknown> | object | undefined): SchemaParamInfo[] {
    const jsonSchema = (schema ?? {}) as Record<string, unknown>;
    const required: string[] = Array.isArray(jsonSchema['required']) ? (jsonSchema['required'] as string[]) : [];
    const properties = (jsonSchema['properties'] || {}) as Record<string, unknown>;
    const paramsList: SchemaParamInfo[] = [];
    for (const [paramName, paramSchema] of Object.entries(properties)) {
        const ps = (paramSchema ?? {}) as Record<string, unknown>;
        const paramType = Array.isArray(ps['type'])
            ? (ps['type'] as string[]).join(' | ')
            : typeof ps['type'] === 'string'
              ? ps['type']
              : 'any';
        paramsList.push({
            name: paramName,
            type: paramType,
            description: typeof ps['description'] === 'string' ? ps['description'] : '',
            required: required.includes(paramName)
        });
    }
    return paramsList;
}
