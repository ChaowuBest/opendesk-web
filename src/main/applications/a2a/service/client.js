#!/usr/bin/env node
/**
 * 通用 A2A Registry 注册客户端 - JavaScript版本
 * 支持通过 JSON 配置文件注册任意 Agent
 */

import fs from 'fs';

// 默认配置
const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const DEFAULT_PARENT = "registries/default";

/**
 * 通用 A2A Registry 客户端
 */
export class A2ARegistryClient {
  constructor(gatewayUrl = DEFAULT_GATEWAY_URL) {
    this.gatewayUrl = gatewayUrl;
  }

  /**
   * 从 JSON 文件加载 Agent Card
   * @param {string} cardPath - Agent Card JSON 文件路径
   * @returns {Promise<Object|null>} Agent Card 对象，失败返回 null
   */
  async loadAgentCard(cardPath) {
    try {
      if (!fs.existsSync(cardPath)) {
        console.error(`❌ Agent Card 文件不存在: ${cardPath}`);
        return null;
      }

      const fileContent = fs.readFileSync(cardPath, 'utf-8');
      const agentCard = JSON.parse(fileContent);

      // 验证必要字段
      if (!this._validateAgentCard(agentCard)) {
        return null;
      }

      const agentId = agentCard.name;
      if (!agentId) {
        console.error(`❌ Agent Card 中缺少 'name' 字段`);
        return null;
      }

      console.log(`✅ 成功加载 Agent Card: ${cardPath}`);
      console.log(`   Agent ID: ${agentId}`);
      console.log(`   Agent Name: ${agentCard.name || 'N/A'}`);
      console.log(`   Version: ${agentCard.version || 'N/A'}`);
      return agentCard;
    } catch (error) {
      if (error instanceof SyntaxError) {
        console.error(`❌ JSON 格式错误: ${error.message}`);
      } else {
        console.error(`❌ 加载 Agent Card 失败: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * 验证 Agent Card 格式
   * @param {Object} agentCard - Agent Card 对象
   * @returns {boolean} 是否有效
   */
  _validateAgentCard(agentCard) {
    const requiredFields = ['name', 'description', 'version', 'provider'];

    for (const field of requiredFields) {
      if (!(field in agentCard)) {
        console.error(`❌ Agent Card 缺少必要字段: ${field}`);
        return false;
      }
    }

    // 验证 provider
    const provider = agentCard.provider || {};
    if (!provider.url) {
      console.error(`❌ Agent Card 中 provider.url 字段不能为空`);
      return false;
    }

    return true;
  }


  /**
   * 打印分隔符
   * @param {string} title - 标题
   */
  _printSeparator(title) {
    console.log('\n' + '='.repeat(80));
    console.log(`  ${title}`);
    console.log('='.repeat(80));
  }

  /**
   * 打印响应结果
   * @param {Response} response - HTTP响应
   * @param {string} methodName - 方法名称
   */
  async _printResponse(response, methodName) {
    console.log(`\n[${methodName}] HTTP 状态码: ${response.status}`);
    console.log(`[${methodName}] 响应头:`, Object.fromEntries(response.headers.entries()));

    try {
      const responseJson = await response.json();
      console.log(`[${methodName}] 响应体 (JSON):`);
      console.log(JSON.stringify(responseJson, null, 2));
    } catch (error) {
      const text = await response.text();
      console.log(`[${methodName}] 响应体 (文本):`);
      console.log(text);
    }
  }

  /**
   * 注册 Agent
   * @param {Object} agentCard - Agent Card 对象
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<[string|null, boolean]>} [agent名称, 是否成功]
   */
  async registerAgent(agentCard, parent = DEFAULT_PARENT) {
    if (!agentCard) {
      console.error('❌ Agent Card 不能为空');
      return [null, false];
    }

    const agentId = agentCard.name;
    if (!agentId) {
      console.error('❌ Agent Card 中缺少 "name" 字段');
      return [null, false];
    }

    this._printSeparator(`注册 Agent: ${agentId}`);

    // 使用调用者提供的完整 Agent Card（不进行占位符替换）
    const card = JSON.parse(JSON.stringify(agentCard));

    // 移除 agent_id 字段（这个字段不应该在 card 中）
    delete card.agent_id;

    // 构建 URL 和请求
    const url = `${this.gatewayUrl}/v1/${parent}/agents`;
    const registryEntry = { card };
    const params = new URLSearchParams({ agent_id: agentId });

    console.log(`正在注册 Agent...`);
    console.log(`  Agent ID: ${agentId}`);
    console.log(`  Agent Name: ${card.name || 'N/A'}`);
    console.log(`  Parent: ${parent}`);
    console.log(`  服务地址: ${card.provider?.url || 'N/A'}`);

    // 显示支持的接口
    const supportedInterfaces = card.supportedInterfaces || [];
    if (supportedInterfaces.length > 0) {
      console.log(`  支持的接口:`);
      supportedInterfaces.forEach((iface, i) => {
        console.log(`    ${i + 1}. ${iface.url || 'N/A'} (${iface.protocolBinding || 'N/A'})`);
      });
    }

    // 显示技能信息
    const skills = card.skills || [];
    if (skills.length > 0) {
      console.log(`  支持的技能:`);
      skills.forEach((skill, i) => {
        console.log(`    ${i + 1}. ${skill.name || 'N/A'} (${skill.id || 'N/A'})`);
        console.log(`       - ${skill.description || 'N/A'}`);
        const tags = skill.tags || [];
        if (tags.length > 0) {
          console.log(`       - 标签: ${tags.join(', ')}`);
        }
        const examples = skill.examples || [];
        if (examples.length > 0) {
          console.log(`       - 示例: ${examples.join(', ')}`);
        }
      });
    }

    // 发送注册请求
    try {
      const response = await fetch(`${url}?${params}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(registryEntry),
      });

      await this._printResponse(response, 'RegisterAgent');

      if (response.status === 200) {
        const result = await response.json();
        console.log(`\n✅ Agent 注册成功!`);
        console.log(`   Agent Name: ${result.name || 'N/A'}`);
        console.log(`   可以开始提供服务`);
        return [result.name, true];
      } else if (response.status === 409) {
        console.log(`\n⚠️  Agent '${agentId}' 已经存在`);
        console.log(`   请先注销现有 Agent 或检查服务状态`);
        return [null, false];
      } else {
        console.log(`\n❌ Agent 注册失败: HTTP ${response.status}`);
        return [null, false];
      }
    } catch (error) {
      console.error(`\n❌ 请求错误: ${error.message}`);
      console.error('请确保 gRPC-Gateway 正在运行');
      return [null, false];
    }
  }

  /**
   * 注销 Agent
   * @param {string} agentId - Agent ID
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<[any|null, boolean]>} [响应结果, 是否成功]
   */
  async unregisterAgent(agentId, parent = DEFAULT_PARENT) {
    if (!agentId) {
      console.error('❌ Agent ID 不能为空');
      return [null, false];
    }

    this._printSeparator(`注销 Agent: ${agentId}`);

    const agentName = `${parent}/agents/${agentId}`;

    console.log(`正在注销 Agent...`);
    console.log(`  Agent ID: ${agentId}`);
    console.log(`  Agent Name: ${agentName}`);

    // 检查 agent 是否存在
    const checkUrl = `${this.gatewayUrl}/v1/${agentName}`;

    try {
      console.log(`  检查 Agent 存在性...`);
      const checkResponse = await fetch(`${checkUrl}?view=AGENT_VIEW_BASIC`);

      if (checkResponse.status === 200) {
        const result = await checkResponse.json();
        const card = result.card || {};
        console.log(`  找到 Agent: ${card.name || 'N/A'}`);
        console.log(`  版本: ${card.version || 'N/A'}`);
      } else if (checkResponse.status === 404) {
        console.log(`\n⚠️  Agent '${agentId}' 不存在，无需注销`);
        return [null, true];
      } else {
        console.log(`\n❌ 检查 Agent 存在性时出错: HTTP ${checkResponse.status}`);
        console.log(`   继续尝试注销...`);
      }
    } catch (error) {
      console.log(`\n❌ 检查 Agent 存在性时出错: ${error.message}`);
      console.log(`   继续尝试注销...`);
    }

    // 执行注销
    const deleteUrl = `${this.gatewayUrl}/v1/${agentName}`;

    try {
      console.log(`  执行注销操作...`);
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
      });

      await this._printResponse(response, 'UnregisterAgent');

      if (response.status === 200) {
        console.log(`\n✅ Agent 注销成功!`);
        console.log(`   Agent ID: ${agentId}`);
        console.log(`   服务已停止`);
        const result = await response.json().catch(() => ({}));
        return [result, true];
      } else if (response.status === 404) {
        console.log(`\n⚠️  Agent '${agentId}' 不存在`);
        return [null, true];
      } else {
        console.log(`\n❌ Agent 注销失败: HTTP ${response.status}`);
        return [null, false];
      }
    } catch (error) {
      console.error(`\n❌ 请求错误: ${error.message}`);
      return [null, false];
    }
  }

  /**
   * 获取 Agent Entry（GetAgentEntry RPC）
   * @param {string} agentName - Agent 资源名称，格式: registries/{registry_id}/agents/{agent_id} 或仅 agent_id
   * @param {string} view - 视图级别，可选值: AGENT_VIEW_UNSPECIFIED, AGENT_VIEW_BASIC, AGENT_VIEW_FULL
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<Object|null>} RegistryEntry 对象或 null
   */
  async getAgentEntry(agentName, view = 'AGENT_VIEW_FULL', parent = DEFAULT_PARENT) {
    // 如果只提供了 agent_id，构建完整的资源名称
    if (!agentName.includes('/')) {
      agentName = `${parent}/agents/${agentName}`;
    }

    const url = `${this.gatewayUrl}/v1/${agentName}`;
    const params = new URLSearchParams();
    if (view && view !== 'AGENT_VIEW_UNSPECIFIED') {
      params.append('view', view);
    }

    try {
      const queryString = params.toString();
      const response = await fetch(
        queryString ? `${url}?${queryString}` : url
      );

      if (response.status === 200) {
        return await response.json();
      } else if (response.status === 404) {
        return null;
      } else {
        console.error(`❌ 获取 Agent Entry 失败: HTTP ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`❌ 请求错误: ${error.message}`);
      return null;
    }
  }

  /**
   * 检查 Agent 状态（便捷方法，内部调用 getAgentEntry）
   * @param {string} agentId - Agent ID
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<boolean>} 是否已注册
   */
  async checkAgentStatus(agentId, parent = DEFAULT_PARENT) {
    if (!agentId) {
      console.error('❌ Agent ID 不能为空');
      return false;
    }

    const result = await this.getAgentEntry(agentId, 'AGENT_VIEW_FULL', parent);

    if (result) {
      const card = result.card || {};

      console.log(`\n🔍 Agent 状态:`);
      console.log(`   状态: ✅ 已注册`);
      console.log(`   Agent ID: ${agentId}`);
      console.log(`   名称: ${card.name || 'N/A'}`);
      console.log(`   版本: ${card.version || 'N/A'}`);
      console.log(`   描述: ${card.description || 'N/A'}`);

      const provider = card.provider || {};
      if (provider.url) {
        console.log(`   服务地址: ${provider.url}`);
      }

      // 显示支持的接口
      const supportedInterfaces = card.supportedInterfaces || [];
      if (supportedInterfaces.length > 0) {
        console.log(`   支持的接口:`);
        supportedInterfaces.forEach((iface, i) => {
          console.log(`     ${i + 1}. ${iface.url || 'N/A'} (${iface.protocolBinding || 'N/A'})`);
        });
      }

      const skills = card.skills || [];
      console.log(`   技能数量: ${skills.length}`);

      if (skills.length > 0) {
        console.log(`   技能列表:`);
        skills.forEach((skill, i) => {
          console.log(`     ${i + 1}. ${skill.name || 'N/A'} (${skill.id || 'N/A'})`);
          const examples = skill.examples || [];
          if (examples.length > 0) {
            console.log(`        示例: ${examples.join(', ')}`);
          }
        });
      }

      return true;
    } else {
      console.log(`\n🔍 Agent 状态:`);
      console.log(`   状态: ❌ 未注册`);
      console.log(`   Agent ID: ${agentId}`);
      return false;
    }
  }

  /**
   * 列出 Agents（ListAgents RPC）
   * @param {Object} options - 选项对象
   * @param {number} options.pageSize - 每页返回的 Agent 数量
   * @param {string} options.pageToken - 分页 token，从上次响应中获取
   * @param {string} options.filter - 过滤表达式，遵循 AIP-160 语法（例如: "card.capabilities.streaming = true"）
   * @param {string} options.view - 视图级别，可选值: AGENT_VIEW_UNSPECIFIED, AGENT_VIEW_BASIC, AGENT_VIEW_FULL
   * @param {string} options.filterKeyword - 客户端过滤关键词（向后兼容，如果提供则进行客户端过滤）
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<Object|null>} ListAgentsResponse 对象，包含 registryEntries 和 nextPageToken
   */
  async listAgents(options = {}, parent = DEFAULT_PARENT) {
    // 向后兼容：如果第一个参数是字符串，则作为 filterKeyword
    if (typeof options === 'string') {
      options = { filterKeyword: options };
    }

    const {
      pageSize = 50,
      pageToken = null,
      filter = null,
      view = 'AGENT_VIEW_BASIC',
      filterKeyword = null,
    } = options;

    const url = `${this.gatewayUrl}/v1/${parent}/agents`;
    const params = new URLSearchParams();

    if (pageSize) {
      params.append('pageSize', pageSize.toString());
    }
    if (pageToken) {
      params.append('pageToken', pageToken);
    }
    if (filter) {
      params.append('filter', filter);
    }
    if (view && view !== 'AGENT_VIEW_UNSPECIFIED') {
      params.append('view', view);
    }

    try {
      const queryString = params.toString();
      const response = await fetch(
        queryString ? `${url}?${queryString}` : url
      );

      if (response.status !== 200) {
        console.log(`\n⚠️  获取 Agent 列表失败: HTTP ${response.status}`);
        return null;
      }

      const result = await response.json();
      const entries = result.registryEntries || [];
      const nextPageToken = result.nextPageToken || null;

      // 客户端过滤（向后兼容，如果提供了 filterKeyword）
      let filteredAgents = entries;
      if (filterKeyword) {
        const keyword = filterKeyword.toLowerCase();
        filteredAgents = entries.filter((entry) => {
          const card = entry.card || {};
          const name = (card.name || '').toLowerCase();
          const description = (card.description || '').toLowerCase();
          const agentName = (entry.name || '').toLowerCase();

          return (
            name.includes(keyword) ||
            description.includes(keyword) ||
            agentName.includes(keyword)
          );
        });
      }

      console.log(`\n📋 Agent 列表 (${filteredAgents.length} 个):`);
      if (filter) {
        console.log(`   服务器过滤: ${filter}`);
      }
      if (filterKeyword) {
        console.log(`   客户端过滤关键词: ${filterKeyword}`);
      }
      if (nextPageToken) {
        console.log(`   下一页 token: ${nextPageToken}`);
      }

      if (filteredAgents.length === 0) {
        console.log('   (无匹配的 Agent)');
      } else {
        filteredAgents.forEach((entry) => {
          const agentName = entry.name || '';
          const agentId = agentName.includes('/')
            ? agentName.split('/').pop()
            : agentName;
          const card = entry.card || {};

          const skills = card.skills || [];
          const skillsDesc =
            skills.length > 0 ? `(${skills.length} 个技能)` : '';
          console.log(
            `   📄 ${agentId}: ${card.name || 'N/A'} v${card.version || 'N/A'} ${skillsDesc}`
          );

          // 显示支持的接口
          const supportedInterfaces = card.supportedInterfaces || [];
          if (supportedInterfaces.length > 0) {
            supportedInterfaces.forEach((iface) => {
              console.log(`      🔗 ${iface.url || 'N/A'} (${iface.protocolBinding || 'N/A'})`);
            });
          }

          // 显示技能
          if (skills.length > 0) {
            skills.slice(0, 3).forEach((skill) => {
              console.log(`      └─ ${skill.name || 'N/A'}`);
            });
            if (skills.length > 3) {
              console.log(
                `      └─ ... 还有 ${skills.length - 3} 个技能`
              );
            }
          }
        });
      }

      // 显示统计
      console.log(`\n📊 统计信息:`);
      console.log(`   总 Agents: ${entries.length}`);
      if (filterKeyword) {
        console.log(`   匹配的 Agents: ${filteredAgents.length}`);
      }
      if (nextPageToken) {
        console.log(`   还有更多结果，使用 pageToken 获取下一页`);
      }

      return {
        registryEntries: filteredAgents,
        nextPageToken,
      };
    } catch (error) {
      console.log(`\n⚠️  获取 Agent 列表失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 更新 Agent（UpdateAgent RPC）
   * @param {string} agentName - Agent 资源名称，格式: registries/{registry_id}/agents/{agent_id} 或仅 agent_id
   * @param {Object} registryEntry - 要更新的 RegistryEntry 对象
   * @param {Object} updateMask - FieldMask 对象，指定要更新的字段路径，格式: { paths: ['card', 'card.skills'] }
   * @param {string} parent - Parent registry（默认: "registries/default"）
   * @returns {Promise<Object|null>} 更新后的 RegistryEntry 对象或 null
   */
  async updateAgent(agentName, registryEntry, updateMask, parent = DEFAULT_PARENT) {
    // 如果只提供了 agent_id，构建完整的资源名称
    if (!agentName.includes('/')) {
      agentName = `${parent}/agents/${agentName}`;
    }

    // 确保 registryEntry 包含 name
    registryEntry.name = agentName;

    const url = `${this.gatewayUrl}/v1/${agentName}`;
    const params = new URLSearchParams();

    // 构建 updateMask 查询参数
    // gRPC-Gateway 格式: updateMask.paths=card&updateMask.paths=card.skills
    if (updateMask && updateMask.paths && Array.isArray(updateMask.paths)) {
      updateMask.paths.forEach((path) => {
        params.append('updateMask.paths', path);
      });
    }

    try {
      const queryString = params.toString();
      const response = await fetch(
        queryString ? `${url}?${queryString}` : url,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(registryEntry),
        }
      );

      await this._printResponse(response, 'UpdateAgent');

      if (response.status === 200) {
        const result = await response.json();
        console.log(`\n✅ Agent 更新成功!`);
        console.log(`   Agent Name: ${result.name || 'N/A'}`);
        return result;
      } else {
        console.log(`\n❌ Agent 更新失败: HTTP ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`\n❌ 请求错误: ${error.message}`);
      return null;
    }
  }
}

