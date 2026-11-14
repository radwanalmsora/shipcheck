'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./util');
const G = require('./git');
const { buildRules, scanFile } = require('./rules');
const analyzers = require('./analyzers');
const impact = require('./impact');

const VERSION = '1.0.0';

const DEFAULTS = {
  baseBranch: '',
  includeUncommitted: true,
  includeUntracked: true,
  ignorePaths: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/coverage/**', '**/vendor/**', '**/*.min.*', '**/*.map',
    '**/*.snap', '**/*.lock', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.svg', '**/*.generated.*'],
  disabledRules: [],
  severityOverrides: {},
  maxLineLength: 160,
  maxFileSizeKB: 1024,
  minAddedLinesForTestCheck: 8,
  customRules: []
};

const SEV_ORDER = { blocking: 0, warning: 1, suggestion: 2 };

// ------------------------------------------------------------------ config
function loadRc(root) {
  const p = path.join(root, '.shipcheckrc.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function mergeConfig(...layers) {
  const cfg = Object.assign({}, DEFAULTS);
  for (const l of layers) {
    if (!l) continue;
    for (const k of Object.keys(DEFAULTS)) if (l[k] !== undefined && l[k] !== null) cfg[k] = l[k];
  }
  return cfg;
}

// ------------------------------------------------------------------ base resolution
function resolveBase(root, cfg, scope) {
  if (G.gitOk(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) throw new Error('This repository has no commits yet — nothing to compare against.');
  const head = G.git(root, ['rev-parse', 'HEAD']).trim();
  const branch = (G.gitOk(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim();
  if (scope !== 'branch') return { oldRef: 'HEAD', baseName: 'HEAD', mergeBase: head, head, branch };
  const verify = (r) => G.gitOk(root, ['rev-parse', '--verify', '--quiet', r + '^{commit}']) !== null;
  let base = null;
  if (cfg.baseBranch) {
    if (!verify(cfg.baseBranch)) throw new Error(`Base branch "${cfg.baseBranch}" does not exist. Change "shipcheck.baseBranch" or run "ShipCheck: Choose Base Branch".`);
    base = cfg.baseBranch;
  } else {
    const cand = [];
    const sym = G.gitOk(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (sym && sym.trim()) cand.push(sym.trim());
    cand.push('origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop', 'trunk');
    base = cand.find(verify) || null;
    if (!base) {
      const up = G.gitOk(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      if (up && up.trim() && verify(up.trim())) base = up.trim();
    }
    if (!base) throw new Error('Could not detect the base branch (tried origin/main, origin/master, main, master, develop). Set "shipcheck.baseBranch".');
  }
  const mb = G.gitOk(root, ['merge-base', base, 'HEAD']);
  const mergeBase = mb && mb.trim() ? mb.trim() : G.git(root, ['rev-parse', base]).trim();
  return { oldRef: mergeBase, baseName: base, mergeBase, head, branch };
}

// ------------------------------------------------------------------ diff
function collectDiff(root, cfg, scope, ref) {
  const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--unified=0', '-M'];
  let args;
  if (scope === 'staged') args = [...common, '--cached'];
  else if (scope === 'working') args = [...common, 'HEAD'];
  else args = cfg.includeUncommitted ? [...common, ref.oldRef] : [...common, ref.oldRef, 'HEAD'];
  return G.git(root, args);
}

function parseDiff(text) {
  const files = [];
  let cur = null; let inHunk = false; let oldRem = 0; let newRem = 0; let oldNo = 0; let newNo = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (inHunk && (oldRem > 0 || newRem > 0)) {
      const c = line[0];
      if (c === '+') { cur.added.push({ line: newNo++, text: line.slice(1) }); newRem--; continue; }
      if (c === '-') { cur.removed.push({ line: oldNo++, text: line.slice(1) }); oldRem--; continue; }
      if (c === '\\') continue;
    } else if (line.startsWith('\\')) continue;
    inHunk = false;
    if (line.startsWith('diff --git ')) {
      cur = { path: null, oldPath: null, status: 'modified', binary: false, added: [], removed: [], hunks: [] };
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m) { cur.oldPath = m[1]; cur.path = m[2]; }
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) cur.binary = true;
    else if (line.startsWith('--- ')) { const p = line.slice(4).replace(/\t.*$/, ''); if (p !== '/dev/null') cur.oldPath = p.replace(/^a\//, ''); }
    else if (line.startsWith('+++ ')) { const p = line.slice(4).replace(/\t.*$/, ''); if (p !== '/dev/null') cur.path = p.replace(/^b\//, ''); }
    else if ((m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/))) {
      oldNo = parseInt(m[1], 10); oldRem = m[2] === undefined ? 1 : parseInt(m[2], 10);
      newNo = parseInt(m[3], 10); newRem = m[4] === undefined ? 1 : parseInt(m[4], 10);
      cur.hunks.push({ oldStart: oldNo, oldLines: oldRem, newStart: newNo, newLines: newRem, ctx: m[5] || '' });
      // with -U0 a pure deletion reports newStart as the line *before*; counts are authoritative.
      inHunk = oldRem > 0 || newRem > 0;
    }
  }
  for (const f of files) { if (f.status === 'deleted') f.path = f.oldPath; if (!f.path) f.path = f.oldPath; }
  return files.filter((f) => f.path);
}

function untrackedFiles(root, cfg) {
  const out = [];
  const list = (G.gitOk(root, ['ls-files', '--others', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean).slice(0, 500);
  for (const rel of list) {
    const abs = path.join(root, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      const f = { path: rel, oldPath: null, status: 'added', untracked: true, binary: false, added: [], removed: [], hunks: [] };
      if (st.size > cfg.maxFileSizeKB * 1024 * 2) { f.binary = true; f.sizeKB = st.size / 1024; out.push(f); continue; }
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) { f.binary = true; out.push(f); continue; }
      buf.toString('utf8').split(/\r?\n/).forEach((t, i, arr) => { if (!(i === arr.length - 1 && t === '')) f.added.push({ line: i + 1, text: t }); });
      f.hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: f.added.length, ctx: '' });
      out.push(f);
    } catch (e) { /* unreadable */ }
  }
  return out;
}

// ------------------------------------------------------------------ analysis
function analyze(root, userCfg, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const cfg = mergeConfig(userCfg);
  const scope = opts.scope || 'branch';
  const ref = resolveBase(root, cfg, scope);
  const diffText = collectDiff(root, cfg, scope, ref);
  const all = parseDiff(diffText);
  if (scope === 'working' || (scope === 'branch' && cfg.includeUncommitted)) {
    if (cfg.includeUntracked) {
      const known = new Set(all.map((f) => f.path));
      for (const u of untrackedFiles(root, cfg)) if (!known.has(u.path)) all.push(u);
    }
  }
  for (const f of all) {
    f.lang = U.langOf(f.path);
    f.isTest = U.isTestFile(f.path);
    f.isDoc = U.isDocFile(f.path);
    f.kind = U.classify(f.path);
    f.additions = f.added.length;
    f.deletions = f.removed.length;
    f.ignored = U.matchesAny(cfg.ignorePaths, f.path);
  }
  all.sort((a, b) => a.path.localeCompare(b.path));

  const warnings = [];
  let trackedCache = null;
  const ctx = {
    root, cfg, ref, scope, all, warnings,
    files: all.filter((f) => !f.ignored && !f.binary),
    readOld: (p) => G.gitOk(root, ['show', `${ref.oldRef}:${p}`]),
    readNew: (p, max) => {
      try {
        const abs = path.join(root, p);
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > (max || 2 * 1024 * 1024)) return null;
        return fs.readFileSync(abs, 'utf8');
      } catch (e) { return null; }
    },
    sizeKB: (p) => { try { return fs.statSync(path.join(root, p)).size / 1024; } catch (e) { return null; } },
    tracked: () => {
      if (!trackedCache) {
        const l = (G.gitOk(root, ['ls-files', '-z']) || '').split('\0').filter(Boolean);
        trackedCache = new Set(l.length > 200000 ? l.slice(0, 200000) : l);
      }
      return trackedCache;
    }
  };

  const rules = buildRules(cfg);
  let findings = [];
  for (const f of ctx.files) if (f.status !== 'deleted') findings.push(...scanFile(f, cfg, rules));
  findings.push(...analyzers.run(ctx));
  let impactData; let tests;
  try {
    const r = impact.run(ctx, findings);
    impactData = r.impact; tests = r.tests;
  } catch (e) {
    warnings.push('Impact analysis failed: ' + e.message);
    impactData = { files: [], routes: { added: [], removed: [], affected: [] }, testsToRun: [], truncated: false, totals: { symbols: 0, referencingFiles: 0, dependents: 0 } };
    tests = { framework: null, inDiff: [], filesWithoutTests: [], suggestions: [], runHint: '' };
  }

  findings = finalize(findings, cfg);
  const reversibility = assessReversibility(ctx, findings);
  const stats = computeStats(all, findings);
  const risk = scoreRisk(stats, findings, tests, reversibility);

  let commits = [];
  if (scope === 'branch' && ref.mergeBase !== ref.head) {
    const log = G.gitOk(root, ['log', '--no-merges', '--format=%h%x1f%s', `${ref.mergeBase}..HEAD`, '-n', '40']) || '';
    commits = log.split('\n').filter(Boolean).map((l) => { const [hash, subject] = l.split('\x1f'); return { hash, subject }; });
  }

  return {
    version: VERSION,
    meta: {
      root, repo: path.basename(root), scope, baseName: ref.baseName, mergeBase: ref.mergeBase.slice(0, 10), mergeBaseFull: ref.mergeBase, branch: ref.branch,
      generatedAt: new Date().toISOString(), durationMs: Date.now() - t0, warnings
    },
    stats, risk, findings, impact: impactData, tests, reversibility, commits, apiChanges: ctx.api, depChanges: ctx.depChanges || [], migrations: ctx.migrations || [],
    files: all.map((f) => ({
      path: f.path, oldPath: f.oldPath, status: f.status, kind: f.kind, lang: f.lang, additions: f.additions, deletions: f.deletions,
      binary: f.binary, ignored: f.ignored, isTest: f.isTest,
      symbols: ((impactData.files.find((e) => e.path === f.path) || {}).symbols || []).map((s) => s.name)
    }))
  };
}

function finalize(findings, cfg) {
  const disabled = new Set(cfg.disabledRules || []);
  const ov = cfg.severityOverrides || {};
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (disabled.has(f.ruleId) || ov[f.ruleId] === 'off') continue;
    if (ov[f.ruleId] && SEV_ORDER[ov[f.ruleId]] !== undefined) f.severity = ov[f.ruleId];
    const key = [f.ruleId, f.file, f.line, f.title].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  out.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.file || '').localeCompare(b.file || '') || (a.line || 0) - (b.line || 0));
  out.forEach((f, i) => { f.id = 'F' + (i + 1); });
  return out;
}

function computeStats(all, findings) {
  const s = { files: all.length, additions: 0, deletions: 0, byStatus: {}, byKind: {}, bySeverity: { blocking: 0, warning: 0, suggestion: 0 }, byCategory: {} };
  for (const f of all) {
    s.additions += f.additions; s.deletions += f.deletions;
    s.byStatus[f.status] = (s.byStatus[f.status] || 0) + 1;
    s.byKind[f.kind] = (s.byKind[f.kind] || 0) + 1;
  }
  for (const f of findings) {
    s.bySeverity[f.severity]++;
    s.byCategory[f.category] = (s.byCategory[f.category] || 0) + 1;
  }
  return s;
}

function assessReversibility(ctx, findings) {
  const reasons = [];
  const add = (level, text) => reasons.push({ level, text });
  const has = (id) => findings.some((f) => f.ruleId === id);
  const hasPrefix = (p) => findings.some((f) => f.ruleId.startsWith(p));
  const size = ctx.all.reduce((n, f) => n + f.additions + f.deletions, 0);
  const migrations = ctx.migrations || [];

  if (has('DB-DESTRUCTIVE')) add('danger', 'Destructive SQL/schema operation: reverting the commit does not bring the data back.');
  if (has('DB-NO-ROLLBACK') || has('DB-IRREVERSIBLE')) add('danger', 'A migration has no rollback step.');
  if (migrations.length) add('warn', `${migrations.length} migration file(s): roll back the code AND the schema, in the right order.`);
  if (has('API-ROUTE-CHANGED') || has('API-SIGNATURE-CHANGED') || has('API-CONTRACT-BREAKING') || has('API-PROTO-FIELD-REMOVED')) add('warn', 'Breaking API change: clients that adopt the new shape will break on rollback.');
  if (has('API-PROTO-FIELD-REUSED')) add('danger', 'Protobuf field number reuse corrupts data across versions.');
  const deleted = ctx.all.filter((f) => f.status === 'deleted').length;
  if (deleted) add('info', `${deleted} file(s) deleted (recoverable from git).`);
  if (hasPrefix('DEP-')) add('warn', 'Dependency changes: a revert must also restore the lockfile and reinstall.');
  if (has('INFRA-CHANGED')) add('warn', 'Pipeline / infrastructure configuration changed: re-deploy the previous config on rollback.');
  if (has('CFG-NEW-ENV')) add('warn', 'New environment variables are required: configure them before deploying.');
  if (size > 1000 || ctx.all.length > 40) add('warn', `Large change (${size} lines, ${ctx.all.length} files): harder to revert cleanly and to reason about.`);
  const flag = ctx.all.some((f) => f.added.some((l) => /feature[_-]?flags?|isFeatureEnabled|flags?\.(?:is|get)|unleash|launchdarkly|growthbook/i.test(l.text)));
  if (flag) add('good', 'Feature-flag usage detected: you can disable the behaviour without a redeploy.');
  const onlySafe = ctx.all.length > 0 && ctx.all.every((f) => f.kind === 'test' || f.kind === 'doc');
  if (onlySafe) add('good', 'Only tests/docs changed: no runtime impact.');
  if (!reasons.some((r) => r.level === 'danger' || r.level === 'warn') && size <= 200) add('good', 'Small, self-contained change: `git revert` is enough.');

  const danger = reasons.some((r) => r.level === 'danger');
  const warn = reasons.some((r) => r.level === 'warn');
  const verdict = danger ? 'hard' : warn ? 'careful' : 'easy';
  const label = { hard: 'Hard to roll back', careful: 'Roll back with care', easy: 'Easy to roll back' }[verdict];
  const plan = [];
  if (verdict === 'easy') plan.push('`git revert <merge-commit>` and redeploy.');
  else {
    plan.push('Prepare the revert commit before merging.');
    if (migrations.length || has('DB-DESTRUCTIVE')) plan.push('Back up the affected tables and rehearse the down-migration on a copy of production data.');
    if (hasPrefix('DEP-')) plan.push('After revert, reinstall from the restored lockfile (e.g. `npm ci`).');
    if (!flag && (size > 300 || danger)) plan.push('Consider shipping behind a feature flag so rollback does not need a deploy.');
    plan.push('Deploy in two steps (expand → contract) so old and new versions can run side by side.');
  }
  return { verdict, label, reasons, plan };
}

function scoreRisk(stats, findings, tests, rev) {
  if (!stats.files) return { score: 0, label: 'None' };
  const b = stats.bySeverity.blocking; const w = stats.bySeverity.warning; const s = stats.bySeverity.suggestion;
  let score = Math.min(60, b * 25) + Math.min(30, w * 5) + Math.min(5, s * 0.5);
  const size = stats.additions + stats.deletions;
  score += size > 1500 ? 10 : size > 600 ? 6 : size > 200 ? 3 : 0;
  if (tests.filesWithoutTests.length) score += 8;
  score += rev.verdict === 'hard' ? 10 : rev.verdict === 'careful' ? 4 : 0;
  if (b > 0) score = Math.max(score, 55);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score < 20 ? 'Low' : score < 45 ? 'Medium' : score < 70 ? 'High' : 'Critical';
  return { score, label };
}

module.exports = { analyze, mergeConfig, loadRc, DEFAULTS, VERSION, parseDiff, resolveBase, SEV_ORDER };
