import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        exclude: ['src/ui/**/*'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/server/**/*.ts', 'src/cli/**/*.ts'],
            exclude: ['src/ui/**/*', '**/*.test.ts', '**/index.ts'],
        },
    },
});
