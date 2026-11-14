'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function detectCommands(root) {
  const cmds = [];
  const has = (f) => fs.existsSync(path.join(root, f));
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { return ''; } };
  if (has('package.json')) {
    let scripts = {};
    try { scripts = JSON.parse(read('package.json')).scripts || {}; } catch (e) { /* ignore */ }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
    const run = (s) => (pm === 'yarn' ? `yarn ${s}` : pm === 'npm' && s === 'test' ? 'npm test' : `${pm} run ${s}`);
    for (const s of ['lint', 'typecheck', 'type-check', 'tsc']) if (scripts[s]) { cmds.push(run(s)); if (s !== 'lint') break; }
    if (scripts.test && !/no test specified/i.test(scripts.test)) cmds.push(run('test'));
  }
  if (has('pytest.ini') || has('tox.ini') || /pytest/.test(read('pyproject.toml')) || /pytest/.test(read('setup.cfg'))) cmds.push('python -m pytest -q');
  if (has('go.mod')) cmds.push('go vet ./...', 'go test ./...');
  if (has('Cargo.toml')) cmds.push('cargo check', 'cargo test');
  return cmds;
}

function runCommands(root, commands, opts) {
  opts = opts || {};
  const timeoutMs = (opts.timeoutSec || 600) * 1000;
  const results = [];
  let cancelled = false;
  let current = null;
  const cancel = () => { cancelled = true; if (current) kill(current); };
  const kill = (child) => {
    try {
      if (process.platform === 'win32') cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else process.kill(-child.pid, 'SIGKILL');
    } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* gone */ } }
  };
  const promise = (async () => {
    for (const cmd of commands) {
      if (cancelled) break;
      const start = Date.now();
      const res = await new Promise((resolve) => {
        let out = ''; let timedOut = false;
        const child = cp.spawn(cmd, { cwd: root, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: Object.assign({}, process.env, { CI: '1', FORCE_COLOR: '0' }) });
        current = child;
        const timer = setTimeout(() => { timedOut = true; kill(child); }, timeoutMs);
        const onData = (d) => { const t = d.toString(); out += t; if (out.length > 400000) out = out.slice(-200000); if (opts.onOutput) opts.onOutput(t); };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e.message), timedOut }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, out, timedOut }); });
      });
      current = null;
      results.push({ cmd, code: cancelled ? 130 : res.code, timedOut: res.timedOut, durationMs: Date.now() - start, tail: res.out.split(/\r?\n/).slice(-60).join('\n') });
    }
    return results;
  })();
  return { promise, cancel };
}

module.exports = { detectCommands, runCommands };
