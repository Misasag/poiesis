import { StringDecoder } from 'node:string_decoder';
import type { HiddenCliProcess } from './hidden-process';

/** Each pipe has independent UTF-8 state; flush before the process close handlers. */
export function readChildUtf8(child: HiddenCliProcess, stdout: (text: string) => void, stderr: (text: string) => void): void {
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const outputs = [stdout, stderr];
    [child.stdout, child.stderr].forEach((stream, index) => {
        stream.on('data', (chunk: Buffer | string) => {
            const text = decoders[index].write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
            if (text) { outputs[index](text); }
        });
    });
    child.once('close', () => {
        decoders.forEach((decoder, index) => {
            const tail = decoder.end();
            if (tail) { outputs[index](tail); }
        });
    });
}
