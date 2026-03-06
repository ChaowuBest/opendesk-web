/**
 * Standalone memory system test runner
 * Usage: npx tsx src/tests/run-memory-tests.ts
 */

import { runMemoryTests } from './ut/memory/memory.test.js';

async function main() {
    const passed = await runMemoryTests();
    process.exit(passed ? 0 : 1);
}

main();
