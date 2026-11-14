'use strict';
const U = require('./util');

const SEV_ICON = { blocking: '🛑', warning: '⚠️', suggestion: '💡' };
const KIND_LABEL = { source: 'Source', test: 'Tests', db: 'Database', ci: 'CI / infrastructure', deps: 'Dependencies', config: 'Configuration', doc: 'Documentation', other: 'Other' };
const KIND_ORDER = ['source', 'db', 'deps', 'ci', 'config', 'test', 'doc', 'other'];

function title(a) {
  const subjects = a.commits.map((c) => c.subject);
  if (subjects.length === 1) return subjects[0];
  const fromBranch = U.humanizeBranch(a.meta.branch);
  if (fromBranch) return fromBranch;
  return subjects[subjects.length - 1] || 'Describe this change';
}

function groupFiles(a) {
  const groups = {};
  for (const f of a.files) { (groups[f.kind] = groups[f.kind] || []).push(f); }
  return KIND_ORDER.filter((k) => groups[k]).map((k) => ({ kind: k, label: KIND_LABEL[k], files: groups[k] }));
}

function loc(f) { return f.file ? '`' + f.file + (f.line ? ':' + f.line : '') + '`' : ''; }

function buildPR(a, checks) {
  const s = a.stats;
  const L = [];
  L.push(`# ${title(a)}`, '');
  L.push('## Summary', '');
  const areas = groupFiles(a).map((g) => `${g.label.toLowerCase()} (${g.files.length})`).join(', ');
  L.push(`<!-- Why is this change needed? Link the ticket / issue. -->`);
  L.push(`This PR changes **${s.files} file${s.files === 1 ? '' : 's'}** (+${s.additions} / −${s.deletions}) across ${areas || 'no tracked areas'}.`);
  if (a.commits.length) {
    L.push('', '**Commits**');
    a.commits.slice(0, 15).forEach((c) => L.push(`- ${c.subject} (\`${c.hash}\`)`));
    if (a.commits.length > 15) L.push(`- … and ${a.commits.length - 15} more`);
  }
  L.push('', '## Changes', '');
  for (const g of groupFiles(a)) {
    L.push(`**${g.label}**`);
    g.files.slice(0, 25).forEach((f) => {
      const sym = f.symbols && f.symbols.length ? ` — ${f.symbols.slice(0, 4).map((x) => '`' + x + '`').join(', ')}` : '';
      L.push(`- \`${f.path}\` (${f.status}, +${f.additions}/−${f.deletions})${sym}`);
    });
    if (g.files.length > 25) L.push(`- … and ${g.files.length - 25} more`);
    L.push('');
  }

  const imp = a.impact;
  L.push('## Impact', '');
  const routeLines = [];
  imp.routes.added.forEach((r) => routeLines.push(`- ➕ \`${r.method} ${r.path}\` (new, ${r.file}:${r.line})`));
  imp.routes.removed.forEach((r) => routeLines.push(`- ➖ \`${r.method} ${r.path}\` (removed/changed, ${r.file}:${r.line})`));
  imp.routes.affected.slice(0, 8).forEach((r) => routeLines.push(`- 🔁 \`${r.method} ${r.path}\` uses changed code (${r.file}:${r.line})`));
  if (routeLines.length) L.push('**Endpoints**', ...routeLines, '');
  const dep = imp.files.filter((f) => f.dependents.length || f.symbols.some((x) => x.refTotal));
  if (dep.length) {
    L.push('**Code that depends on the change**');
    dep.slice(0, 8).forEach((f) => {
      const refs = new Set(); f.symbols.forEach((x) => x.refs.forEach((r) => refs.add(r.path))); f.dependents.forEach((d) => refs.add(d));
      L.push(`- \`${f.path}\` → ${refs.size} referencing file${refs.size === 1 ? '' : 's'}`);
    });
    L.push('');
  }
  if (!routeLines.length && !dep.length) L.push('No dependants or endpoints detected by static analysis.', '');
  if (a.depChanges.length) {
    L.push('**Dependencies**');
    a.depChanges.filter((d) => d.kind !== 'manifest').slice(0, 10).forEach((d) => L.push(`- ${d.kind}: \`${d.name}\` ${d.from ? d.from + ' → ' : ''}${d.to || ''}`));
    L.push('');
  }

  L.push('## Risks', '');
  L.push(`Automated risk score: **${a.risk.score}/100 (${a.risk.label})** — ${s.bySeverity.blocking} blocking, ${s.bySeverity.warning} warnings, ${s.bySeverity.suggestion} suggestions.`, '');
  const top = a.findings.filter((f) => f.severity !== 'suggestion').slice(0, 10);
  if (top.length) top.forEach((f) => L.push(`- ${SEV_ICON[f.severity]} ${f.title} ${loc(f)}`));
  else L.push('- No blocking issues or warnings found by ShipCheck.');
  if (a.findings.filter((f) => f.severity !== 'suggestion').length > 10) L.push('- … see the full ShipCheck report for the rest.');
  L.push('');

  L.push('## Testing', '');
  if (checks && checks.length) {
    checks.forEach((c) => L.push(`- [${c.code === 0 ? 'x' : ' '}] \`${c.cmd}\` — ${c.code === 0 ? 'passed' : c.timedOut ? 'timed out' : 'FAILED (exit ' + c.code + ')'}`));
  }
  if (a.tests.runHint) L.push(`- [ ] Affected tests: \`${a.tests.runHint}\``);
  if (a.tests.filesWithoutTests.length) a.tests.filesWithoutTests.slice(0, 6).forEach((t) => L.push(`- [ ] Add tests for \`${t.file}\``));
  imp.routes.added.slice(0, 5).forEach((r) => L.push(`- [ ] Manually call \`${r.method} ${r.path}\`: success, validation error, unauthenticated`));
  imp.routes.removed.slice(0, 5).forEach((r) => L.push(`- [ ] Confirm no client still calls \`${r.method} ${r.path}\``));
  if (a.migrations.length) L.push('- [ ] Run the migration on a copy of production-like data and verify the rollback');
  if (a.depChanges.some((d) => d.kind !== 'manifest')) L.push('- [ ] Fresh install from the lockfile and run the build');
  if (a.stats.byKind.ci) L.push('- [ ] Run the changed pipeline on this branch');
  if (!L[L.length - 1].startsWith('- [')) L.push('- [ ] Run the full test suite');
  L.push('');

  L.push('## Rollback', '', `**${a.reversibility.label}.**`);
  a.reversibility.reasons.filter((r) => r.level !== 'info').forEach((r) => L.push(`- ${r.text}`));
  a.reversibility.plan.forEach((p) => L.push(`- ${p}`));
  L.push('', '## Checklist', '');
  L.push('- [ ] Tests added/updated', '- [ ] Docs / changelog updated', '- [ ] No secrets or debug code', '- [ ] Reviewed the ShipCheck report');
  L.push('', `<sub>Generated by ShipCheck ${a.version} · base \`${a.meta.baseName}\` @ ${a.meta.mergeBase} · static analysis — review before merging.</sub>`);
  return L.join('\n');
}

function buildReviewMarkdown(a, checks) {
  const s = a.stats;
  const L = [];
  L.push(`# ShipCheck review — ${a.meta.repo} (${a.meta.branch || 'detached'} vs ${a.meta.baseName})`, '');
  L.push(`**Risk ${a.risk.score}/100 (${a.risk.label})** · ${s.files} files · +${s.additions}/−${s.deletions} · 🛑 ${s.bySeverity.blocking} · ⚠️ ${s.bySeverity.warning} · 💡 ${s.bySeverity.suggestion} · ${a.reversibility.label}`, '');
  for (const sev of ['blocking', 'warning', 'suggestion']) {
    const list = a.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(`## ${SEV_ICON[sev]} ${sev[0].toUpperCase() + sev.slice(1)} (${list.length})`, '');
    for (const f of list) {
      L.push(`### ${f.title}`, `${loc(f)}  ·  \`${f.ruleId}\`  ·  ${f.category}`, '');
      if (f.detail) L.push(`> ${f.detail}`, '');
      if (f.snippet) L.push('```', f.snippet, '```');
      if (f.why) L.push(`**Why:** ${f.why}`);
      if (f.fix) L.push(`**Fix:** ${f.fix}`);
      if (f.occurrences && f.occurrences.length > 1) L.push(`**Lines:** ${f.occurrences.slice(0, 30).join(', ')}`);
      L.push('');
    }
  }
  L.push('## Impact map', '');
  for (const f of a.impact.files.filter((x) => x.symbols.length || x.dependents.length)) {
    L.push(`- \`${f.path}\``);
    f.symbols.slice(0, 6).forEach((x) => L.push(`  - \`${x.name}\`${x.exported ? ' (exported)' : ''}: ${x.generic ? 'name too generic to trace' : x.refTotal + ' referencing file(s)'}${x.tests.length ? ', tests: ' + x.tests.slice(0, 3).join(', ') : ''}`));
    if (f.dependents.length) L.push(`  - imported by: ${f.dependents.slice(0, 6).map((d) => '`' + d + '`').join(', ')}`);
  }
  L.push('', '## Tests', '');
  L.push(`Framework: ${a.tests.framework || 'not detected'}`);
  if (a.tests.runHint) L.push('', 'Run:', '```', a.tests.runHint, '```');
  a.tests.suggestions.forEach((t) => { L.push('', `### Suggested tests for \`${t.file}\``, '```', t.stub, '```'); });
  if (checks && checks.length) {
    L.push('', '## Project checks', '');
    checks.forEach((c) => L.push(`- ${c.code === 0 ? '✅' : '❌'} \`${c.cmd}\` (${Math.round(c.durationMs / 100) / 10}s)`));
  }
  L.push('', '## Reversibility', '', `**${a.reversibility.label}**`, ...a.reversibility.reasons.map((r) => `- ${r.text}`), ...a.reversibility.plan.map((p) => `- ${p}`));
  return L.join('\n');
}

function formatText(a, opts) {
  opts = opts || {};
  const c = opts.color ? { r: '\x1b[31m', y: '\x1b[33m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m', c: '\x1b[36m' } : { r: '', y: '', g: '', d: '', b: '', x: '', c: '' };
  const s = a.stats;
  const L = [];
  L.push(`${c.b}ShipCheck${c.x} ${c.d}${a.meta.repo} · ${a.meta.branch || 'HEAD'} vs ${a.meta.baseName} (${a.meta.scope})${c.x}`);
  const col = a.risk.score >= 45 ? c.r : a.risk.score >= 20 ? c.y : c.g;
  L.push(`${s.files} files  +${s.additions}/−${s.deletions}   Risk ${col}${a.risk.score}/100 ${a.risk.label}${c.x}   ${a.reversibility.label}`);
  L.push(`${c.r}${s.bySeverity.blocking} blocking${c.x}  ${c.y}${s.bySeverity.warning} warning${c.x}  ${s.bySeverity.suggestion} suggestion`);
  L.push('');
  const max = opts.max || 40;
  let shown = 0;
  for (const f of a.findings) {
    if (f.severity === 'suggestion' && !opts.all) continue;
    if (shown++ >= max) { L.push(`${c.d}… ${a.findings.length - max} more (run with --all or open the report)${c.x}`); break; }
    const tag = f.severity === 'blocking' ? `${c.r}BLOCKING${c.x}` : `${c.y}WARNING ${c.x}`;
    L.push(`${tag} ${f.title}`);
    L.push(`         ${c.c}${f.file || ''}${f.line ? ':' + f.line : ''}${c.x} ${c.d}[${f.ruleId}]${c.x}`);
    if (f.detail) L.push(`         ${f.detail}`);
    if (f.why) L.push(`         ${c.d}why: ${f.why}${c.x}`);
    if (f.fix) L.push(`         ${c.d}fix: ${f.fix}${c.x}`);
  }
  if (!shown) L.push(`${c.g}No blocking issues or warnings.${c.x}`);
  if (a.tests.runHint) L.push('', `${c.d}Tests to run:${c.x} ${a.tests.runHint}`);
  L.push('', `${c.d}Bypass once: git push --no-verify  |  suppress a line: add "shipcheck-ignore" in a comment${c.x}`);
  return L.join('\n');
}

module.exports = { buildPR, buildReviewMarkdown, formatText, SEV_ICON, KIND_LABEL };
