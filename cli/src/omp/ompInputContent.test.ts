import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOmpInput } from './ompInputContent';

const createdDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(createdDirectories.splice(0).map((directory) => (
        rm(directory, { recursive: true, force: true })
    )));
});

describe('OMP native input content', () => {
    it('reads image bytes into native ImageContent and keeps files out of text', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-omp-image-'));
        createdDirectories.push(directory);
        const path = join(directory, 'pixel.png');
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        await writeFile(path, bytes);

        const result = await prepareOmpInput('describe it', [{
            id: 'image',
            filename: 'pixel.png',
            mimeType: 'image/png',
            size: bytes.length,
            path
        }]);

        expect(result).toEqual({
            message: 'describe it',
            images: [{
                type: 'image',
                data: bytes.toString('base64'),
                mimeType: 'image/png'
            }]
        });
        expect(result.message).not.toContain(path);
    });
});
