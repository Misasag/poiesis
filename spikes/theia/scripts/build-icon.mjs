import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const resourcesDir = resolve(scriptsDir, '..', 'electron-app', 'resources');
const source = join(resourcesDir, 'poiesis.png');
const destination = join(resourcesDir, 'poiesis.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const workingDirectory = await mkdtemp(join(tmpdir(), 'poiesis-icon-'));

try {
    const images = [];
    for (const size of sizes) {
        const output = join(workingDirectory, `poiesis-${size}.png`);
        const result = spawnSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', source,
            '-vf', `scale=${size}:${size}:flags=lanczos`,
            '-frames:v', '1',
            output
        ], { stdio: 'inherit' });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`ffmpeg failed while producing the ${size}px icon.`);
        }
        images.push({ size, data: await readFile(output) });
    }

    const headerSize = 6 + images.length * 16;
    let offset = headerSize;
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    images.forEach(({ size, data }, index) => {
        const entry = 6 + index * 16;
        header.writeUInt8(size === 256 ? 0 : size, entry);
        header.writeUInt8(size === 256 ? 0 : size, entry + 1);
        header.writeUInt8(0, entry + 2);
        header.writeUInt8(0, entry + 3);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(data.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += data.length;
    });
    await writeFile(destination, Buffer.concat([header, ...images.map(image => image.data)]));
    console.log(`Wrote ${destination} with ${sizes.join(', ')}px images.`);
} finally {
    const tempRelative = relative(tmpdir(), workingDirectory);
    if (tempRelative && !tempRelative.startsWith('..') && !isAbsolute(tempRelative)) {
        await rm(workingDirectory, { recursive: true, force: true });
    }
}
