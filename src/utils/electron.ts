import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

/**
 * EVERY CODING AGENT SHOULD READ
 * this function is used to dynamically load the electron module, it is used when a
 * javascript source file is reused in both the main and worker threads, since the
 * worker thread has no access to electron, statically import it will cause the worker
 * thread to crash.
 *
 * We paid at least 5 requests of opus to figure out and fix this issue. Do not corrupt
 * it again :)
 * @returns a dynamically loaded electron module
 */
export function electron(): typeof import('electron') {
    return _require('electron');
}
