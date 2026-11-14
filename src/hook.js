'use strict';
const fs = require('fs');
const path = require('path');
const G = require('./git');

const START = '# >>> shipcheck >>>';
const END = '# <<< shipcheck <<<';
const BLOCK = `${START}
# Installed by ShipCheck. Bypass once with: SHIPCHECK_SKIP=1 git push   (or git push --no-verify)
if [ -z "$SHIPCHECK_SKIP" ]; then
  SC_DIR="$(git rev-parse --git-common-dir 2>/dev/null)/shipcheck"
  if [ -f "$SC_DIR/bin/cli.js" ] && command -v node >/dev/null 2>&1; then
    node "$SC_DIR/bin/cli.js" --hook || exit 1
  fi
fi
${END}`;

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, filter); else if (!filter || filter(s)) fs.copyFileSync(s, d);
  }
}

function paths(root) {
  const common = path.resolve(root, G.git(root, ['rev-parse', '--git-common-dir']).trim());
  const hooksRaw = G.git(root, ['rev-parse', '--git-path', 'hooks']).trim();
  const hooks = path.resolve(root, hooksRaw);
  return { common, hooks, runtime: path.join(common, 'shipcheck'), hookFile: path.join(hooks, 'pre-push') };
}

function install(root, extRoot) {
  const p = paths(root);
  fs.rmSync(p.runtime, { recursive: true, force: true });
  copyDir(path.join(extRoot, 'src'), path.join(p.runtime, 'src'), (f) => f.endsWith('.js'));
  copyDir(path.join(extRoot, 'bin'), path.join(p.runtime, 'bin'), (f) => f.endsWith('.js'));
  fs.writeFileSync(path.join(p.runtime, 'package.json'), '{"private":true}\n');
  fs.mkdirSync(p.hooks, { recursive: true });
  let content = '';
  try { content = fs.readFileSync(p.hookFile, 'utf8'); } catch (e) { /* new */ }
  let mode = 'created';
  if (!content) content = '#!/bin/sh\n' + BLOCK + '\n';
  else if (content.includes(START)) { content = content.replace(new RegExp(`${START}[\\s\\S]*?${END}`), BLOCK); mode = 'updated'; }
  else { content = content.replace(/\s*$/, '\n') + '\n' + BLOCK + '\n'; mode = 'appended'; }
  fs.writeFileSync(p.hookFile, content, { mode: 0o755 });
  try { fs.chmodSync(p.hookFile, 0o755); } catch (e) { /* windows */ }
  return Object.assign({ mode }, p);
}

function uninstall(root) {
  const p = paths(root);
  let removed = false;
  try {
    let content = fs.readFileSync(p.hookFile, 'utf8');
    if (content.includes(START)) {
      content = content.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), '\n');
      if (content.replace(/#!.*\n?/, '').trim() === '') fs.unlinkSync(p.hookFile); else fs.writeFileSync(p.hookFile, content);
      removed = true;
    }
  } catch (e) { /* none */ }
  fs.rmSync(p.runtime, { recursive: true, force: true });
  return { removed, ...p };
}

function status(root) {
  const p = paths(root);
  let installed = false;
  try { installed = fs.readFileSync(p.hookFile, 'utf8').includes(START) && fs.existsSync(path.join(p.runtime, 'bin', 'cli.js')); } catch (e) { /* no */ }
  return Object.assign({ installed }, p);
}

module.exports = { install, uninstall, status };
