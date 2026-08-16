import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spikeRoot } from './host-utils.mjs';

await mkdir(resolve(spikeRoot, 'artifacts'), { recursive: true });
