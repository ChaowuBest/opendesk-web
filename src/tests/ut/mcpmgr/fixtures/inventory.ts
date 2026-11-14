import type { McpToolInfo } from '../../../../main/applications/mcpmgr/common.js';

export function demoTools(count = 24): McpToolInfo[] {
    return Array.from({ length: count }, (_, index) => ({
        serverId: 'demo-inventory',
        serverName: 'inventory',
        name: index === 0 ? 'reserve_stock' : `inspect_bin_${index}`,
        description: index === 0 ? 'Reserve inventory for a shipment.' : `Inspect storage bin ${index}.`,
        inputSchema: {
            type: 'object',
            properties: {
                shipment: { type: 'string', description: 'Internal specification. '.repeat(index === 0 ? 240 : 80) }
            },
            required: ['shipment'],
            additionalProperties: false
        }
    }));
}
