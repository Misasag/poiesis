import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import extractZip from 'extract-zip';
import { hostDir, hostExecutable, runtimeDir } from './host-utils.mjs';

if (existsSync(hostExecutable)) {
    console.log(`VSCodium is already available: ${hostExecutable}`);
    process.exit(0);
}

await mkdir(runtimeDir, { recursive: true });
const releaseResponse = await fetch('https://api.github.com/repos/VSCodium/vscodium/releases/latest', {
    headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lens-code-oss-spike'
    }
});
if (!releaseResponse.ok) {
    throw new Error(`GitHub release lookup failed: ${releaseResponse.status} ${releaseResponse.statusText}`);
}

const release = await releaseResponse.json();
const asset = release.assets?.find(candidate => /^VSCodium-win32-x64-[0-9.]+\.zip$/.test(candidate.name));
if (!asset) {
    throw new Error(`No Windows x64 ZIP was found in VSCodium release ${release.tag_name}.`);
}

const archive = resolve(runtimeDir, asset.name);
console.log(`Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MiB)...`);
const assetResponse = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'lens-code-oss-spike' },
    redirect: 'follow'
});
if (!assetResponse.ok || !assetResponse.body) {
    throw new Error(`VSCodium download failed: ${assetResponse.status} ${assetResponse.statusText}`);
}
await pipeline(Readable.fromWeb(assetResponse.body), createWriteStream(archive));

await rm(hostDir, { recursive: true, force: true });
await mkdir(hostDir, { recursive: true });
console.log(`Extracting to ${hostDir}...`);
await extractZip(archive, { dir: hostDir });
await rm(archive, { force: true });

if (!existsSync(hostExecutable)) {
    throw new Error(`Extraction completed, but ${hostExecutable} was not found.`);
}
console.log(`VSCodium ${release.tag_name} is ready: ${hostExecutable}`);
