// Read the executed test report. A matching name proves that the named test passed,
// not that it exercised a particular source line; the author chooses that relation.
export function deriveTestResults(evidence) {
  const text = typeof evidence === 'string' ? evidence.replace(/\r\n/g, '\n') : '';
  const command = /(?:^|\n)(?:command|コマンド)\s*[:：]\s*([^\n]{1,300})/.exec(text)?.[1]?.trim();
  const exit = /(?:^|\n)(?:exit code|終了コード)\s*[:：]\s*(\d+)\s*(?:\n|$)/i.exec(text)?.[1];
  const run = command && exit !== undefined ? { command, exitCode: Number(exit) } : null;
  const tests = [];
  if (run?.exitCode === 0) {
    const seen = new Set();
    for (const match of text.matchAll(/^\s*ok\s+\d+\s+-\s+([^\n]+)$/gm)) {
      const name = match[1].trim();
      if (name && !seen.has(name)) { tests.push({ name, status: 'pass' }); seen.add(name); }
    }
  }
  return { run, tests };
}
