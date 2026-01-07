import express from 'express';
import type { RecorderOptions } from './types';
import { AppiumClient } from './appium-client';
import { InteractionRecorder } from './interaction-recorder';
import { createSessionMiddleware, createAppiumProxy } from './proxy-middleware';
import { createRoutes } from './routes';

export function createServer(options: RecorderOptions = {}) {
    const appiumUrl = options.appiumUrl ?? 'http://127.0.0.1:4723';

    const app = express();
    const appiumClient = new AppiumClient(appiumUrl);
    const recorder = new InteractionRecorder();

    // Parse JSON bodies
    app.use(express.json({ type: ['application/json', 'application/*+json'], limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Register routes
    app.use(createRoutes(recorder));

    // Intercept session requests
    app.use('/session/:sessionId', createSessionMiddleware(recorder, appiumClient));

    // Proxy everything to Appium
    app.use(createAppiumProxy(appiumUrl));

    return { app, recorder };
}

export function startServer(options: RecorderOptions = {}) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 4724;
    const appiumUrl = options.appiumUrl ?? 'http://127.0.0.1:4723';

    const { app } = createServer(options);

    return app.listen(port, host, () => {
        console.log(`\n✅ Session Recorder started:`);
        console.log(`   Proxy:  http://${host}:${port} → ${appiumUrl}`);
        console.log(`   Viewer: http://${host}:${port}/_recorder\n`);
    });
}
