import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'path';

export default defineConfig({
    plugins: [solid()],
    root: '.',
    base: '/_recorder/',
    build: {
        outDir: '../../dist/ui',
        emptyOutDir: true,
        target: 'es2020',
        chunkSizeWarningLimit: 600,
        rollupOptions: {
            output: {
                manualChunks: {
                    solid: ['solid-js'],
                    kobalte: ['@kobalte/core'],
                },
            },
        },
    },
    server: {
        port: 3000,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});

