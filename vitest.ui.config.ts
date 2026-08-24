import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
    plugins: [solid()],
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['src/ui/**/*.test.{ts,tsx}', 'tests/ui/**/*.test.{ts,tsx}'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            reportsDirectory: 'coverage/ui',
            include: ['src/ui/src/**/*.{ts,tsx}'],
            exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', 'src/ui/src/index.tsx'],
        },
    },
});
