import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
    plugins: [solid()],
    root: import.meta.dirname,
    base: '/_recorder/',
    build: {
        outDir: '../../dist/ui',
        emptyOutDir: true,
        license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    },
    server: {
        port: 3000,
        proxy: {
            '/_recorder/api': 'http://127.0.0.1:4724',
        },
    },
});
