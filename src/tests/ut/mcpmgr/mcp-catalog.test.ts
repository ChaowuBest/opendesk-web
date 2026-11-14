import { buildMcpCatalog, listMcpCatalog } from '../../../main/applications/mcpmgr/mcp-catalog.js';
import { demoTools } from './fixtures/inventory.js';

test('a compact complete catalog exposes capabilities without schemas or query matching', () => {
    const tools = demoTools();
    const page = buildMcpCatalog(tools);
    expect(page.kind).toBe('tools');
    expect(page.total).toBe(24);
    expect(page.nextOffset).toBeNull();
    expect(JSON.stringify(page)).toContain('reserve_stock');
    expect(JSON.stringify(page)).toContain('Reserve inventory');
    expect(JSON.stringify(page)).not.toContain('Internal specification');
});

test('large catalogs start with a server directory and can be traversed without omissions', () => {
    const tools = demoTools(120).map((tool, index) => ({ ...tool, serverId: `demo-${index % 3}` }));
    const directory = buildMcpCatalog(tools);
    expect(directory.kind).toBe('servers');
    expect(directory.total).toBe(3);
    const seen: string[] = [];
    let offset: number | null = 0;
    do {
        const page = listMcpCatalog(tools, { serverId: 'demo-1', offset }, 900);
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(900);
        seen.push(...page.items.map((entry) => ('name' in entry ? entry.name : '')));
        offset = page.nextOffset;
    } while (offset !== null);
    expect(seen).toEqual(tools.filter((tool) => tool.serverId === 'demo-1').map((tool) => tool.name));
});

test('unknown servers return an empty directory instead of unrelated tools', () => {
    const page = listMcpCatalog(demoTools(), { serverId: 'missing' });
    expect(page.items).toEqual([]);
    expect(page.nextOffset).toBeNull();
});

test('long descriptions advertise truncation and preserve an exact lookup identity', () => {
    const tools = demoTools(1);
    tools[0].description = 'Long specification. '.repeat(100);
    const page = buildMcpCatalog(tools);
    expect(page.items[0]).toMatchObject({ serverId: 'demo-inventory', name: 'reserve_stock', truncated: true });
    expect(JSON.stringify(page).length).toBeLessThan(1000);
});
