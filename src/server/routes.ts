import express, { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { InteractionRecorder } from './interaction-recorder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createRoutes(recorder: InteractionRecorder) {
    const router = Router();

    // Serve the UI
    router.get('/_recorder', (_req, res) => {
        const uiPath = path.join(__dirname, '../../dist/ui/index.html');
        res.sendFile(uiPath);
    });

    // Serve static assets using express.static for better performance and caching
    router.use('/_recorder/assets', express.static(path.join(__dirname, '../../dist/ui/assets')));

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
