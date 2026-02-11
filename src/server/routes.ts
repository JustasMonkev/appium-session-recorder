import express, { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { InteractionRecorder } from './interaction-recorder';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve UI dist path: works from both source (src/server/) and bundle (dist/)
function resolveUiDir(): string {
    const candidates = [
        path.join(__dirname, '../../dist/ui'),  // dev: running from src/server/
        path.join(__dirname, 'ui'),              // prod: running from dist/
    ];
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

const uiDir = resolveUiDir();

export function createRoutes(recorder: InteractionRecorder) {
    const router = Router();

    // Serve the UI
    router.get('/_recorder', (_req, res) => {
        res.sendFile(path.join(uiDir, 'index.html'));
    });

    // Serve static assets using express.static for better performance and caching
    router.use('/_recorder/assets', express.static(path.join(uiDir, 'assets')));

    // API: Get history
    router.get('/_recorder/api/history', (_req, res) => {
        res.json(recorder.getHistory());
    });

    // API: Clear history
    router.delete('/_recorder/api/history', (_req, res) => {
        recorder.clearHistory();
        res.json({ ok: true });
    });

    // API: Server-Sent Events for real-time updates
    router.get('/_recorder/api/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Send initial history
        res.write(`data: ${JSON.stringify({ type: 'init', data: recorder.getHistory() })}\n\n`);

        // Listen for new interactions
        const unsubscribe = recorder.on((event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });

        // Clean up on close
        req.on('close', () => {
            unsubscribe();
        });
    });

    return router;
}
