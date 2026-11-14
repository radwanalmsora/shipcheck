'use strict';
const path = require('path');
const U = require('./util');
const G = require('./git');
const S = require('./symbols');
const { finding, extractRoutes } = require('./rules');

const GENERIC_BASENAMES = new Set(['index', 'main', 'mod', '__init__', 'app', 'utils', 'util', 'types', 'constants', 'helpers', 'config']);
const MAX_SYMBOLS = 60;
const MAX_FILES_PER_SYMBOL = 80;
const TIME_BUDGET_MS = 20000;

function symbolsFor(f) {
  const seen = new Map();
  const add = (name, kind, exported) => {
    if (!name || name.length < 3 || S.KEYWORDS.has(name)) return;
    const cur = seen.get(name);
    if (!cur) seen.set(name, { name, kind, exported: !!exported });
    else if (exported) cur.exported = true;
  };
  for (const l of f.added) {
    for (const e of S.exportsInLine(l.text, f.lang)) add(e.name, e.kind, true);
    for (const d of S.declsInLine(l.text, f.lang)) add(d.name, d.kind, false);
  }
  if (f.status !== 'added') {
    for (const l of f.removed) for (const d of S.declsInLine(l.text, f.lang)) add(d.name, d.kind, false);
    for (const h of f.hunks) {
      if (!h.ctx) continue;
      const ds = S.declsInLine(h.ctx, f.lang);
      if (ds.length) add(ds[0].name, ds[0].kind, false);
      else {
        const m = h.ctx.match(/([A-Za-z_$][\w$]*)\s*\(/);
        if (m) add(m[1], 'function', false);
      }
    }
  }
  return [...seen.values()].sort((a, b) => Number(b.exported) - Number(a.exported)).slice(0, 10);
}

function testBaseName(p) {
  let b = path.posix.basename(p).replace(/\.[^.]+$/, '');
  b = b.replace(/\.(test|spec|e2e)$/i, '').replace(/^test_/i, '').replace(/_test$/i, '').replace(/(Tests?|Spec|IT)$/, '');
  return b.toLowerCase();
}

function detectFramework(ctx) {
  const pkg = ctx.readNew('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      const all = Object.assign({}, j.dependencies, j.devDependencies);
      if (all.vitest) return 'vitest';
      if (all.jest || all['ts-jest'] || all['@jest/core']) return 'jest';
      if (all.mocha) return 'mocha';
      if (all['@playwright/test']) return 'playwright';
      if (all.cypress) return 'cypress';
      if (j.scripts && /jest/.test(j.scripts.test || '')) return 'jest';
    } catch (e) { /* ignore */ }
  }
  const tracked = ctx.tracked();
  if (tracked.has('go.mod')) return 'go';
  if (tracked.has('pytest.ini') || tracked.has('pyproject.toml') || tracked.has('tox.ini') || tracked.has('setup.cfg') || [...tracked].some((p) => /^tests?\/.*\.py$/.test(p))) return 'pytest';
  if (tracked.has('Cargo.toml')) return 'cargo';
  return null;
}

function stubFor(framework, file, names) {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const cases = ['returns the expected result for a typical input', 'handles empty / null / boundary input', 'fails clearly on invalid input or dependency errors'];
  const ts = /\.tsx?$/.test(file);
  if (['jest', 'vitest', 'mocha'].includes(framework)) {
    const imp = framework === 'vitest' ? "import { describe, it, expect } from 'vitest';\n" : '';
    return imp + `import { ${names.join(', ')} } from './${base}';\n\n` + names.map((n) =>
      `describe('${n}', () => {\n` + cases.map((c) => `  it('${c}', ${ts ? '() => {' : '() => {'}\n    // arrange\n    // act\n    // assert\n    expect(true).toBe(false); // TODO\n  });\n`).join('\n') + '});\n').join('\n');
  }
  if (framework === 'pytest') {
    const mod = base;
    return `from ${mod} import ${names.join(', ')}\n\n` + names.map((n) =>
      cases.map((c, i) => `def test_${n}_${['happy_path', 'edge_cases', 'errors'][i]}():\n    """${c}"""\n    raise NotImplementedError\n`).join('\n')).join('\n');
  }
  if (framework === 'go') {
    return names.map((n) => `func Test${n[0].toUpperCase() + n.slice(1)}(t *testing.T) {\n\ttests := []struct{ name string }{{"typical"}, {"empty"}, {"invalid"}}\n\tfor _, tc := range tests {\n\t\tt.Run(tc.name, func(t *testing.T) {\n\t\t\tt.Fatal("TODO")\n\t\t})\n\t}\n}\n`).join('\n');
  }
  return names.map((n) => `${n}:\n` + cases.map((c) => `  - ${c}`).join('\n')).join('\n\n');
}

function resolveImportMatches(depPath, content, targetPaths) {
  // does `content` (of depPath) import any of targetPaths (relative specifiers)? JS-like only.
  const dir = path.posix.dirname(depPath);
  const re = /(?:from\s*|require\(\s*|import\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const resolved = path.posix.normalize(path.posix.join(dir, m[1]));
    for (const t of targetPaths) {
      const noExt = t.replace(/\.[^./]+$/, '');
      if (resolved === t || resolved === noExt || resolved === noExt.replace(/\/index$/, '')) return m[1];
    }
  }
  return null;
}

function run(ctx, findings) {
  const t0 = Date.now();
  const { cfg } = ctx;
  const out = { files: [], routes: { added: [], removed: [], affected: [] }, testsToRun: [], truncated: false, totals: { symbols: 0, referencingFiles: 0, dependents: 0 } };
  const refCache = new Map();
  const depCache = new Map();
  let budget = MAX_SYMBOLS;
  const timeUp = () => Date.now() - t0 > TIME_BUDGET_MS;

  const refsOf = (name, ownFile) => {
    let r = refCache.get(name);
    if (!r) {
      const hits = G.grepCount(ctx.root, name, 'word').filter((h) => !U.matchesAny(cfg.ignorePaths, h.path) || U.isTestFile(h.path));
      r = hits;
      refCache.set(name, r);
    }
    return r.filter((h) => h.path !== ownFile);
  };

  const sourceFiles = ctx.all.filter((f) => !f.binary && f.kind === 'source' && !f.isTest);
  const changedTests = ctx.all.filter((f) => f.isTest && f.status !== 'deleted');
  const changedTestContent = changedTests.map((f) => ({ path: f.path, content: ctx.readNew(f.path) || '' }));
  const framework = detectFramework(ctx);
  const testSuggestions = [];
  const filesWithoutTests = [];
  const testRefSet = new Set();
  const trackedTests = [...ctx.tracked()].filter((p) => U.isTestFile(p) && U.classify(p) === 'test');
  const testByBase = new Map();
  for (const t of trackedTests) { const b = testBaseName(t); if (!testByBase.has(b)) testByBase.set(b, []); testByBase.get(b).push(t); }

  for (const f of sourceFiles) {
    const entry = { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, symbols: [], dependents: [] };
    const syms = f.status === 'deleted' ? [] : symbolsFor(f);
    const refFiles = new Set();
    for (const s of syms) {
      if (budget <= 0 || timeUp()) { out.truncated = true; entry.symbols.push({ ...s, refs: [], refTotal: 0, tests: [], skipped: true }); continue; }
      const generic = S.GENERIC.has(s.name.toLowerCase());
      if (generic) { entry.symbols.push({ ...s, refs: [], refTotal: 0, tests: [], generic: true }); continue; }
      budget--;
      const refs = refsOf(s.name, f.path).sort((a, b) => b.count - a.count);
      const tooMany = refs.length > MAX_FILES_PER_SYMBOL;
      const tests = refs.filter((r) => U.isTestFile(r.path)).map((r) => r.path);
      for (const r of refs) { if (!U.isTestFile(r.path)) refFiles.add(r.path); }
      for (const t of tests) testRefSet.add(t);
      entry.symbols.push({ ...s, refs: refs.slice(0, 12), refTotal: refs.length, tests: tests.slice(0, 8), generic: tooMany });
      out.totals.symbols++;
    }
    // dependents (importers)
    const base = path.posix.basename(f.path).replace(/\.[^.]+$/, '');
    const delOrRenamed = f.status === 'deleted' || f.status === 'renamed';
    const targetPaths = delOrRenamed ? [f.status === 'deleted' ? f.path : f.oldPath].filter(Boolean) : [];
    const lookupBase = delOrRenamed && f.status === 'renamed' ? path.posix.basename(f.oldPath).replace(/\.[^.]+$/, '') : base;
    if (!timeUp() && (!GENERIC_BASENAMES.has(lookupBase.toLowerCase()) || delOrRenamed)) {
      let deps = depCache.get(lookupBase);
      if (!deps) {
        const esc = U.escapeRe(lookupBase);
        deps = G.grepCount(ctx.root, `(['"/.]${esc}(\\.[A-Za-z]+)?['"])|((from|import)[[:space:]]+[A-Za-z0-9_.]*[.[:space:]]${esc}([[:space:]]|$))`, 'regex');
        depCache.set(lookupBase, deps);
      }
      const ownPaths = new Set([f.path, f.oldPath].filter(Boolean));
      const dependents = deps.filter((d) => !ownPaths.has(d.path) && !U.matchesAny(cfg.ignorePaths, d.path) && !U.isTestFile(d.path)).map((d) => d.path);
      entry.dependents = dependents.slice(0, 30);
      out.totals.dependents += dependents.length;
      dependents.forEach((d) => refFiles.add(d));
      if (delOrRenamed && dependents.length) {
        const broken = [];
        for (const d of dependents.slice(0, 60)) {
          if (U.langOf(d) !== 'js') continue;
          const spec = resolveImportMatches(d, ctx.readNew(d) || '', targetPaths);
          if (spec) broken.push({ file: d, spec });
        }
        if (broken.length) {
          findings.push(finding({
            ruleId: 'IMPORT-BROKEN', severity: 'blocking', category: 'api', file: broken[0].file,
            title: `${f.status === 'deleted' ? 'Deleted' : 'Moved'} file ${path.posix.basename(targetPaths[0])} is still imported by ${broken.length} file(s)`,
            detail: broken.slice(0, 5).map((b) => `${b.file} → "${b.spec}"`).join('; '),
            why: 'These imports no longer resolve, so the build or runtime will fail.', fix: 'Update the import paths or restore the file.'
          }));
        } else {
          findings.push(finding({
            ruleId: 'FILE-REMOVED-REFERENCED', severity: 'warning', category: 'api', file: dependents[0],
            title: `${f.status === 'deleted' ? 'Deleted' : 'Moved'} file "${base}" may still be referenced by ${dependents.length} file(s)`,
            detail: dependents.slice(0, 5).join(', '),
            why: 'Name-based search found references that may now be dangling.', fix: 'Check each reference (see Impact map).'
          }));
        }
      }
    }
    out.totals.referencingFiles += refFiles.size;
    entry._refFiles = [...refFiles];
    out.files.push(entry);

    // ---- test coverage for this file
    if (f.status !== 'deleted' && f.additions >= cfg.minAddedLinesForTestCheck) {
      const names = [...new Set(syms.filter((s) => s.exported || s.kind === 'function' || s.kind === 'class' || s.kind === 'method').map((s) => s.name))].slice(0, 6);
      const lowBase = base.toLowerCase();
      const inDiff = changedTestContent.filter((t) => testBaseName(t.path) === lowBase || t.content.includes(base) || names.some((n) => new RegExp('\\b' + U.escapeRe(n) + '\\b').test(t.content)));
      const refTests = [...new Set(entry.symbols.flatMap((s) => s.tests))];
      const byName = testByBase.get(lowBase) || [];
      const existing = [...new Set(refTests.concat(byName))];
      const branches = (f.added.map((l) => l.text).join('\n').match(/\b(?:if|elif|switch|case|catch|except|throw|raise|panic)\b/g) || []).length;
      if (inDiff.length) {
        inDiff.forEach((t) => out.testsToRun.push(t.path));
      } else if (existing.length) {
        existing.forEach((t) => out.testsToRun.push(t));
        filesWithoutTests.push({ file: f.path, reason: 'stale', tests: existing.slice(0, 5) });
        findings.push(finding({
          ruleId: 'TEST-NOT-UPDATED', severity: 'suggestion', category: 'tests', file: f.path, line: f.added[0] ? f.added[0].line : 0,
          title: `${path.posix.basename(f.path)}: ${f.additions} lines added but its tests were not touched`,
          detail: 'existing tests: ' + existing.slice(0, 3).join(', '),
          why: 'The tests that cover this file were not updated, so the new behaviour may be unverified.', fix: 'Add cases for the new code paths' + (branches ? ` (${branches} new branch point${branches > 1 ? 's' : ''})` : '') + '.'
        }));
      } else {
        filesWithoutTests.push({ file: f.path, reason: 'none', tests: [] });
        const heavy = f.additions >= 30 || branches >= 4;
        findings.push(finding({
          ruleId: 'TEST-MISSING', severity: heavy ? 'warning' : 'suggestion', category: 'tests', file: f.path, line: f.added[0] ? f.added[0].line : 0,
          title: `No tests found for ${path.posix.basename(f.path)} (${f.additions} lines added)`,
          detail: branches ? `${branches} new branch point(s) need coverage` : '',
          why: 'No test in the diff or in the repository references this file or its new symbols.', fix: 'Add unit tests; a starting point is shown in the Tests section.'
        }));
        if (names.length) testSuggestions.push({ file: f.path, symbols: names, branches, stub: stubFor(framework, f.path, names) });
      }
    }
  }
  out.files = out.files.filter((e) => e.symbols.length || e.dependents.length || e.status === 'deleted' || true);

  // ---- removed exports: still referenced?
  for (const ex of ctx.api.exportsRemoved) {
    if (timeUp()) break;
    if (S.GENERIC.has(ex.name.toLowerCase()) || ex.name.length < 3) continue;
    const refs = refsOf(ex.name, ex.file).filter((r) => !U.isTestFile(r.path) || true);
    const nonSelf = refs.filter((r) => r.path !== ex.file);
    if (nonSelf.length) {
      findings.push(finding({
        ruleId: 'API-EXPORT-REMOVED-IN-USE', severity: ex.deletedFile ? 'warning' : 'warning', category: 'api', file: ex.file, line: ex.line,
        title: `Public symbol \`${ex.name}\` was removed/renamed but is still mentioned in ${nonSelf.length} file(s)`,
        detail: nonSelf.slice(0, 5).map((r) => r.path).join(', '),
        why: 'Callers that still use the old name will fail (name-based match, so verify each one).', fix: 'Update the callers or keep a deprecated alias.'
      }));
    } else if (!ex.deletedFile) {
      findings.push(finding({
        ruleId: 'API-EXPORT-REMOVED', severity: 'suggestion', category: 'api', file: ex.file, line: ex.line,
        title: `Public symbol \`${ex.name}\` removed`, why: 'No references found in this repo, but external consumers (other packages/services) could use it.',
        fix: 'If this is a published library, treat it as a breaking change.'
      }));
    }
  }

  // ---- affected routes (routes defined in files that reference changed symbols)
  const seenRoute = new Set();
  const candidate = new Set();
  out.files.forEach((e) => (e._refFiles || []).forEach((p) => candidate.add(p)));
  let scanned = 0;
  for (const p of candidate) {
    if (scanned++ > 40 || timeUp()) break;
    const lang = U.langOf(p);
    const content = ctx.readNew(p, 200 * 1024);
    if (!content) continue;
    content.split(/\r?\n/).forEach((line, i) => {
      for (const r of extractRoutes(line, lang, p)) {
        const k = r.method + ' ' + r.path + ' ' + p;
        if (!seenRoute.has(k)) { seenRoute.add(k); out.routes.affected.push({ ...r, file: p, line: i + 1 }); }
      }
    });
  }
  out.routes.affected = out.routes.affected.slice(0, 60);
  out.routes.added = ctx.api.routesAdded.map(({ method, path: p, file, line }) => ({ method, path: p, file, line }));
  out.routes.removed = ctx.api.routesRemoved.map(({ method, path: p, file, line }) => ({ method, path: p, file, line }));

  out.files.forEach((e) => { delete e._refFiles; });
  out.testsToRun = [...new Set(out.testsToRun.concat([...testRefSet]))].slice(0, 40);
  if (timeUp()) out.truncated = true;

  const tests = {
    framework,
    inDiff: changedTests.map((f) => f.path),
    filesWithoutTests,
    suggestions: testSuggestions,
    runHint: runHint(framework, out.testsToRun)
  };
  return { impact: out, tests };
}

function runHint(framework, files) {
  if (!files.length) return '';
  const q = (p) => (/\s/.test(p) ? JSON.stringify(p) : p);
  const list = files.slice(0, 15).map(q).join(' ');
  switch (framework) {
    case 'jest': return `npx jest ${list}`;
    case 'vitest': return `npx vitest run ${list}`;
    case 'mocha': return `npx mocha ${list}`;
    case 'playwright': return `npx playwright test ${list}`;
    case 'pytest': return `python -m pytest ${list}`;
    case 'go': {
      const dirs = [...new Set(files.map((f) => { const d = path.posix.dirname(f); return './' + (d === '.' ? '' : d + '/') + '...'; }))];
      return 'go test ' + dirs.join(' ');
    }
    default: return '';
  }
}

module.exports = { run, symbolsFor };
