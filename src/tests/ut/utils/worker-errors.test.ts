import { describe, expect, jest, test } from '@jest/globals';
import { handleWorkerUncaughtException, handleWorkerUnhandledRejection } from '../../../main/utils/worker-errors.js';

function createLogger() {
    return {
        warn: jest.fn(),
        error: jest.fn()
    };
}

describe('worker fatal error handling', () => {
    test('ignores EPIPE after logging a warning', () => {
        const logger = createLogger();
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

        expect(() => handleWorkerUncaughtException(error, 'uncaughtException', logger)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('logs and rethrows uncaught exceptions other than EPIPE', () => {
        const logger = createLogger();
        const error = new Error('boom');

        expect(() => handleWorkerUncaughtException(error, 'uncaughtException', logger)).toThrow(error);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    test('logs and rethrows unhandled rejection reasons', () => {
        const logger = createLogger();
        const error = new Error('rejected');

        expect(() => handleWorkerUnhandledRejection(error, logger)).toThrow(error);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });

    test('ignores EPIPE rejection reasons after logging a warning', () => {
        const logger = createLogger();
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

        expect(() => handleWorkerUnhandledRejection(error, logger)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('与主进程共用可恢复判定：已销毁对象错误不再杀死 worker', () => {
        const logger = createLogger();

        expect(() =>
            handleWorkerUncaughtException(new TypeError('Object has been destroyed'), 'uncaughtException', logger)
        ).not.toThrow();
        expect(() => handleWorkerUnhandledRejection(new TypeError('Object has been destroyed'), logger)).not.toThrow();
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.error).not.toHaveBeenCalled();
    });
});
