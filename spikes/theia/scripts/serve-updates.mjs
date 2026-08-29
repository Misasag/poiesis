import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { feedRoot, updateFeedPort, updateFeedUrl } from './distribution-config.mjs';

const server = createServer((request, response) => {
    try {
        serve(request, response);
    } catch (error) {
        console.error(`UPDATE_SERVER_ERROR=${error instanceof Error ? error.message : String(error)}`);
        response.writeHead(500).end('Internal Server Error');
    }
});

server.listen(updateFeedPort, '127.0.0.1', () => {
    console.log(`UPDATE_SERVER_READY=${updateFeedUrl}`);
    console.log(`UPDATE_SERVER_ROOT=${feedRoot}`);
});

server.on('error', error => {
    console.error(`UPDATE_SERVER_FATAL=${error.message}`);
    process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}

function serve(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(feedRoot, `.${pathname}`);
    const relativePath = relative(feedRoot, candidate);
    const withinFeed = candidate === feedRoot || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
    if (!withinFeed || !existsSync(candidate) || !statSync(candidate).isFile()) {
        response.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not Found');
        return;
    }

    const size = statSync(candidate).size;
    const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': contentType(candidate)
    };
    const range = parseRange(request.headers.range, size);
    if (request.headers.range && !range) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
        return;
    }

    if (range) {
        const length = range.end - range.start + 1;
        response.writeHead(206, {
            ...headers,
            'Content-Length': length,
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`
        });
        if (request.method === 'HEAD') {
            response.end();
        } else {
            createReadStream(candidate, range).pipe(response);
        }
        return;
    }

    response.writeHead(200, { ...headers, 'Content-Length': size });
    if (request.method === 'HEAD') {
        response.end();
    } else {
        createReadStream(candidate).pipe(response);
    }
}

function parseRange(value, size) {
    if (!value) {
        return undefined;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
    if (!match || (!match[1] && !match[2])) {
        return undefined;
    }
    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        start = Math.max(size - suffixLength, 0);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        return undefined;
    }
    return { start, end: Math.min(end, size - 1) };
}

function contentType(filePath) {
    switch (extname(filePath).toLowerCase()) {
        case '.yml': return 'text/yaml; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        default: return 'application/octet-stream';
    }
}
