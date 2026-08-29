// Manual driver for the installed Poiesis app over CDP.
// Usage:
//   node scripts/dev/drive-installed.mjs launch [--workspace <path>] [--port <n>]
//   node scripts/dev/drive-installed.mjs stop
//   node scripts/dev/drive-installed.mjs shot <outPath.png>
//   node scripts/dev/drive-installed.mjs text [selector]
//   node scripts/dev/drive-installed.mjs list <selector>
//   node scripts/dev/drive-installed.mjs click <selector>
//   node scripts/dev/drive-installed.mjs clicktext <substring> [containerSelector]
//   node scripts/dev/drive-installed.mjs type <selector> <text...>
//   node scripts/dev/drive-installed.mjs press <key>
//   node scripts/dev/drive-installed.mjs eval <expression>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { ascii, defaultInstalledExe, parseOptions, waitForPage, waitUntil } from '../installed-smoke-utils.mjs';

const argv = process.argv.slice(2);
const command = argv.shift();
const options = parseOptions(argv);
const positional = options._ ?? [];
const port = Number(options.port || process.env.POIESIS_DRIVE_PORT || 43900);
const browserUrl = `http://127.0.0.1:${port}`;

if (command === 'launch') {
    const executable = resolve(options.exe || defaultInstalledExe);
    if (!existsSync(executable)) {
        fail(`missing executable: ${executable}`);
    }
    const args = [`--remote-debugging-port=${port}`];
    if (options.workspace) {
        args.unshift(resolve(options.workspace));
    }
    const child = spawn(executable, args, {
        cwd: dirname(executable),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    });
    child.unref();
    await waitUntil(async () => {
        try {
            const response = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
            return response.ok;
        } catch {
            return false;
        }
    }, 60_000, 'CDP endpoint did not become ready.');
    console.log(`DRIVE_LAUNCH=ok pid=${child.pid} port=${port}`);
    process.exit(0);
}

if (command === 'stop') {
    const result = spawnSync('taskkill.exe', ['/IM', 'Poiesis.exe', '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    console.log(`DRIVE_STOP=exit${result.status}`);
    process.exit(0);
}

const browser = await puppeteer.connect({ browserURL: browserUrl, defaultViewport: null });
const page = await waitForPage(browser, 15_000);

try {
    switch (command) {
        case 'shot': {
            const out = resolve(positional[0] || 'poiesis-shot.png');
            await page.screenshot({ path: out });
            console.log(`DRIVE_SHOT=${ascii(out)}`);
            break;
        }
        case 'text': {
            const selector = positional[0];
            const text = await page.evaluate(sel => {
                const node = sel ? document.querySelector(sel) : document.body;
                return node ? node.innerText : '<<no match>>';
            }, selector);
            console.log(ascii(text));
            break;
        }
        case 'list': {
            const selector = positional[0];
            const rows = await page.evaluate(sel => {
                return [...document.querySelectorAll(sel)].slice(0, 80).map((node, index) => {
                    const rect = node.getBoundingClientRect();
                    const text = (node.innerText || node.getAttribute('aria-label') || node.title || '').replace(/\s+/g, ' ').slice(0, 80);
                    return `${index}\t${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}\t${node.className && typeof node.className === 'string' ? node.className.slice(0, 60) : ''}\t${text}`;
                });
            }, selector);
            console.log(ascii(rows.join('\n') || '<<no match>>'));
            break;
        }
        case 'click': {
            await page.click(positional[0]);
            console.log('DRIVE_CLICK=ok');
            break;
        }
        case 'clicktext': {
            const target = positional[0];
            const container = positional[1] || 'body';
            const clicked = await page.evaluate((needle, containerSelector) => {
                const rootNode = document.querySelector(containerSelector) || document.body;
                const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
                const matches = [];
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const label = (node.innerText || node.getAttribute('aria-label') || '').trim();
                    if (label && (label === needle || label.startsWith(needle)) && node.getBoundingClientRect().width > 0) {
                        matches.push(node);
                    }
                }
                const best = matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
                if (!best) {
                    return null;
                }
                const rect = best.getBoundingClientRect();
                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
            }, target, container);
            if (!clicked) {
                fail(`no element with text: ${target}`);
            }
            await page.mouse.click(clicked.x, clicked.y);
            console.log(`DRIVE_CLICKTEXT=ok x=${Math.round(clicked.x)} y=${Math.round(clicked.y)}`);
            break;
        }
        case 'type': {
            const selector = positional[0];
            const text = positional.slice(1).join(' ');
            await page.click(selector);
            await page.type(selector, text, { delay: 10 });
            console.log('DRIVE_TYPE=ok');
            break;
        }
        case 'press': {
            await page.keyboard.press(positional[0]);
            console.log('DRIVE_PRESS=ok');
            break;
        }
        case 'eval': {
            const value = await page.evaluate(positional.join(' '));
            console.log(ascii(JSON.stringify(value)));
            break;
        }
        case 'clickxy': {
            await page.mouse.click(Number(positional[0]), Number(positional[1]));
            console.log('DRIVE_CLICKXY=ok');
            break;
        }
        case 'ftext': {
            for (const frame of page.frames()) {
                const text = await frame.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
                if (text.trim()) {
                    console.log(`----- frame ${ascii(frame.url()).slice(0, 80)}`);
                    console.log(ascii(text.slice(0, 6000)));
                }
            }
            break;
        }
        case 'fclicktext': {
            const needle = positional[0];
            let done = false;
            for (const frame of page.frames()) {
                const point = await frame.evaluate(target => {
                    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
                    const matches = [];
                    while (walker.nextNode()) {
                        const node = walker.currentNode;
                        const label = (node.innerText || node.getAttribute('aria-label') || '').trim();
                        if (label && (label === target || label.startsWith(target)) && node.getBoundingClientRect().width > 0) {
                            matches.push(node);
                        }
                    }
                    const best = matches.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
                    if (!best) {
                        return null;
                    }
                    best.scrollIntoView({ block: 'center' });
                    const rect = best.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }, needle).catch(() => null);
                if (point) {
                    const offset = await frame.frameElement()
                        ? await (await frame.frameElement()).boundingBox()
                        : null;
                    const x = point.x + (offset?.x ?? 0);
                    const y = point.y + (offset?.y ?? 0);
                    await page.mouse.click(x, y);
                    console.log(`DRIVE_FCLICKTEXT=ok x=${Math.round(x)} y=${Math.round(y)} frame=${ascii(frame.url()).slice(0, 60)}`);
                    done = true;
                    break;
                }
            }
            if (!done) {
                fail(`no frame element with text: ${needle}`);
            }
            break;
        }
        default:
            fail(`unknown command: ${command}`);
    }
} finally {
    await browser.disconnect();
}

function fail(message) {
    console.error(`DRIVE_ERROR=${ascii(message)}`);
    process.exit(1);
}
