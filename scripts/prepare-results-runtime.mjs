import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licenseDirectory = join(root, 'scripts', 'licenses', 'node');
const licenseMetadata = JSON.parse(readFileSync(join(licenseDirectory, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
if (licenseMetadata.version !== process.version) {
    console.warn(`WARNING: Bundled Node ${process.version} differs from LICENSE ${licenseMetadata.version}. Update the vendored Node license before distribution.`);
}
// Copy the distributor's original Node binary. Do not build a shim executable or rename Electron.
if (process.platform === 'win32') {
    const literal = process.execPath.replaceAll("'", "''");
    const signature = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-AuthenticodeSignature -LiteralPath '${literal}' | Select-Object -ExpandProperty Status`],
    { encoding: 'utf8', windowsHide: true, shell: false }).trim();
    if (signature !== 'Valid') { throw new Error('Packaging requires an Authenticode-signed Node binary.'); }
}
const target = join(root, 'electron-app', 'lib', 'results-runtime');
mkdirSync(target, { recursive: true });
copyFileSync(process.execPath, join(target, process.platform === 'win32' ? 'node.exe' : 'node'));
copyFileSync(join(licenseDirectory, 'LICENSE'), join(target, 'LICENSE'));
copyFileSync(join(licenseDirectory, 'version.json'), join(target, 'license-version.json'));
console.log('RESULTS_RUNTIME=prepared');
