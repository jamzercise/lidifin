// `p-queue` v9 and `p-timeout` v7 are ESM-only. Our backend compiles to
// CommonJS, so at runtime Node loads them via real dynamic `import()` (works
// fine), but Jest's CJS-style `require` chokes with
// `SyntaxError: Cannot use import statement outside a module`. The fix is to
// have ts-jest transpile those node_modules to CJS before Jest tries to
// require them. Anything not in this list keeps the default
// "skip node_modules" behaviour for speed.
const ESM_NODE_MODULES_TO_TRANSFORM = ['p-queue', 'p-timeout'];

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
    // Mirror the `@/*` -> src/* path alias declared in tsconfig.json so
    // ts-jest can resolve aliased imports the same way tsc/tsx do.
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    // Runs before any test module is required — sets dummy env vars so
    // importing `src/config.ts` (zod-validated) and `src/utils/encryption.ts`
    // doesn't `process.exit(1)` or throw at module load.
    setupFiles: ['<rootDir>/jest.setup.ts'],
    transform: {
        '^.+\\.(ts|tsx|js|mjs)$': [
            'ts-jest',
            {
                // p-queue/p-timeout ship .js with ESM `import` syntax. ts-jest
                // happily down-levels them; without `allowJs` it would skip
                // them entirely and we'd hit the same SyntaxError as before.
                tsconfig: {
                    allowJs: true,
                    target: 'ES2020',
                    module: 'commonjs',
                    esModuleInterop: true,
                    isolatedModules: true,
                },
                diagnostics: false,
            },
        ],
    },
    transformIgnorePatterns: [
        `node_modules/(?!(${ESM_NODE_MODULES_TO_TRANSFORM.join('|')})/)`,
    ],
};
