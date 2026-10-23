import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
    MCP_ENDPOINT,
    REQUEST_TIMEOUT_MS,
    formatDependencySupportResult,
    queryDependencySupport,
    setupDependencyQuery
} from '../../../../resources/plugins/hm-compat/dependency-query.mjs';

const TIMELINESS_NOTE = (updatedAt) =>
    `以上数据最后更新于 ${updatedAt}，仅供参考，不保证当前环境下的实际有效性，请结合实际情况决定后续处理。`;

test('formats the three result shapes with a timeliness line', () => {
    const output = formatDependencySupportResult({
        success: true,
        results: [
            {
                name: 'axios',
                language: 'node',
                supported: true,
                nativelyCompatible: true,
                updatedAt: '2026-08-11 16:04:11'
            },
            {
                name: 'numpy',
                language: 'python',
                supported: true,
                nativelyCompatible: false,
                harmonySolution: 'numpy',
                updatedAt: '2026-08-11 16:14:06'
            },
            { name: 'requests', language: 'python', supported: false, nativelyCompatible: false }
        ]
    });
    // 时效行取各结果 updatedAt 的最大值（16:14:06 > 16:04:11）
    assert.equal(
        output,
        [
            'axios (node): 支持，天然兼容（可直接安装）',
            'numpy (python): 支持，需从鸿蒙源下载: numpy',
            'requests (python): 不支持',
            '---',
            TIMELINESS_NOTE('2026-08-11 16:14:06')
        ].join('\n')
    );

    // 全部缺失 updatedAt（如全为不支持）时省略时效行
    const allUnsupported = formatDependencySupportResult({
        success: true,
        results: [{ name: 'requests', language: 'python', supported: false, nativelyCompatible: false }]
    });
    assert.equal(allUnsupported, 'requests (python): 不支持');
});

test('passes hint through to the end and returns message verbatim on failure', () => {
    const withHint = formatDependencySupportResult({
        success: true,
        results: [
            {
                name: 'axios',
                language: 'node',
                supported: true,
                nativelyCompatible: true,
                updatedAt: '2026-08-11 16:04:11'
            }
        ],
        hint: 'Currently available languages: .Net, cpp, java, node, python, rust'
    });
    assert.equal(
        withHint,
        [
            'axios (node): 支持，天然兼容（可直接安装）',
            '---',
            TIMELINESS_NOTE('2026-08-11 16:04:11'),
            'Currently available languages: .Net, cpp, java, node, python, rust'
        ].join('\n')
    );

    const failed = formatDependencySupportResult({ success: false, message: 'Invalid dependencies payload' });
    assert.equal(failed, 'Invalid dependencies payload');
});

test('queries the configured endpoint and formats the service payload', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
        capturedUrl = url;
        return {
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                results: [
                                    {
                                        name: 'axios',
                                        language: 'node',
                                        supported: true,
                                        nativelyCompatible: true,
                                        updatedAt: '2026-08-11 16:04:11'
                                    }
                                ]
                            })
                        }
                    ]
                }
            })
        };
    };

    const output = await queryDependencySupport([{ name: 'axios', language: 'node' }], fetchImpl);

    assert.equal(capturedUrl, MCP_ENDPOINT);
    assert.equal(
        output,
        ['axios (node): 支持，天然兼容（可直接安装）', '---', TIMELINESS_NOTE('2026-08-11 16:04:11')].join('\n')
    );
});

test('wraps query failures with fallback guidance', async () => {
    await assert.rejects(
        queryDependencySupport([{ name: 'axios', language: 'node' }], async () => {
            throw new Error('connect ECONNREFUSED 1.92.103.192');
        }),
        (err) => {
            assert.match(err.message, /依赖支持查询服务不可用（connect ECONNREFUSED 1\.92\.103\.192）/);
            assert.match(err.message, /可照常尝试安装，失败后现有摩擦检测会兜底/);
            return true;
        }
    );

    // 超时走同一 wrap，reason 显示为请求超时
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const pending = queryDependencySupport([{ name: 'axios', language: 'node' }], (_url, init) => {
            return new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const err = new Error('This operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });
        const assertion = assert.rejects(pending, (err) => {
            assert.match(err.message, /依赖支持查询服务不可用（请求超时（10s））/);
            return true;
        });
        mock.timers.tick(REQUEST_TIMEOUT_MS);
        await assertion;
    } finally {
        mock.timers.reset();
    }
});

test('registers checkHarmonySupport with schema validation', () => {
    let registered;
    setupDependencyQuery({
        pluginId: 'hm-compat',
        tools: {
            register: (tool) => {
                registered = tool;
            }
        }
    } as never);

    assert.equal(registered.name, 'checkHarmonySupport');
    // 触发时机（平台无关措辞）与歧义声明必须写进工具描述
    assert.match(registered.description, /在当前平台安装第三方库或依赖前/);
    assert.match(registered.description, /supported=false 可能表示不支持/);

    assert.deepEqual(registered.parameters.parse({ dependencies: [{ name: 'axios', language: 'node' }] }), {
        dependencies: [{ name: 'axios', language: 'node' }]
    });

    // language 枚举收窄到数据源实际覆盖范围
    assert.throws(() => registered.parameters.parse({ dependencies: [{ name: 'axios', language: 'go' }] }));
    // 数组最多 100 项
    assert.throws(() =>
        registered.parameters.parse({
            dependencies: Array.from({ length: 101 }, (_unused, index) => ({ name: `pkg-${index}`, language: 'node' }))
        })
    );
});
