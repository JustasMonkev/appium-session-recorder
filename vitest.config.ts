import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
        exclude: ['src/ui/**/*', 'tests/ui/**/*'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            reportsDirectory: 'coverage/core',
            include: ['src/{server,cli,core}/**/*.ts'],
            exclude: ['src/ui/**/*', '**/*.test.ts', 'src/index.ts'],
        },
    },
});
