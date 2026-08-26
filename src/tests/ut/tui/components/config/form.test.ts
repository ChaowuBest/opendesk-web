import { jest } from '@jest/globals';
import { Key } from '@earendil-works/pi-tui';
import { ConfigForm } from '../../../../../main/tui/components/config/form.js';

function createTuiMock() {
    return {
        addInputListener: jest.fn(() => jest.fn()),
        setFocus: jest.fn(),
        requestRender: jest.fn()
    } as any;
}

describe('ConfigForm field changes', () => {
    test('notifies callers after boolean and select fields change', () => {
        const tui = createTuiMock();
        const onFieldChange = jest.fn();
        const form = new ConfigForm(
            tui,
            'Network',
            [
                { type: 'boolean', key: 'enabled', label: 'Enabled', value: false },
                { type: 'select', key: 'mode', label: 'Mode', value: 'none', options: ['none', 'custom'] }
            ],
            [],
            jest.fn(),
            jest.fn(),
            onFieldChange
        );
        const handleInput = (data: string) =>
            (
                form as unknown as {
                    handleKeyInput: (input: string) => { consume?: boolean; data?: string } | undefined;
                }
            ).handleKeyInput(data);

        handleInput(Key.enter);
        handleInput(Key.down);
        handleInput(Key.right);

        expect(onFieldChange).toHaveBeenNthCalledWith(1, { enabled: true, mode: 'none' });
        expect(onFieldChange).toHaveBeenNthCalledWith(2, { enabled: true, mode: 'custom' });
    });

    test('skips disabled fields and does not toggle them', () => {
        const form = new ConfigForm(
            createTuiMock(),
            'Display',
            [
                { type: 'boolean', key: 'first', label: 'First', value: false },
                { type: 'boolean', key: 'locked', label: 'Locked', value: false, disabled: true },
                { type: 'select', key: 'mode', label: 'Mode', value: 'minimal', options: ['minimal', 'full'] }
            ],
            [],
            jest.fn(),
            jest.fn()
        );
        const handleInput = (data: string) =>
            (
                form as unknown as {
                    handleKeyInput: (input: string) => { consume?: boolean; data?: string } | undefined;
                }
            ).handleKeyInput(data);

        handleInput(Key.down);
        handleInput(Key.enter);

        expect(form.getValues()).toEqual({ first: false, locked: false, mode: 'full' });
    });
});
