#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Test MCP server for OpenDesk MCP tools/list_changed handling.
 *
 * It exposes two tools at startup, then adds a third tool after a short delay
 * and sends notifications/tools/list_changed over stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const delayMs = Number(process.env.OPENDESK_MCP_TEST_CHANGE_DELAY_MS || 1500);
let dynamicToolEnabled = false;
let changeCount = 0;

const server = new Server(
    {
        name: 'opendesk-tools-list-changed-test',
        version: '1.0.0'
    },
    {
        capabilities: {
            tools: {
                listChanged: true
            }
        }
    }
);

function getTools() {
    const tools = [
        {
            name: 'static_echo',
            description: 'Echo text back from the static test tool.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'Text to echo'
                    }
                },
                required: ['text']
            }
        },
        {
            name: 'force_tool_change',
            description: 'Toggle the dynamic tool and send tools/list_changed.',
            inputSchema: {
                type: 'object',
                properties: {}
            }
        }
    ];

    if (dynamicToolEnabled) {
        tools.push({
            name: 'dynamic_time',
            description: 'Return the current ISO time. This tool appears after tools/list_changed.',
            inputSchema: {
                type: 'object',
                properties: {}
            }
        });
    }

    return tools;
}

async function sendToolListChanged() {
    changeCount += 1;
    await server.sendToolListChanged();
    console.error(`[opendesk-mcp-test] sent tools/list_changed #${changeCount}`);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getTools()
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (name === 'static_echo') {
        return {
            content: [
                {
                    type: 'text',
                    text: String(request.params.arguments?.text || '')
                }
            ]
        };
    }

    if (name === 'force_tool_change') {
        dynamicToolEnabled = !dynamicToolEnabled;
        await sendToolListChanged();
        return {
            content: [
                {
                    type: 'text',
                    text: dynamicToolEnabled ? 'dynamic_time enabled' : 'dynamic_time disabled'
                }
            ]
        };
    }

    if (name === 'dynamic_time' && dynamicToolEnabled) {
        return {
            content: [
                {
                    type: 'text',
                    text: new Date().toISOString()
                }
            ]
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

server.oninitialized = () => {
    setTimeout(() => {
        dynamicToolEnabled = true;
        sendToolListChanged().catch((err) => {
            console.error(`[opendesk-mcp-test] failed to send tools/list_changed: ${err.message}`);
        });
    }, delayMs);
};

await server.connect(new StdioServerTransport());
