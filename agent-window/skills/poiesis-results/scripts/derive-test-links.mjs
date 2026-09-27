// Read the executed test report. A matching name proves that the named test passed,
// not that it exercised a particular source line; the author chooses that relation.
export function deriveTestResults(evidence) {
  const text = typeof evidence === 'string' ? evidence.replace(/\r\n/g, '\n') : '';
  const commandPattern = /^(?:command|コマンド)\s*[:：]\s*([^\n]{1,300})$/gm;
  const commands = [...text.matchAll(commandPattern)];
  let run = null, report = '';
  for (let index = 0; index < commands.length; index++) {
    const current = commands[index], end = commands[index + 1]?.index ?? text.length;
    const segment = text.slice(current.index + current[0].length, end);
    const exit = /^(?:exit code|終了コード)\s*[:：]\s*(\d+)\s*$/im.exec(segment);
    if (!exit) continue;
    run = { command: current[1].trim(), exitCode: Number(exit[1]) };
    report = segment.slice(exit.index + exit[0].length);
    break;
  }
  const tests = [];
  if (run?.exitCode === 0) {
    const seen = new Set();
    for (const match of report.matchAll(/^\s*ok\s+\d+\s+-\s+([^\n]+)$/gm)) {
      const name = match[1].trim();
      if (name && !seen.has(name)) { tests.push({ name, status: 'pass' }); seen.add(name); }
    }
  }
  return { run, tests };
}
