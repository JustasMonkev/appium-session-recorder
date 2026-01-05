import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { RecorderOptions } from '../server/types.js';

const CONFIG_FILENAME = '.appiumrc.json';

export function getConfigPath(): string {
    // Check current directory first
    const localConfig = path.join(process.cwd(), CONFIG_FILENAME);
    if (fs.existsSync(localConfig)) {
        return localConfig;
    }

    // Check home directory
    return path.join(homedir(), CONFIG_FILENAME);
}

export function loadConfig(): Partial<RecorderOptions> {
    const configPath = getConfigPath();

    if (!fs.existsSync(configPath)) {
        return {};
    }

    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`⚠️  Failed to parse config file at ${configPath}`);
        return {};
    }
}

export function saveConfig(config: RecorderOptions): void {
    const configPath = path.join(process.cwd(), CONFIG_FILENAME);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function resolveConfig(
    cliArgs: Partial<RecorderOptions>,
    promptConfig: Partial<RecorderOptions> = {},
): RecorderOptions {
    const fileConfig = loadConfig();

    // Priority: CLI args > prompt config > file config > env vars > defaults
    return {
        port: cliArgs.port ??
            promptConfig.port ??
            fileConfig.port ??
            (Number(process.env.PROXY_PORT) || 4724),
        appiumUrl: cliArgs.appiumUrl ??
            promptConfig.appiumUrl ??
            fileConfig.appiumUrl ??
            (process.env.APPIUM_URL || 'http://127.0.0.1:4723'),
        host: cliArgs.host ??
            promptConfig.host ??
            fileConfig.host ??
            (process.env.PROXY_HOST || '127.0.0.1'),
    };
}
