import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const resourcesDir = resolve(scriptsDir, '..', 'electron-app', 'resources');
const source = join(resourcesDir, 'poiesis.png');
const icoDestination = join(resourcesDir, 'poiesis.ico');
const icnsDestination = join(resourcesDir, 'poiesis.icns');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsEntries = [
    { type: 'icp4', size: 16 },
    { type: 'icp5', size: 32 },
    { type: 'icp6', size: 64 },
    { type: 'ic07', size: 128 },
    { type: 'ic08', size: 256 },
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 }
];
const workingDirectory = await mkdtemp(join(tmpdir(), 'poiesis-icon-'));

try {
    const requestedSizes = [...new Set([
        ...icoSizes,
        ...icnsEntries.map(entry => entry.size)
    ])];
    const imagesBySize = new Map();
    for (const size of requestedSizes) {
        imagesBySize.set(size, await renderPng(size));
    }

    const images = icoSizes.map(size => ({ size, data: imagesBySize.get(size) }));
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
    await writeFile(icoDestination, Buffer.concat([header, ...images.map(image => image.data)]));
    console.log(`Wrote ${icoDestination} with ${icoSizes.join(', ')}px images.`);

    const icnsBlocks = icnsEntries.map(({ type, size }) => {
        const data = imagesBySize.get(size);
        const block = Buffer.alloc(8 + data.length);
        block.write(type, 0, 4, 'ascii');
        block.writeUInt32BE(block.length, 4);
        data.copy(block, 8);
        return block;
    });
    const icnsHeader = Buffer.alloc(8);
    icnsHeader.write('icns', 0, 4, 'ascii');
    icnsHeader.writeUInt32BE(8 + icnsBlocks.reduce((total, block) => total + block.length, 0), 4);
    await writeFile(icnsDestination, Buffer.concat([icnsHeader, ...icnsBlocks]));
    console.log(`Wrote ${icnsDestination} with ${icnsEntries.map(entry => entry.size).join(', ')}px images.`);

    async function renderPng(size) {
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
        return readFile(output);
    }
} finally {
    const tempRelative = relative(tmpdir(), workingDirectory);
    if (tempRelative && !tempRelative.startsWith('..') && !isAbsolute(tempRelative)) {
        await rm(workingDirectory, { recursive: true, force: true });
    }
}
