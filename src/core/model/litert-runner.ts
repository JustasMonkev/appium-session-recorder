import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { getModelPath } from './model-downloader';
import type { ModelConfig } from './types';

const DEFAULT_CONFIG: ModelConfig = {
    modelPath: '',
    litertBinaryPath: 'litert_lm',
    maxTokens: 256,
    topK: 5,
    temperature: 0.2,
};

export async function findLitertBinary(): Promise<string | null> {
    const candidates = [
        'litert_lm',
        'litert-lm',
        'litert',
    ];

    for (const bin of candidates) {
        try {
            const result = await new Promise<boolean>((resolve) => {
                const proc = spawn(bin, ['--help'], {
                    stdio: 'pipe',
                    timeout: 5000,
                });
                proc.on('error', () => resolve(false));
                proc.on('close', (code) => resolve(code === 0 || code === 1));
            });
            if (result) return bin;
        } catch {
            continue;
        }
    }

    return null;
}

export async function isLitertAvailable(): Promise<boolean> {
    return (await findLitertBinary()) !== null;
}

export function buildPrompt(userQuery: string, functionDeclarations: string): string {
    return [
        '<start_of_turn>user',
        'You are a model that can do function calling with the following functions:',
        '',
        functionDeclarations,
        '',
        userQuery,
        '<end_of_turn>',
        '<start_of_turn>model',
    ].join('\n');
}

export async function runInference(
    prompt: string,
    config?: Partial<ModelConfig>,
): Promise<string> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const modelPath = cfg.modelPath || getModelPath();

    try {
        await stat(modelPath);
    } catch {
        throw new Error(
            `Model not found at ${modelPath}. Run 'model setup' first to download it.`,
        );
    }

    const litertBin = cfg.litertBinaryPath || (await findLitertBinary());
    if (!litertBin) {
        throw new Error(
            'LiteRT-LM binary not found. Install it from https://github.com/nicfab/litert-lm or set --litert-path.',
        );
    }

    return new Promise<string>((resolve, reject) => {
        const args = [
            '--model_path', modelPath,
            '--max_tokens', String(cfg.maxTokens),
            '--top_k', String(cfg.topK),
            '--temperature', String(cfg.temperature),
            '--prompt', prompt,
        ];

        const proc = spawn(litertBin, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to run LiteRT-LM: ${err.message}`));
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`LiteRT-LM exited with code ${code}: ${stderr || stdout}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}
