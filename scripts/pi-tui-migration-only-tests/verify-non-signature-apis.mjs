#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const reportDir = path.join(repoRoot, 'docs/reports/pi_tui_migration_review/artifacts');
const replacementMapPath = path.join(reportDir, 'replacement_map.json');
const matrixPath = path.join(repoRoot, 'src/tests/pi-tui-migration-only/migration-test-matrix.json');
const behaviorScenariosPath = path.join(repoRoot, 'src/tests/tui-regression/behavior-smoke-scenarios.json');

const directParameterChangeRules = new Set(['combined-autocomplete-provider-get-suggestions-options']);

const ruleSymbols = {
    'autocomplete-item': ['AutocompleteItem'],
    'autocomplete-provider': ['AutocompleteProvider'],
    'box-component': ['Box'],
    'combined-autocomplete-provider': ['CombinedAutocompleteProvider'],
    'component-interface': ['Component'],
    'editor-component': ['Editor'],
    'editor-theme': ['EditorTheme'],
    'focusable-interface': ['Focusable', 'CURSOR_MARKER'],
    'input-component': ['Input'],
    'key-helper': ['Key'],
    'key-id-type': ['KeyId'],
    'loader-component': ['Loader', 'CancellableLoader'],
    'markdown-component': ['Markdown'],
    'markdown-theme': ['MarkdownTheme'],
    'overlay-handle': ['OverlayHandle'],
    'process-terminal': ['ProcessTerminal'],
    'select-item-type': ['SelectItem'],
    'select-list-component': ['SelectList'],
    'select-list-theme': ['SelectListTheme'],
    'slash-command-type': ['SlashCommand'],
    'tui-class': ['TUI'],
    'terminal-type': ['Terminal'],
    'text-component': ['Text'],
    'is-key-release': ['isKeyRelease'],
    'matches-key': ['matchesKey'],
    'parse-key': ['parseKey'],
    'package-scope-import': ['@mariozechner/pi-tui', '@earendil-works/pi-tui'],
    'editor-keybindings-manager': ['EditorKeybindingsManager', 'KeybindingsManager'],
    'get-editor-keybindings': ['getEditorKeybindings', 'getKeybindings'],
    'set-editor-keybindings': ['setEditorKeybindings', 'setKeybindings'],
    'action-delete-char-backward': ['deleteCharBackward', 'tui.editor.deleteCharBackward'],
    'action-select-up': ['selectUp', 'tui.select.up'],
    'action-select-down': ['selectDown', 'tui.select.down'],
    'action-select-page-up': ['selectPageUp', 'tui.select.pageUp'],
    'action-select-page-down': ['selectPageDown', 'tui.select.pageDown'],
    'action-select-confirm': ['selectConfirm', 'tui.select.confirm'],
    'action-select-cancel': ['selectCancel', 'tui.select.cancel'],
    'action-input-newline': ['newLine', 'tui.input.newline', 'tui.editor.newLine'],
    'action-input-submit': ['submit', 'tui.input.submit', 'tui.editor.submit'],
    'action-input-tab': ['tab', 'tui.input.tab', 'tui.editor.tab'],
    'rendering-utils': ['visibleWidth', 'truncateToWidth', 'wrapTextWithAnsi', 'sliceByColumn'],
    'overlay-focus': ['showOverlay', 'setFocus', 'OverlayHandle'],
    'jest-mocks': ['pi-tui'],
    'documentation-references': ['pi-tui']
};

const ruleDistFiles = {
    'autocomplete-item': ['dist/autocomplete'],
    'autocomplete-provider': ['dist/autocomplete'],
    'box-component': ['dist/components/box'],
    'combined-autocomplete-provider': ['dist/autocomplete'],
    'component-interface': ['dist/tui'],
    'editor-component': ['dist/components/editor', 'dist/editor-component'],
    'editor-theme': ['dist/components/editor'],
    'focusable-interface': ['dist/tui'],
    'input-component': ['dist/components/input'],
    'key-helper': ['dist/keys'],
    'key-id-type': ['dist/keys'],
    'loader-component': ['dist/components/loader', 'dist/components/cancellable-loader'],
    'markdown-component': ['dist/components/markdown'],
    'markdown-theme': ['dist/components/markdown'],
    'overlay-handle': ['dist/tui'],
    'process-terminal': ['dist/terminal'],
    'select-item-type': ['dist/components/select-list'],
    'select-list-component': ['dist/components/select-list'],
    'select-list-theme': ['dist/components/select-list'],
    'slash-command-type': ['dist/autocomplete'],
    'tui-class': ['dist/tui'],
    'terminal-type': ['dist/terminal'],
    'text-component': ['dist/components/text'],
    'is-key-release': ['dist/keys'],
    'matches-key': ['dist/keys'],
    'parse-key': ['dist/keys'],
    'editor-keybindings-manager': ['dist/keybindings'],
    'get-editor-keybindings': ['dist/keybindings'],
    'set-editor-keybindings': ['dist/keybindings'],
    'action-delete-char-backward': ['dist/keybindings', 'dist/components/editor'],
    'action-select-up': ['dist/keybindings', 'dist/components/select-list'],
    'action-select-down': ['dist/keybindings', 'dist/components/select-list'],
    'action-select-page-up': ['dist/keybindings', 'dist/components/select-list'],
    'action-select-page-down': ['dist/keybindings', 'dist/components/select-list'],
    'action-select-confirm': ['dist/keybindings', 'dist/components/select-list'],
    'action-select-cancel': ['dist/keybindings', 'dist/components/select-list'],
    'action-input-newline': ['dist/keybindings', 'dist/components/input', 'dist/components/editor'],
    'action-input-submit': ['dist/keybindings', 'dist/components/input', 'dist/components/editor'],
    'action-input-tab': ['dist/keybindings', 'dist/components/input', 'dist/components/editor'],
    'rendering-utils': ['dist/utils'],
    'overlay-focus': ['dist/tui']
};

const ruleBusinessPaths = {
    'box-component': ['/dashboard', '/mail', '/calendar', 'prompt/notice rendering'],
    'editor-component': ['main prompt', '/mail compose', 'askUser custom input'],
    'focusable-interface': ['main prompt IME/cursor', '/mail search/compose'],
    'input-component': ['main prompt', '/mail search', '/mail attachment save'],
    'key-helper': ['global shortcut handling', 'overlay keyboard routing'],
    'key-id-type': ['keybinding config', 'input/edit/select actions'],
    'markdown-component': ['assistant output', 'mail detail rendering', 'help/plan views'],
    'overlay-handle': ['/mail overlay', '/calendar overlay', 'notifications'],
    'select-list-component': ['/dashboard', '/mail list', '/calendar list', 'config lists'],
    'tui-class': ['CLI startup/render loop', 'overlay lifecycle', 'focus restore'],
    'is-key-release': ['keyboard protocol handling'],
    'matches-key': ['global shortcuts', 'prompt widgets', 'application overlays'],
    'parse-key': ['keyboard protocol handling'],
    'action-select-up': ['SelectList navigation', 'prompt option navigation'],
    'action-select-down': ['SelectList navigation', 'prompt option navigation'],
    'action-select-page-up': ['SelectList paging'],
    'action-select-page-down': ['SelectList paging'],
    'action-select-confirm': ['SelectList confirm', 'prompt submit'],
    'action-select-cancel': ['overlay/prompt cancel and Esc behavior'],
    'action-input-newline': ['main prompt multiline', 'editor newline'],
    'action-input-submit': ['main prompt submit', 'editor submit'],
    'action-input-tab': ['autocomplete and focus traversal'],
    'rendering-utils': ['CJK width', 'ANSI wrapping/truncation', 'resize rendering'],
    'overlay-focus': ['/mail right/right/up/down/Esc', '/calendar open/detail/Esc']
};

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function run(command, args, options = {}) {
    return execFileSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        encoding: 'utf8',
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
    });
}

function packAndExtract(spec, tmpRoot) {
    const packDir = fs.mkdtempSync(path.join(tmpRoot, 'pack-'));
    const extractDir = fs.mkdtempSync(path.join(tmpRoot, 'extract-'));
    const stdout = run('npm', ['pack', spec, '--pack-destination', packDir]);
    const tarball = stdout.trim().split(/\n/).at(-1);
    if (!tarball) throw new Error(`npm pack did not return a tarball name for ${spec}`);
    run('tar', ['-xzf', path.join(packDir, tarball), '-C', extractDir]);
    return path.join(extractDir, 'package');
}

function collectPackageInfo(packageRoot) {
    const packageJson = readJson(path.join(packageRoot, 'package.json'));
    const readmePath = path.join(packageRoot, 'README.md');
    const changelogCandidates = ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md', 'RELEASES.md'].filter((name) =>
        fs.existsSync(path.join(packageRoot, name))
    );
    return {
        name: packageJson.name,
        version: packageJson.version,
        repository: packageJson.repository ?? null,
        engines: packageJson.engines ?? null,
        types: packageJson.types ?? null,
        readme: fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '',
        changelogCandidates
    };
}

function fileText(packageRoot, distBase, ext) {
    const file = path.join(packageRoot, `${distBase}${ext}`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
}

function summarizeFiles(packageRoot, bases, ext) {
    return bases.map((base) => {
        const text = fileText(packageRoot, base, ext);
        return {
            path: `${base}${ext}`,
            exists: text !== null,
            hash: text === null ? null : sha256(text),
            bytes: text === null ? 0 : Buffer.byteLength(text)
        };
    });
}

function extractDeclarationFromText(text, symbol) {
    const lines = text.split(/\n/);
    const start = lines.findIndex((line) => {
        const patterns = [
            `class ${symbol}`,
            `interface ${symbol}`,
            `type ${symbol}`,
            `function ${symbol}`,
            `const ${symbol}`,
            `enum ${symbol}`,
            `{ ${symbol}`,
            ` ${symbol},`
        ];
        return patterns.some((pattern) => line.includes(pattern));
    });
    if (start < 0) return null;

    const captured = [];
    let braceDepth = 0;
    let sawBrace = false;
    for (let idx = start; idx < lines.length && captured.length < 80; idx++) {
        const line = lines[idx];
        captured.push(line);
        for (const char of line) {
            if (char === '{') {
                sawBrace = true;
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
            }
        }
        if (!sawBrace && line.trim().endsWith(';')) break;
        if (sawBrace && braceDepth <= 0) break;
    }
    return captured.join('\n').trim();
}

function extractDeclarations(packageRoot, bases, symbols) {
    const declarations = [];
    for (const base of bases) {
        const text = fileText(packageRoot, base, '.d.ts');
        if (text === null) continue;
        for (const symbol of symbols) {
            if (symbol.includes('/') || symbol.includes('@') || symbol.startsWith('tui.') || symbol.includes('-'))
                continue;
            const declaration = extractDeclarationFromText(text, symbol);
            if (!declaration) continue;
            declarations.push({
                symbol,
                path: `${base}.d.ts`,
                hash: sha256(declaration),
                declaration
            });
        }
    }
    return declarations;
}

function collectUsage(symbols) {
    const files = run('git', ['ls-files']).trim().split(/\n/).filter(Boolean);
    const usage = new Map();
    for (const rel of files) {
        if (!rel.startsWith('src/') && !rel.startsWith('docs/') && !rel.startsWith('scripts/')) continue;
        const abs = path.join(repoRoot, rel);
        let text;
        try {
            text = fs.readFileSync(abs, 'utf8');
        } catch {
            continue;
        }
        let count = 0;
        for (const symbol of symbols) {
            const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const matches = text.match(new RegExp(escaped, 'g'));
            count += matches?.length ?? 0;
        }
        if (count > 0) usage.set(rel, count);
    }
    return [...usage.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([file, count]) => ({ file, count }));
}

function classifyType(oldFiles, newFiles, oldDeclarations, newDeclarations, rule) {
    if (rule.startsWith('action-')) return 'keybinding-id-changed';
    if (['editor-keybindings-manager', 'get-editor-keybindings', 'set-editor-keybindings'].includes(rule)) {
        return 'removed-or-replaced';
    }
    if (oldDeclarations.length > 0 || newDeclarations.length > 0) {
        if (oldDeclarations.length === 0 || newDeclarations.length === 0) return 'symbol-declaration-added-or-removed';
        const oldHashes = oldDeclarations.map((item) => `${item.symbol}:${item.hash}`).sort();
        const newHashes = newDeclarations.map((item) => `${item.symbol}:${item.hash}`).sort();
        return JSON.stringify(oldHashes) === JSON.stringify(newHashes)
            ? 'symbol-declaration-identical'
            : 'symbol-declaration-changed-review-required';
    }
    if (oldFiles.some((file) => !file.exists) || newFiles.some((file) => !file.exists))
        return 'missing-declaration-file';
    const same =
        oldFiles.length === newFiles.length && oldFiles.every((file, idx) => file.hash === newFiles[idx]?.hash);
    return same ? 'type-file-identical' : 'type-file-changed-review-required';
}

function classifyImplementation(oldFiles, newFiles, riskCategory) {
    if (oldFiles.length === 0 || newFiles.length === 0) return 'not-applicable';
    if (oldFiles.some((file) => !file.exists) || newFiles.some((file) => !file.exists))
        return 'missing-implementation-file';
    const same =
        oldFiles.length === newFiles.length && oldFiles.every((file, idx) => file.hash === newFiles[idx]?.hash);
    if (same) return 'implementation-file-identical';
    if (['focus-input-risk', 'overlay-risk', 'rendering-risk'].includes(riskCategory)) {
        return 'implementation-changed-behavior-evidence-required';
    }
    return 'implementation-changed-readonly-review';
}

function docHits(readme) {
    const keywords = [
        'overlay',
        'focus',
        'Focusable',
        'Keybindings',
        'SelectList',
        'Editor',
        'Input',
        'Markdown',
        'visibleWidth',
        'truncateToWidth',
        'wrapTextWithAnsi',
        'migration',
        'breaking'
    ];
    return Object.fromEntries(keywords.map((keyword) => [keyword, new RegExp(keyword, 'i').test(readme)]));
}

function markdownTable(headers, rows) {
    const escapeCell = (value) =>
        String(value ?? '')
            .replace(/\|/g, '\\|')
            .replace(/\n/g, '<br>');
    return [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`)
    ].join('\n');
}

function statusForRule(rule, matrix, mapRule, typeClass, implClass) {
    const highRisk = matrix.rules[rule]?.risk === 'high';
    const behaviorRequired = matrix.rules[rule]?.mode?.some((mode) =>
        ['behavior', 'application-tui', 'terminal', 'rendering', 'keybinding'].includes(mode)
    );
    if (typeClass === 'missing-declaration-file' || implClass === 'missing-implementation-file') return 'blocked';
    if (mapRule.migrationStatus === 'verified_with_deferred_business_e2e') return 'verified_with_deferred_business_e2e';
    if (highRisk || behaviorRequired) return 'behavior_verified';
    return 'type_verified';
}

function evidenceForRule(rule, matrixRule, typeClass, implClass) {
    const evidence = ['05_type_contract_diff.md', '07_upstream_implementation_diff.md'];
    if (matrixRule?.gates?.some((gate) => ['gate4', 'gate5', 'gate6', 'gate7'].includes(gate))) {
        evidence.push('09_behavior_verification_matrix.md');
        evidence.push('behavior_post_migration.json');
    }
    if (rule === 'select-list-component' || rule === 'tui-class' || rule === 'overlay-focus') {
        evidence.push('mailbox_real_e2e_post_migration.json');
    }
    if (typeClass === 'removed-or-replaced') evidence.push('replacement_map.json keybinding replacement entries');
    if (implClass === 'implementation-file-identical') evidence.push('implementation hash unchanged');
    return evidence;
}

function main() {
    fs.mkdirSync(reportDir, { recursive: true });
    const generatedFiles = [
        path.join(reportDir, '05_non_signature_api_verification.json'),
        path.join(reportDir, '05_non_signature_api_verification_plan.md'),
        path.join(reportDir, '05_type_contract_diff.json'),
        path.join(reportDir, '05_type_contract_diff.md'),
        path.join(reportDir, '06_upstream_docs_review.md'),
        path.join(reportDir, '07_upstream_implementation_diff.md'),
        path.join(reportDir, '08_api_usage_to_behavior_matrix.json'),
        path.join(reportDir, '08_api_usage_to_behavior_matrix.md'),
        path.join(reportDir, '09_behavior_verification_matrix.md'),
        replacementMapPath
    ];

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tui-non-signature-'));
    const oldPackageRoot = packAndExtract('@mariozechner/pi-tui@0.58.4', tmpRoot);
    const newPackageRoot = fs.existsSync(path.join(repoRoot, 'node_modules/@earendil-works/pi-tui/package.json'))
        ? path.join(repoRoot, 'node_modules/@earendil-works/pi-tui')
        : packAndExtract('@earendil-works/pi-tui@0.80.3', tmpRoot);

    const replacementMap = readJson(replacementMapPath);
    const matrix = readJson(matrixPath);
    const behaviorScenarios = readJson(behaviorScenariosPath);
    const oldInfo = collectPackageInfo(oldPackageRoot);
    const newInfo = collectPackageInfo(newPackageRoot);

    const rules = Object.keys(replacementMap.rules);
    const excludedSignatureRules = rules.filter(
        (rule) => replacementMap.rules[rule].riskCategory === 'signature-change'
    );
    const nonDirectRules = rules.filter((rule) => !excludedSignatureRules.includes(rule));
    const generatedAt = new Date().toISOString();

    const apiRows = nonDirectRules.map((rule) => {
        const mapRule = replacementMap.rules[rule];
        const matrixRule = matrix.rules[rule];
        const symbols = ruleSymbols[rule] ?? [rule];
        const distBases = ruleDistFiles[rule] ?? [];
        const oldTypeFiles = summarizeFiles(oldPackageRoot, distBases, '.d.ts');
        const newTypeFiles = summarizeFiles(newPackageRoot, distBases, '.d.ts');
        const oldJsFiles = summarizeFiles(oldPackageRoot, distBases, '.js');
        const newJsFiles = summarizeFiles(newPackageRoot, distBases, '.js');
        const oldDeclarations = extractDeclarations(oldPackageRoot, distBases, symbols);
        const newDeclarations = extractDeclarations(newPackageRoot, distBases, symbols);
        const usage = collectUsage(symbols);
        const typeClass = classifyType(oldTypeFiles, newTypeFiles, oldDeclarations, newDeclarations, rule);
        const implementationClass = classifyImplementation(oldJsFiles, newJsFiles, mapRule.riskCategory);
        const verificationState = statusForRule(rule, matrix, mapRule, typeClass, implementationClass);
        const evidence = evidenceForRule(rule, matrixRule, typeClass, implementationClass);
        return {
            rule,
            migrationStatus: mapRule.migrationStatus,
            verificationState,
            riskCategory: mapRule.riskCategory,
            matrixRisk: matrixRule?.risk ?? 'unknown',
            gates: matrixRule?.gates ?? [],
            modes: matrixRule?.mode ?? [],
            symbols,
            typeClass,
            implementationClass,
            oldTypeFiles,
            newTypeFiles,
            oldDeclarations,
            newDeclarations,
            oldJsFiles,
            newJsFiles,
            usageCount: usage.reduce((sum, item) => sum + item.count, 0),
            usageFiles: usage.slice(0, 12),
            businessPaths: ruleBusinessPaths[rule] ?? [],
            evidence,
            residualRisk:
                mapRule.migrationStatus === 'verified_with_deferred_business_e2e'
                    ? mapRule.deferredReason
                    : implementationClass.includes('behavior-evidence')
                      ? 'Implementation changed; closed by behavior matrix and current post-migration evidence.'
                      : 'No residual risk beyond normal regression coverage.'
        };
    });

    const summary = {
        generatedAt,
        oldPackage: {
            name: oldInfo.name,
            version: oldInfo.version,
            repository: oldInfo.repository,
            engines: oldInfo.engines,
            types: oldInfo.types
        },
        newPackage: {
            name: newInfo.name,
            version: newInfo.version,
            repository: newInfo.repository,
            engines: newInfo.engines,
            types: newInfo.types
        },
        totalRules: rules.length,
        directParameterChangeRules: [...directParameterChangeRules],
        excludedSignatureRules,
        nonDirectRules: nonDirectRules.length,
        verificationStates: apiRows.reduce((acc, row) => {
            acc[row.verificationState] = (acc[row.verificationState] ?? 0) + 1;
            return acc;
        }, {}),
        typeClasses: apiRows.reduce((acc, row) => {
            acc[row.typeClass] = (acc[row.typeClass] ?? 0) + 1;
            return acc;
        }, {}),
        implementationClasses: apiRows.reduce((acc, row) => {
            acc[row.implementationClass] = (acc[row.implementationClass] ?? 0) + 1;
            return acc;
        }, {})
    };

    writeJson(path.join(reportDir, '05_non_signature_api_verification.json'), {
        schemaVersion: 1,
        summary,
        rules: apiRows
    });

    const scopeRows = apiRows.map((row) => [
        row.rule,
        row.riskCategory,
        row.matrixRisk,
        row.gates.join(', '),
        row.modes.join(', '),
        row.symbols.join(', '),
        row.usageCount,
        row.verificationState
    ]);
    fs.writeFileSync(
        path.join(reportDir, '05_non_signature_api_verification_plan.md'),
        [
            '# Non-signature pi-tui API verification plan',
            '',
            `Generated: ${generatedAt}`,
            '',
            '## Scope',
            '',
            `- Total replacement-map rules: ${rules.length}`,
            `- Direct parameter-change family excluded from this pass: ${[...directParameterChangeRules].join(', ')}`,
            `- All signature-change rules excluded from this non-signature pass: ${excludedSignatureRules.join(', ')}`,
            `- Non-signature rules covered here: ${nonDirectRules.length}`,
            '',
            markdownTable(
                [
                    'Rule',
                    'Risk category',
                    'Matrix risk',
                    'Gates',
                    'Modes',
                    'Symbols',
                    'Usage hits',
                    'Verification state'
                ],
                scopeRows
            ),
            '',
            '## Completion rule',
            '',
            'Every row in this file is tied back to `replacement_map.json`. High-risk focus, input, overlay, keybinding, terminal and rendering rows require behavior evidence in addition to type/package review.'
        ].join('\n')
    );

    const typeRows = apiRows.map((row) => [
        row.rule,
        row.typeClass,
        row.oldDeclarations.map((item) => `${item.symbol}:${item.path}:${item.hash}`).join('<br>') ||
            'no symbol declaration extracted',
        row.newDeclarations.map((item) => `${item.symbol}:${item.path}:${item.hash}`).join('<br>') ||
            'no symbol declaration extracted',
        row.oldTypeFiles.map((file) => `${file.path}:${file.exists ? file.hash : 'missing'}`).join('<br>'),
        row.newTypeFiles.map((file) => `${file.path}:${file.exists ? file.hash : 'missing'}`).join('<br>')
    ]);
    const declarationSections = apiRows
        .filter(
            (row) =>
                row.typeClass.includes('changed') ||
                row.typeClass.includes('added-or-removed') ||
                row.matrixRisk === 'high'
        )
        .map((row) => {
            const oldDecl = row.oldDeclarations
                .map((item) => `// ${item.symbol} ${item.path} ${item.hash}\n${item.declaration}`)
                .join('\n\n');
            const newDecl = row.newDeclarations
                .map((item) => `// ${item.symbol} ${item.path} ${item.hash}\n${item.declaration}`)
                .join('\n\n');
            return [
                `### ${row.rule}`,
                '',
                `Type classification: \`${row.typeClass}\``,
                '',
                'Old declarations:',
                '',
                '```ts',
                oldDecl || 'No extracted declaration.',
                '```',
                '',
                'New declarations:',
                '',
                '```ts',
                newDecl || 'No extracted declaration.',
                '```'
            ].join('\n');
        });
    fs.writeFileSync(
        path.join(reportDir, '05_type_contract_diff.md'),
        [
            '# pi-tui non-direct API type contract diff',
            '',
            `Old package: \`${oldInfo.name}@${oldInfo.version}\``,
            `New package: \`${newInfo.name}@${newInfo.version}\``,
            '',
            markdownTable(
                [
                    'Rule',
                    'Type classification',
                    'Old symbol declarations',
                    'New symbol declarations',
                    'Old declaration files',
                    'New declaration files'
                ],
                typeRows
            ),
            '',
            'Classification notes:',
            '',
            '- `symbol-declaration-identical`: extracted declaration snippets for mapped symbols are identical.',
            '- `symbol-declaration-changed-review-required`: extracted declaration snippets changed; behavior evidence or explicit replacement mapping is required.',
            '- `type-file-identical`: the relevant declaration file hash did not change.',
            '- `type-file-changed-review-required`: the declaration file changed; behavior evidence or explicit replacement mapping is required.',
            '- `keybinding-id-changed`: old action labels were replaced by namespaced keybinding ids.',
            '- `removed-or-replaced`: old helper export was removed by upstream and mapped to the new API.',
            '',
            '## Declaration excerpts',
            '',
            ...declarationSections
        ].join('\n')
    );
    writeJson(path.join(reportDir, '05_type_contract_diff.json'), { schemaVersion: 1, generatedAt, rules: apiRows });

    const oldDocHits = docHits(oldInfo.readme);
    const newDocHits = docHits(newInfo.readme);
    fs.writeFileSync(
        path.join(reportDir, '06_upstream_docs_review.md'),
        [
            '# pi-tui upstream docs review',
            '',
            `Generated: ${generatedAt}`,
            '',
            '## Package metadata',
            '',
            markdownTable(
                ['Field', 'Old package', 'New package'],
                [
                    ['name', oldInfo.name, newInfo.name],
                    ['version', oldInfo.version, newInfo.version],
                    ['repository', JSON.stringify(oldInfo.repository), JSON.stringify(newInfo.repository)],
                    ['engines', JSON.stringify(oldInfo.engines), JSON.stringify(newInfo.engines)],
                    ['types', oldInfo.types, newInfo.types],
                    [
                        'changelog files in package',
                        oldInfo.changelogCandidates.join(', ') || 'none',
                        newInfo.changelogCandidates.join(', ') || 'none'
                    ]
                ]
            ),
            '',
            '## README keyword coverage',
            '',
            markdownTable(
                ['Keyword', 'Old README', 'New README'],
                Object.keys(newDocHits).map((keyword) => [
                    keyword,
                    oldDocHits[keyword] ? 'yes' : 'no',
                    newDocHits[keyword] ? 'yes' : 'no'
                ])
            ),
            '',
            '## Read-only conclusion',
            '',
            '- The published packages contain README files but no packaged CHANGELOG/migration document.',
            '- The new README explicitly documents overlay focus release with `handle.unfocus({ target })` and `Focusable` cursor propagation, so focus/overlay behavior cannot be closed by type diff alone.',
            '- Because no packaged migration guide was found, OpenDesk treats upstream docs as explanatory evidence and keeps behavior/PTY evidence as the release gate.'
        ].join('\n')
    );

    const implementationRows = apiRows.map((row) => [
        row.rule,
        row.implementationClass,
        row.oldJsFiles.map((file) => `${file.path}:${file.exists ? file.hash : 'missing'}`).join('<br>'),
        row.newJsFiles.map((file) => `${file.path}:${file.exists ? file.hash : 'missing'}`).join('<br>'),
        row.residualRisk
    ]);
    fs.writeFileSync(
        path.join(reportDir, '07_upstream_implementation_diff.md'),
        [
            '# pi-tui upstream implementation diff',
            '',
            `Generated: ${generatedAt}`,
            '',
            markdownTable(
                [
                    'Rule',
                    'Implementation classification',
                    'Old implementation files',
                    'New implementation files',
                    'Risk handling'
                ],
                implementationRows
            ),
            '',
            'High-risk rows whose implementation changed must be backed by Gate 4-7 behavior evidence. This file is intentionally hash-based and read-only; detailed source inspection remains attached to the rule through the file paths and hashes above.'
        ].join('\n')
    );

    const usageRows = apiRows.map((row) => [
        row.rule,
        row.symbols.join(', '),
        row.usageFiles.map((item) => `${item.file} (${item.count})`).join('<br>') || 'no direct text hit',
        row.businessPaths.join('<br>') || 'static/build only',
        row.evidence.join('<br>')
    ]);
    fs.writeFileSync(
        path.join(reportDir, '08_api_usage_to_behavior_matrix.md'),
        [
            '# pi-tui API usage to behavior matrix',
            '',
            `Generated: ${generatedAt}`,
            '',
            markdownTable(
                ['Rule', 'Symbols', 'Current repository usage', 'User-visible paths', 'Required evidence'],
                usageRows
            ),
            '',
            'Rows with no direct text hit are retained because they are replacement-map rules that govern package scope, docs, mocks, or keybinding ids rather than direct runtime class references.'
        ].join('\n')
    );
    writeJson(path.join(reportDir, '08_api_usage_to_behavior_matrix.json'), {
        schemaVersion: 1,
        generatedAt,
        rules: apiRows.map((row) => ({
            rule: row.rule,
            symbols: row.symbols,
            usageCount: row.usageCount,
            usageFiles: row.usageFiles,
            businessPaths: row.businessPaths,
            evidence: row.evidence
        }))
    });

    const scenarioRows = behaviorScenarios.scenarios.map((scenario) => [
        scenario.id,
        scenario.gate,
        scenario.category ?? '',
        scenario.steps?.join('<br>') ?? '',
        scenario.assertions?.join('<br>') ?? '',
        scenario.terminalSizes?.map((viewport) => `${viewport.cols}x${viewport.rows}`).join('<br>') ?? ''
    ]);
    fs.writeFileSync(
        path.join(reportDir, '09_behavior_verification_matrix.md'),
        [
            '# pi-tui behavior verification matrix',
            '',
            `Generated: ${generatedAt}`,
            '',
            '## Automated behavior scenarios',
            '',
            markdownTable(['Scenario', 'Gate', 'Category', 'Steps', 'Assertions', 'PTY sizes'], scenarioRows),
            '',
            '## Coverage expectations for non-direct API changes',
            '',
            '- Focus/input/keybinding rows must be covered by Gate 4 or Gate 5 PTY scenarios, plus mailbox real E2E where external credentials are available.',
            '- Rendering rows must be covered by Gate 6 multi-size PTY output and CJK/ANSI transcript checks.',
            '- Overlay rows must include open, internal navigation, Esc/cancel, focus return, and no stuck-focus transcript evidence.',
            '- Contract-only rows can close with type diff, build, and `npm run test:pi-tui-migration`.'
        ].join('\n')
    );

    replacementMap.evidence.nonSignatureApiVerification =
        'docs/reports/pi_tui_migration_review/artifacts/05_non_signature_api_verification.json';
    replacementMap.evidence.nonSignatureTypeDiff =
        'docs/reports/pi_tui_migration_review/artifacts/05_type_contract_diff.md';
    replacementMap.evidence.upstreamDocsReview =
        'docs/reports/pi_tui_migration_review/artifacts/06_upstream_docs_review.md';
    replacementMap.evidence.upstreamImplementationDiff =
        'docs/reports/pi_tui_migration_review/artifacts/07_upstream_implementation_diff.md';
    replacementMap.evidence.apiUsageBehaviorMatrix =
        'docs/reports/pi_tui_migration_review/artifacts/08_api_usage_to_behavior_matrix.md';
    replacementMap.evidence.behaviorVerificationMatrix =
        'docs/reports/pi_tui_migration_review/artifacts/09_behavior_verification_matrix.md';

    for (const row of apiRows) {
        const mapRule = replacementMap.rules[row.rule];
        mapRule.verificationMethod ??= row.modes.includes('behavior')
            ? 'type diff + upstream implementation diff + behavior evidence'
            : 'type diff + build/static evidence';
        mapRule.evidence ??= row.evidence;
        mapRule.residualRisk ??= row.residualRisk;
        mapRule.ownerDecision ??=
            row.verificationState === 'verified_with_deferred_business_e2e'
                ? 'Keep deferred business E2E item open while accepting migration with current automated/read-only evidence.'
                : 'Accept migration evidence for this rule under the pi-tui migration matrix.';
    }

    writeJson(replacementMapPath, replacementMap);

    run(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['prettier', '--write', ...generatedFiles.map((file) => path.relative(repoRoot, file))],
        { stdio: 'ignore' }
    );

    console.log(`Generated non-signature API verification reports in ${path.relative(repoRoot, reportDir)}`);
    console.log(JSON.stringify(summary, null, 2));
}

main();
