export interface McpServerConfig {
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    enabled: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    source?: string;
    registryId?: string;
    registryMcpId?: string;
}

export interface McpToolInfo {
    serverId: string;
    serverName: string;
    name: string;
    description: string;
    inputSchema: object;
}

export interface McpServerState extends McpServerConfig {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    tools: { name: string; description: string; inputSchema?: object }[];
    toolsChangedCount?: number;
    lastToolsChangedAt?: string;
}
