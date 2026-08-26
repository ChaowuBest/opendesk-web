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

        it('should resolve digit characters', () => {
            const d = resolveKey('4');
            expect(d.key).toBe('4');
            expect(d.code).toBe('Digit4');
            expect(d.keyCode).toBe(52);
            expect(d.text).toBe('4');
        });

        it('should resolve shift-requiring symbol $ to Digit4', () => {
            const dollar = resolveKey('$');
            expect(dollar.key).toBe('$');
            expect(dollar.code).toBe('Digit4');
            expect(dollar.keyCode).toBe(52);
            expect(dollar.shiftKey).toBe(true);
            expect(dollar.text).toBe('$');
        });

        it('should resolve shift-requiring symbol @ to Digit2', () => {
            const at = resolveKey('@');
            expect(at.key).toBe('@');
            expect(at.code).toBe('Digit2');
            expect(at.keyCode).toBe(50);
            expect(at.shiftKey).toBe(true);
        });

        it('should resolve non-shift symbol - to Minus', () => {
            const minus = resolveKey('-');
            expect(minus.key).toBe('-');
            expect(minus.code).toBe('Minus');
            expect(minus.keyCode).toBe(189);
            expect(minus.shiftKey).toBe(false);
        });

        it('should resolve shift symbol _ to Minus with shiftKey', () => {
            const underscore = resolveKey('_');
            expect(underscore.key).toBe('_');
            expect(underscore.code).toBe('Minus');
            expect(underscore.keyCode).toBe(189);
            expect(underscore.shiftKey).toBe(true);
        });

        it('should resolve comma and period correctly', () => {
            expect(resolveKey(',').code).toBe('Comma');
            expect(resolveKey(',').shiftKey).toBe(false);
            expect(resolveKey('.').code).toBe('Period');
            expect(resolveKey('.').shiftKey).toBe(false);
        });

        it('should resolve shift symbols < and > to comma/period with shiftKey', () => {
            expect(resolveKey('<').code).toBe('Comma');
            expect(resolveKey('<').shiftKey).toBe(true);
            expect(resolveKey('>').code).toBe('Period');
            expect(resolveKey('>').shiftKey).toBe(true);
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
