import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MODEL_REPO = 'litert-community/functiongemma-270m-ft-mobile-actions';
const MODEL_FILENAME = 'functiongemma-270m-ft-mobile-actions.task';

function getModelDir(): string {
    return path.join(os.homedir(), '.appium-recorder', 'models');
}

export function getModelPath(): string {
    return path.join(getModelDir(), MODEL_FILENAME);
}

export async function isModelDownloaded(): Promise<boolean> {
    try {
        const info = await stat(getModelPath());
        return info.size > 0;
    } catch {
        return false;
    }
}

export async function getModelSize(): Promise<number> {
    try {
        const info = await stat(getModelPath());
        return info.size;
    } catch {
        return 0;
    }
}

export async function downloadModel(onProgress?: (downloaded: number, total: number) => void): Promise<string> {
    const modelDir = getModelDir();
    await mkdir(modelDir, { recursive: true });

    const modelPath = getModelPath();

    const already = await isModelDownloaded();
    if (already) {
        return modelPath;
    }

    const url = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILENAME}`;

    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) {
        throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
        throw new Error('No response body received from HuggingFace');
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    const writer = createWriteStream(modelPath);

    let downloaded = 0;

    const reader = response.body.getReader();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            writer.write(Buffer.from(value));
            downloaded += value.byteLength;

            if (onProgress && contentLength > 0) {
                onProgress(downloaded, contentLength);
            }
        }
    } finally {
        writer.end();
        await new Promise<void>((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    return modelPath;
}
