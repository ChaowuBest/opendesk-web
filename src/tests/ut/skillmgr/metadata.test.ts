import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import {
    OpendeskMetaSchema,
    formatOpendeskMeta,
    loadAndValidateOpendeskMeta,
    mutateOpendeskMeta,
    parseOpendeskMeta,
    parseTestResult,
    TestFailureReasonCategory
} from '../../../main/applications/skillmgr/analyzer/metadata.js';

describe('skillmgr metadata test failure reason', () => {
    const baseTestCase = {
        index: 1,
        title: '失败分类兼容性',
        prompt: '执行一个测试用例',
        expectedResult: '测试用例应通过',
        status: 'failed',
        error: '实际结果与预期不一致'
    };

    test('accepts old test cases without failure reason category', () => {
        const result = OpendeskMetaSchema.safeParse({
            testCases: [baseTestCase]
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.testCases?.[0].failureReasonCategory).toBeUndefined();
    });

    test('accepts test cases with failure reason category', () => {
        const result = OpendeskMetaSchema.safeParse({
            testCases: [
                {
                    ...baseTestCase,
                    failureReasonCategory: TestFailureReasonCategory.DependencyRuntime
                }
            ]
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.testCases?.[0].failureReasonCategory).toBe(TestFailureReasonCategory.DependencyRuntime);
    });

    test('requires failed test result to include failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'failed',
                message: '缺少 python 依赖'
            })
        );

        expect(result.success).toBe(false);
    });

    test('accepts failed test result with failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'failed',
                message: '缺少 python 依赖',
                failureReasonCategory: TestFailureReasonCategory.DependencyRuntime
            })
        );

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.failureReasonCategory).toBe(TestFailureReasonCategory.DependencyRuntime);
    });

    test('accepts succeeded test result without failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'succeeded',
                message: '测试通过'
            })
        );

        expect(result.success).toBe(true);
    });
});

describe('skillmgr metadata fallback and atomic mutation', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('preserves fallback fields for every dependency category through load/format roundtrip', () => {
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-roundtrip-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        const fallback = {
            fallback: 'linux_vm',
            note: 'use the Linux VM',
            recordedAt: 'not-a-valid-date'
        };
        const input = {
            dependencies: {
                envVars: [{ name: 'API_KEY', ...fallback }],
                pythonPackages: [{ name: 'requests', ...fallback }],
                npmPackages: [{ name: 'axios', ...fallback }],
                binaries: [{ name: 'ffmpeg', ...fallback }]
            }
        };

        try {
            fs.writeFileSync(metaPath, formatOpendeskMeta(parseOpendeskMeta(JSON.stringify(input))), 'utf8');
            const roundtripped = loadAndValidateOpendeskMeta(skillDir);

            expect(roundtripped?.dependencies?.envVars?.[0]).toMatchObject(fallback);
            expect(roundtripped?.dependencies?.pythonPackages?.[0]).toMatchObject(fallback);
            expect(roundtripped?.dependencies?.npmPackages?.[0]).toMatchObject(fallback);
            expect(roundtripped?.dependencies?.binaries?.[0]).toMatchObject(fallback);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('accepts a missing recordedAt so fallback sunset cleanup can remove the stale fields', () => {
        const loaded = parseOpendeskMeta(
            JSON.stringify({
                dependencies: {
                    binaries: [
                        {
                            name: 'ffmpeg',
                            fallback: 'linux_vm',
                            note: 'stale record'
                        }
                    ]
                }
            })
        );

        expect(loaded.dependencies?.binaries?.[0]).toMatchObject({
            fallback: 'linux_vm',
            note: 'stale record'
        });
        expect(loaded.dependencies?.binaries?.[0].recordedAt).toBeUndefined();
    });

    test('serializes public mutations by metadata path and reads the latest value inside the lock', async () => {
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-mutation-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({ updates: [] }), 'utf8');

        try {
            let releaseFirst!: () => void;
            const firstCanFinish = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            const first = mutateOpendeskMeta(metaPath, async (meta) => {
                await firstCanFinish;
                (meta['updates'] as string[]).push('first');
            });
            const second = mutateOpendeskMeta(metaPath, (meta) => {
                (meta['updates'] as string[]).push('second');
            });

            releaseFirst();
            await Promise.all([first, second]);

            expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).updates).toEqual(['first', 'second']);
            expect(fs.readdirSync(skillDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('keeps the target unchanged and removes the temporary file when atomic rename fails', async () => {
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-atomic-failure-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({ value: 'original' }), 'utf8');

        try {
            jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));

            await expect(
                mutateOpendeskMeta(metaPath, (meta) => {
                    meta['value'] = 'changed';
                })
            ).rejects.toThrow('rename failed');

            expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toEqual({ value: 'original' });
            expect(fs.readdirSync(skillDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });
});
