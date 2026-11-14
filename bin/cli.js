#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../src/core');
const G = require('../src/git');
const pr = require('../src/pr');
const hook = require('../src/hook');

function help() {
  process.stdout.write(`ShipCheck CLI — review your changes before they leave your machine

Usage: shipcheck [options]
  --base <ref>            base branch/ref (default: auto-detect)
  --scope <s>             branch (default) | staged | working
  --json                  print the full analysis as JSON
  --markdown              print the review as Markdown
  --pr                    print a generated pull-request description
  --fail-on <level>       blocking (default) | warning | none  — exit code 1 when reached
  --all                   include suggestions in text output
  --hook                  pre-push mode (committed changes only, compact output)
  --config-stdin          read settings JSON from stdin (used by the VS Code extension)
  --install-hook          install a git pre-push hook for this repository
  --uninstall-hook        remove the hook
  --cwd <dir>             repository directory (default: current)

Team config: .shipcheckrc.json in the repository root (same keys as the VS Code settings, without the "shipcheck." prefix).
`);
}

function parse(argv) {
  const o = { scope: 'branch', failOn: 'blocking' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case '--base': o.base = val(); break;
      case '--scope': o.scope = val(); break;
      case '--json': o.json = true; break;
      case '--markdown': o.markdown = true; break;
      case '--pr': o.pr = true; break;
      case '--fail-on': o.failOn = val(); break;
      case '--all': o.all = true; break;
      case '--hook': o.hook = true; break;
      case '--config-stdin': o.stdin = true; break;
      case '--install-hook': o.install = true; break;
      case '--uninstall-hook': o.uninstall = true; break;
      case '--cwd': o.cwd = val(); break;
      case '-h': case '--help': o.help = true; break;
      default: process.stderr.write(`Unknown option ${a}\n`); o.help = true;
    }
  }
  return o;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { help(); return 0; }
  const root = G.repoRoot(o.cwd || process.cwd());
  if (!root) { process.stderr.write('ShipCheck: not inside a git repository.\n'); return o.hook ? 0 : 2; }
  if (o.install) { const r = hook.install(root, path.join(__dirname, '..')); process.stdout.write(`pre-push hook ${r.mode}: ${r.hookFile}\n`); return 0; }
  if (o.uninstall) { const r = hook.uninstall(root); process.stdout.write(r.removed ? 'pre-push hook removed.\n' : 'No ShipCheck hook found.\n'); return 0; }

  let stdinCfg = {};
  if (o.stdin) { try { stdinCfg = JSON.parse(readStdin() || '{}'); } catch (e) { stdinCfg = {}; } }
  const cfg = core.mergeConfig(stdinCfg, core.loadRc(root), o.base ? { baseBranch: o.base } : null, o.hook ? { includeUncommitted: false, includeUntracked: false } : null);
  const out = o.hook ? process.stderr : process.stdout;
  let a;
  try {
    a = core.analyze(root, cfg, { scope: o.scope });
  } catch (e) {
    if (o.json) process.stdout.write(JSON.stringify({ error: e.message }));
    else process.stderr.write(`ShipCheck: ${e.message}\n`);
    return o.hook ? 0 : 2; // never block a push because the tool itself could not run
  }
  if (o.json) { process.stdout.write(JSON.stringify(a)); }
  else if (o.markdown) out.write(pr.buildReviewMarkdown(a) + '\n');
  else if (o.pr) out.write(pr.buildPR(a) + '\n');
  else if (!(o.hook && !a.stats.files)) out.write(pr.formatText(a, { color: !!out.isTTY && !process.env.NO_COLOR, all: o.all, max: o.hook ? 15 : 60 }) + '\n');

  const b = a.stats.bySeverity;
  if (o.failOn === 'blocking' && b.blocking) return 1;
  if (o.failOn === 'warning' && (b.blocking || b.warning)) return 1;
  return 0;
}

try { process.exitCode = main(); } catch (e) { process.stderr.write(`ShipCheck internal error: ${e.stack || e}\n`); process.exitCode = process.argv.includes('--hook') ? 0 : 2; }
