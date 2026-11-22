import { SlashCommandRegistry } from '../../../../main/tui/commands/index';

function cmd(name: string) {
    return { name, description: name, execute: () => {} };
}

function names(registry: SlashCommandRegistry): string[] {
    return registry.getAll().map((command) => command.name);
}

describe('SlashCommandRegistry.reorder', () => {
    test('restores the previous order after unregister + re-register', () => {
        const registry = new SlashCommandRegistry();
        for (const name of ['a', 'b', 'c']) registry.register(cmd(name));
        const orderBefore = names(registry);

        // 模拟语言切换：注销后重新注册会把命令挤到末尾
        registry.unregister('a');
        registry.register(cmd('a'));
        expect(names(registry)).toEqual(['b', 'c', 'a']);

        registry.reorder(orderBefore);
        expect(names(registry)).toEqual(['a', 'b', 'c']);
    });

    test('skips names that are no longer registered and keeps the rest', () => {
        const registry = new SlashCommandRegistry();
        for (const name of ['a', 'b', 'c']) registry.register(cmd(name));
        registry.unregister('b');

        registry.reorder(['a', 'b', 'c']);

        expect(names(registry)).toEqual(['a', 'c']);
    });

    test('appends commands missing from the given order instead of dropping them', () => {
        const registry = new SlashCommandRegistry();
        for (const name of ['a', 'b', 'c']) registry.register(cmd(name));

        registry.reorder(['c']);

        expect(names(registry)).toEqual(['c', 'a', 'b']);
        expect(registry.get('a')?.description).toBe('a');
    });

    test('is a no-op for an empty order', () => {
        const registry = new SlashCommandRegistry();
        for (const name of ['a', 'b']) registry.register(cmd(name));

        registry.reorder([]);

        expect(names(registry)).toEqual(['a', 'b']);
    });
});
