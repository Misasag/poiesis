// Manual, explicitly budgeted OpenRouter integration check. Never print credentials or raw model output.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CliDetector } = require('../../agent-window/lib/node/cli-detector.js');
const { CliModelDiscoveryService } = require('../../agent-window/lib/node/cli-model-discovery.js');
const { CliProviderRegistry } = require('../../agent-window/lib/node/cli-provider-registry.js');
const { AgentRuntimeServerImpl } = require('../../agent-window/lib/node/agent-runtime-server.js');
const { ResultsGenerationServerImpl } = require('../../agent-window/lib/node/results-generation-server.js');
const { createAgentActivityParser } = require('../../agent-window/lib/browser/agent-activity-parser.js');
const { parseCliOutput } = require('../../agent-window/lib/common/cli-usage.js');

if (!process.env.OPENROUTER_API_KEY) {
    let query;
    try {
        query = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'OPENROUTER_API_KEY'],
            { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { throw new Error('OpenRouter key not available in user environment.'); }
    const match = query.match(/^\s*OPENROUTER_API_KEY\s+REG_\w+\s+(\S+)\s*$/m);
    if (!match) { throw new Error('OpenRouter key not available in user environment.'); }
    process.env.OPENROUTER_API_KEY = match[1];
}
const source = 'C:/Users/owner/github/pomodoro-web';
const scratch = await mkdtemp(join(tmpdir(), 'poiesis-pi-live-'));
const workspace = join(scratch, 'pomodoro-web');
const model = 'openrouter/z-ai/glm-5.3-flash';
let server;
try {
    await cp(source, workspace, { recursive: true, filter: path => !/(?:^|[\\/])(?:node_modules|\.git|dist|build)(?:[\\/]|$)/.test(path) });
    const detector = new CliDetector();
    const discovery = new CliModelDiscoveryService();
    const registry = new CliProviderRegistry(detector, discovery);
    server = new AgentRuntimeServerImpl(detector, registry, discovery);
    const report = await detector.detect();
    assert.equal(report.detections.find(d => d.id === 'pi')?.status, 'found');
    assert.equal(report.detections.find(d => d.id === 'pi')?.piAuth?.openrouter, 'ready');
    const catalog = await server.discoverModels({ providerId: 'pi' });
    assert(catalog.models.some(m => m.id === model));
    const parser = createAgentActivityParser('pi', workspace);
    const events = [];
    const activities = new Map();
    let settled = false;
    const exit = new Promise(done => server.setClient({ notifyCodexEvent(event) {
        if (event.type === 'exit') { done(event); return; }
        if (event.stream !== 'stdout') { return; }
        events.push(event.delta);
    } }));
    await server.runCodex({ executionId: 'pi-live', providerId: 'pi', model, workspacePath: workspace,
        prompt: 'Create a file named poiesis-pi-check.txt in this workspace containing exactly: pi provider verified (followed by one newline). Use the write tool. Then use bash to check its contents. Do not touch other files. Briefly report completion.' });
    const outcome = await exit;
    assert.equal(outcome.code, 0);
    const raw = events.join('');
    let succeeded = false;
    const safeFixture = [];
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        const result = parser.consumeLine(line);
        for (const activity of result.activities) { activities.set(activity.id, activity); }
        if (result.piSettled) { settled = true; succeeded = result.piSucceeded; }
        const event = JSON.parse(line);
        if (event.type === 'tool_execution_start') {
            safeFixture.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
                args: event.toolName === 'bash' ? { command: 'test -f poiesis-pi-check.txt' }
                    : { path: 'C:\\work\\probe\\poiesis-pi-check.txt' } });
        } else if (event.type === 'tool_execution_end') {
            safeFixture.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
        } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
            safeFixture.push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '完了しました。' }],
                stopReason: event.message.stopReason, usage: event.message.usage } });
        } else if (event.type === 'agent_settled') { safeFixture.push({ type: 'agent_settled' }); }
    }
    assert(settled && succeeded, 'pi must settle with stopReason stop');
    assert.equal((await readFile(join(workspace, 'poiesis-pi-check.txt'), 'utf8')).trim(), 'pi provider verified');
    assert([...activities.values()].some(a => a.kind === 'file-change' && a.status === 'completed'));
    assert([...activities.values()].some(a => a.kind === 'command' && a.status === 'completed'));
    const usage = parseCliOutput('pi', raw).usage;
    assert(usage?.inputTokens > 0 && usage.outputTokens > 0 && usage.costUsd > 0);
    const generator = new ResultsGenerationServerImpl(registry);
    const result = await generator.generate({ taskId: 'pi-live', providerId: 'pi', model,
        workspaceUri: `file:///${workspace.replaceAll('\\', '/')}`,
        taskMetadata: { status: 'completed', request: 'Create a verification file.', completionSummary: 'File created.' },
        changeSetSummary: 'Added poiesis-pi-check.txt', diff: '+pi provider verified',
        executionEvidence: 'The write and bash tools completed successfully.' });
    assert.equal(result.status, 'generated', result.error?.message);
    assert(result.html.includes('poiesis-pi-check.txt'));
    assert(result.call?.usage?.costUsd > 0);
    const cost = usage.costUsd + result.call.usage.costUsd;
    assert(cost < 0.50, 'Budget exceeded');
    await writeFile(new URL('../fixtures/pi-json-events.jsonl', import.meta.url), safeFixture.map(JSON.stringify).join('\n') + '\n', 'utf8');
    console.log(JSON.stringify({ catalog: catalog.source, activities: [...activities.values()].map(a => a.kind),
        fileChanged: true, agent: usage, results: { status: result.status, providerId: result.call.providerId,
            usage: result.call.usage, htmlChars: result.html.length }, totalEstimatedUsd: cost }));
} finally {
    server?.dispose();
    await rm(scratch, { recursive: true, force: true });
}
