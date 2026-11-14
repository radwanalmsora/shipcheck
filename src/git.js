'use strict';
const cp = require('child_process');

function git(root, args, opts) {
  opts = opts || {};
  try {
    return cp.execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } catch (e) {
    if (opts.allowFail) return null;
    const msg = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
    const err = new Error(msg || 'git command failed');
    err.status = e.status;
    throw err;
  }
}
const gitOk = (root, args) => git(root, args, { allowFail: true });

function repoRoot(cwd) {
  try {
    return cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
  } catch (e) { return null; }
}

// git grep returning "path:count" pairs. exit code 1 = no match.
function grepCount(root, pattern, mode) {
  const flags = mode === 'regex' ? ['-E'] : ['-w', '-F'];
  const out = git(root, ['grep', '-I', '--untracked', '-c', '--no-color', ...flags, '-e', pattern, '--', '.'], { allowFail: true });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => {
    const i = l.lastIndexOf(':');
    return { path: l.slice(0, i), count: parseInt(l.slice(i + 1), 10) || 1 };
  });
}

module.exports = { git, gitOk, repoRoot, grepCount };
