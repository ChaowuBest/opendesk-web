import { resolveKey, modifiersBitmask, sleep, withRetry } from '../cdp/utils';

describe('embedBrowserUse/cdp/utils', () => {
    describe('resolveKey', () => {
        it('should resolve named keys', () => {
            const enter = resolveKey('Enter');
            expect(enter.key).toBe('Enter');
            expect(enter.code).toBe('Enter');
            expect(enter.keyCode).toBe(13);
        });

        it('should be case-insensitive for named keys', () => {
            const tab = resolveKey('tab');
            expect(tab.key).toBe('Tab');
            expect(tab.keyCode).toBe(9);
        });

        it('should resolve single characters', () => {
            const a = resolveKey('a');
            expect(a.key).toBe('a');
            expect(a.code).toBe('KeyA');
            expect(a.text).toBe('a');
        });

        it('should handle uppercase single chars', () => {
            const A = resolveKey('A');
            expect(A.key).toBe('A');
            expect(A.code).toBe('KeyA');
        });

        it('should resolve arrow keys', () => {
            expect(resolveKey('ArrowDown').keyCode).toBe(40);
            expect(resolveKey('ArrowUp').keyCode).toBe(38);
            expect(resolveKey('ArrowLeft').keyCode).toBe(37);
            expect(resolveKey('ArrowRight').keyCode).toBe(39);
        });

        it('should handle function keys', () => {
            expect(resolveKey('F1').keyCode).toBe(112);
            expect(resolveKey('F12').keyCode).toBe(123);
        });

        it('should fallback for unknown multi-char keys', () => {
            const unknown = resolveKey('SomeKey');
            expect(unknown.key).toBe('SomeKey');
            expect(unknown.keyCode).toBe(0);
        });
    });

    describe('modifiersBitmask', () => {
        it('should return 0 for no modifiers', () => {
            expect(modifiersBitmask()).toBe(0);
            expect(modifiersBitmask([])).toBe(0);
        });

        it('should compute Alt bitmask', () => {
            expect(modifiersBitmask(['Alt'])).toBe(1);
        });

        it('should compute Control bitmask', () => {
            expect(modifiersBitmask(['Control'])).toBe(2);
            expect(modifiersBitmask(['Ctrl'])).toBe(2);
        });

        it('should compute Meta bitmask', () => {
            expect(modifiersBitmask(['Meta'])).toBe(4);
            expect(modifiersBitmask(['Command'])).toBe(4);
            expect(modifiersBitmask(['Cmd'])).toBe(4);
        });

        it('should compute Shift bitmask', () => {
            expect(modifiersBitmask(['Shift'])).toBe(8);
        });

        it('should combine multiple modifiers', () => {
            expect(modifiersBitmask(['Control', 'Shift'])).toBe(2 | 8);
            expect(modifiersBitmask(['Alt', 'Meta'])).toBe(1 | 4);
        });
    });

    describe('sleep', () => {
        it('should resolve after the given time', async () => {
            const start = Date.now();
            await sleep(50);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(40);
        });
    });

    describe('withRetry', () => {
        it('should return result on first success', async () => {
            const result = await withRetry(async () => 42);
            expect(result).toBe(42);
        });

        it('should retry on failure and succeed', async () => {
            let attempt = 0;
            const result = await withRetry(
                async () => {
                    attempt++;
                    if (attempt < 3) throw new Error('not yet');
                    return 'ok';
                },
                { delays: [0, 0, 0] }
            );
            expect(result).toBe('ok');
            expect(attempt).toBe(3);
        });

        it('should throw after all retries exhausted', async () => {
            await expect(
                withRetry(
                    async () => {
                        throw new Error('always fail');
                    },
                    { delays: [0, 0] }
                )
            ).rejects.toThrow('always fail');
        });

        it('should respect shouldRetry predicate', async () => {
            let attempt = 0;
            await expect(
                withRetry(
                    async () => {
                        attempt++;
                        throw new Error('non-retryable');
                    },
                    {
                        delays: [0, 0, 0],
                        shouldRetry: () => false
                    }
                )
            ).rejects.toThrow('non-retryable');
            expect(attempt).toBe(1);
        });
    });
});
