import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULTS_IMAGE_MAX_BYTES, RESULTS_IMAGES_MAX_BYTES, RESULTS_IMAGES_MAX_COUNT, ResultsImageResolution } from '../common/results-images';

/** Read only bounded, regular files whose real target remains inside the workspace. */
export async function resolveResultsImages(workspaceUri: string, paths: string[]): Promise<ResultsImageResolution> {
    const result: ResultsImageResolution = { images: [], diagnostics: [] };
    let root: string;
    try {
        const uri = new URL(workspaceUri);
        if (uri.protocol !== 'file:' || uri.hostname) { throw new Error(); }
        root = await realpath(fileURLToPath(uri));
    } catch { return { images: [], diagnostics: ['画像の作業フォルダーを確認できません。'] }; }
    let total = 0;
    const unique = [...new Set(paths)];
    if (unique.length > RESULTS_IMAGES_MAX_COUNT) { result.diagnostics.push('画像は文書あたり40件までです。'); }
    for (const path of unique.slice(0, RESULTS_IMAGES_MAX_COUNT)) {
        let file;
        try {
            if (typeof path !== 'string' || path.length > 1024 || /[:\x00-\x1f?#%]/.test(path)
                || isAbsolute(path) || path.replace(/\\/g, '/').split('/').some(part => !part || part === '..')) { throw new Error(); }
            const target = await realpath(resolve(root, path));
            const within = relative(root, target);
            if (!within || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) { throw new Error(); }
            const extension = extname(path).toLowerCase();
            const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
                '.gif': 'image/gif', '.svg': 'image/svg+xml' } as Record<string, string>)[extension];
            if (!mime) { throw new Error(); }
            file = await open(target, 'r');
            const stat = await file.stat();
            if (!stat.isFile() || stat.size <= 0 || stat.size > RESULTS_IMAGE_MAX_BYTES || total + stat.size > RESULTS_IMAGES_MAX_BYTES) { throw new Error(); }
            // A bounded read also handles a file growing between stat and read.
            const buffer = Buffer.alloc(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
                const read = await file.read(buffer, length, buffer.length - length, null);
                if (!read.bytesRead) { break; }
                length += read.bytesRead;
            }
            if (length !== stat.size) { throw new Error(); }
            const bytes = buffer.subarray(0, length);
            const valid = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                : extension === '.jpg' || extension === '.jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                : extension === '.gif' ? /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))
                : extension === '.webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
                : /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8').replace(/^\uFEFF/, ''));
            if (!valid) { throw new Error(); }
            total += length;
            result.images.push({ path, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
        } catch { result.diagnostics.push(`画像を省略しました: ${String(path).slice(0, 160)}（場所・形式・容量を確認してください）`); }
        finally { await file?.close(); }
    }
    return result;
}
