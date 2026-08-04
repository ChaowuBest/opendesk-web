import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            'prefer-const': 'warn',
            'no-var': 'error',
            'no-case-declarations': 'warn',
            'no-empty': 'warn',
            'no-control-regex': 'warn',
            'no-async-promise-executor': 'warn',
            'no-prototype-builtins': 'warn',
            'no-irregular-whitespace': 'warn',
            'no-console': 'off',
            'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/prefer-as-const': 'warn',
            '@typescript-eslint/no-unused-expressions': 'warn',
            '@typescript-eslint/no-this-alias': 'warn',
            '@typescript-eslint/ban-ts-comment': 'warn',
            '@typescript-eslint/triple-slash-reference': 'warn'
        }
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node }
        },
        rules: {
            'no-unused-vars': 'off',
            'no-undef': 'warn',
            'no-redeclare': 'warn',
            'no-dupe-class-members': 'warn',
            'no-dupe-keys': 'warn'
        }
    },
    {
        files: ['**/*.js'],
        languageOptions: { sourceType: 'commonjs' }
    },
    {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node }
        },
        rules: {
            'no-undef': 'off',
            'no-redeclare': 'off',
            'no-dupe-class-members': 'off'
        }
    },
    {
        files: ['src/tests/**/*.test.ts'],
        languageOptions: {
            globals: { ...globals.jest }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'off'
        }
    },
    {
        files: ['src/tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': 'off'
        }
    },
    {
        files: ['scripts/**/*.{js,mjs,cjs,ts}'],
        languageOptions: {
            globals: { ...globals.node }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'off'
        }
    },
    {
        ignores: ['dist/', 'out/', 'node_modules/', 'native/', 'vendor/', '**/*.d.ts']
    }
);
