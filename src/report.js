'use strict';
const U = require('./util');
const e = U.escapeHtml;

const ICON = { blocking: '✖', warning: '▲', suggestion: '●' };

function findingHtml(f) {
  const where = f.file ? `<a href="#" class="loc" data-file="${e(f.file)}" data-line="${f.line || 0}">${e(f.file)}${f.line ? ':' + f.line : ''}</a>` : '';
  const occ = f.occurrences && f.occurrences.length > 1
    ? `<div class="occ">Lines: ${f.occurrences.slice(0, 25).map((l) => `<a href="#" class="loc" data-file="${e(f.file)}" data-line="${l}">${l}</a>`).join(' ')}${f.occurrences.length > 25 ? ' …' : ''}</div>` : '';
  return `<details class="f ${f.severity}" data-cat="${e(f.category)}">
  <summary><span class="ic">${ICON[f.severity]}</span><span class="t">${e(f.title)}</span><span class="rule">${e(f.ruleId)}</span></summary>
  <div class="body">
    <div>${where} <span class="cat">${e(f.category)}</span></div>
    ${f.detail ? `<div class="detail">${e(f.detail)}</div>` : ''}
    ${f.snippet ? `<pre>${e(f.snippet)}</pre>` : ''}
    ${occ}
    ${f.why ? `<p><b>Why it matters.</b> ${e(f.why)}</p>` : ''}
    ${f.fix ? `<p><b>What to do.</b> ${e(f.fix)}</p>` : ''}
  </div></details>`;
}

function build(a, nonce, cspSource, checks, running) {
  const s = a.stats; const b = s.bySeverity;
  const riskCls = a.risk.score >= 70 ? 'crit' : a.risk.score >= 45 ? 'high' : a.risk.score >= 20 ? 'med' : 'low';
  const findings = a.findings.map(findingHtml).join('') || '<p class="ok">✔ Nothing to report. Still skim the diff yourself — static analysis cannot judge intent.</p>';

  const impactRows = a.impact.files.filter((f) => f.symbols.length || f.dependents.length).map((f) => {
    const syms = f.symbols.map((x) => {
      const refs = x.refs.slice(0, 6).map((r) => `<a href="#" class="loc" data-file="${e(r.path)}" data-line="0">${e(r.path)}</a>`).join(', ');
      return `<li><code>${e(x.name)}</code>${x.exported ? ' <span class="pill">exported</span>' : ''} — ${x.generic ? '<i>name too generic to trace</i>' : x.refTotal ? `${x.refTotal} file(s): ${refs}${x.refTotal > 6 ? ' …' : ''}` : '<i>no other references</i>'}${x.tests.length ? ` <span class="pill ok">tests: ${x.tests.length}</span>` : ''}</li>`;
    }).join('');
    const deps = f.dependents.length ? `<div class="deps">Imported by: ${f.dependents.slice(0, 8).map((d) => `<a href="#" class="loc" data-file="${e(d)}" data-line="0">${e(d)}</a>`).join(', ')}${f.dependents.length > 8 ? ' …' : ''}</div>` : '';
    return `<div class="imp"><div class="ifile"><a href="#" class="loc" data-file="${e(f.path)}" data-line="0">${e(f.path)}</a> <span class="pill">${e(f.status)}</span> <span class="dim">+${f.additions}/−${f.deletions}</span></div><ul>${syms}</ul>${deps}</div>`;
  }).join('') || '<p class="dim">No cross-file references detected.</p>';

  const routes = (list, cls, label) => list.map((r) => `<li class="${cls}"><b>${label}</b> <code>${e(r.method)} ${e(r.path)}</code> <a href="#" class="loc" data-file="${e(r.file)}" data-line="${r.line || 0}">${e(r.file)}:${r.line || ''}</a></li>`).join('');
  const routeHtml = routes(a.impact.routes.added, 'add', 'new') + routes(a.impact.routes.removed, 'rem', 'removed') + routes(a.impact.routes.affected.slice(0, 20), 'aff', 'uses changed code');

  const sugg = a.tests.suggestions.map((t, i) => `<details><summary>Suggested tests for <code>${e(t.file)}</code>${t.branches ? ` — ${t.branches} new branch point(s)` : ''}</summary><pre id="stub${i}">${e(t.stub)}</pre><button data-copy="stub${i}">Copy</button></details>`).join('');
  const noTests = a.tests.filesWithoutTests.map((t) => `<li><code>${e(t.file)}</code> — ${t.reason === 'stale' ? 'tests exist but were not updated' : 'no tests found'}</li>`).join('');

  const rev = a.reversibility;
  const checkHtml = (checks || []).map((c) => `<details class="chk ${c.code === 0 ? 'pass' : 'fail'}"><summary>${c.code === 0 ? '✔' : '✖'} <code>${e(c.cmd)}</code> <span class="dim">${Math.round(c.durationMs / 100) / 10}s${c.timedOut ? ' · timed out' : ''}</span></summary><pre>${e(c.tail)}</pre></details>`).join('');

  const catSet = [...new Set(a.findings.map((f) => f.category))].sort();

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
:root{--ok:var(--vscode-testing-iconPassed,#3fb950);--bad:var(--vscode-errorForeground,#f85149);--warn:var(--vscode-editorWarning-foreground,#d29922);--info:var(--vscode-editorInfo-foreground,#4aa3ff);--dim:var(--vscode-descriptionForeground);--bd:var(--vscode-panel-border,#8884);--bg2:var(--vscode-editorWidget-background,#8881)}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:0 20px 40px;max-width:1100px;margin:auto;line-height:1.5}
h1{font-size:1.5em;margin:18px 0 4px}h2{font-size:1.15em;margin:28px 0 8px;border-bottom:1px solid var(--bd);padding-bottom:4px}
.dim{color:var(--dim)}.sub{color:var(--dim);margin-bottom:14px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.card{flex:1;min-width:120px;border:1px solid var(--bd);background:var(--bg2);border-radius:8px;padding:10px 14px}
.card .n{font-size:1.9em;font-weight:700;line-height:1.1}.card .l{color:var(--dim);font-size:.85em}
.risk.low .n{color:var(--ok)}.risk.med .n{color:var(--warn)}.risk.high .n,.risk.crit .n{color:var(--bad)}
.bar{height:6px;background:var(--bd);border-radius:3px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:currentColor}
.risk.low{color:var(--ok)}.risk.med{color:var(--warn)}.risk.high,.risk.crit{color:var(--bad)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:5px 12px;cursor:pointer;font-family:inherit}button:hover{background:var(--vscode-button-hoverBackground)}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button[disabled]{opacity:.5;cursor:default}
a{color:var(--vscode-textLink-foreground);text-decoration:none}a:hover{text-decoration:underline}
details.f{border:1px solid var(--bd);border-left-width:4px;border-radius:6px;margin:6px 0;background:var(--bg2)}
details.f.blocking{border-left-color:var(--bad)}details.f.warning{border-left-color:var(--warn)}details.f.suggestion{border-left-color:var(--info)}
summary{cursor:pointer;padding:8px 10px;display:flex;gap:8px;align-items:center;list-style-position:inside}
.f .ic{font-weight:700}.f.blocking .ic{color:var(--bad)}.f.warning .ic{color:var(--warn)}.f.suggestion .ic{color:var(--info)}
.f .t{flex:1}.rule{font-family:var(--vscode-editor-font-family);font-size:.78em;color:var(--dim)}
.body{padding:2px 14px 12px}.cat{font-size:.78em;border:1px solid var(--bd);border-radius:10px;padding:0 7px;color:var(--dim)}
pre{background:var(--vscode-textCodeBlock-background);padding:8px 10px;border-radius:4px;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:.9em;white-space:pre-wrap}
code{font-family:var(--vscode-editor-font-family)}.detail{color:var(--warn);margin:4px 0}.occ{margin:4px 0;color:var(--dim)}
.pill{font-size:.75em;border:1px solid var(--bd);border-radius:10px;padding:0 7px;color:var(--dim)}.pill.ok{color:var(--ok);border-color:var(--ok)}
.imp{border:1px solid var(--bd);border-radius:6px;padding:8px 12px;margin:8px 0}.imp ul{margin:6px 0 2px 18px;padding:0}.deps{margin-top:4px;color:var(--dim)}
ul.routes{list-style:none;padding:0}ul.routes li{padding:3px 0}.add b{color:var(--ok)}.rem b{color:var(--bad)}.aff b{color:var(--info)}
.rev{padding:10px 14px;border-radius:6px;border:1px solid var(--bd);background:var(--bg2)}.rev.easy{border-left:4px solid var(--ok)}.rev.careful{border-left:4px solid var(--warn)}.rev.hard{border-left:4px solid var(--bad)}
.chip{cursor:pointer;border:1px solid var(--bd);border-radius:12px;padding:1px 10px;margin-right:6px;font-size:.85em;background:transparent;color:var(--vscode-foreground)}.chip.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.chk.pass summary{color:var(--ok)}.chk.fail summary{color:var(--bad)}.ok{color:var(--ok)}
footer{margin-top:30px;color:var(--dim);font-size:.85em}
</style></head><body>
<h1>ShipCheck review</h1>
<div class="sub">${e(a.meta.repo)} · <b>${e(a.meta.branch || 'detached HEAD')}</b> vs <b>${e(a.meta.baseName)}</b> (${e(a.meta.scope)}) · ${new Date(a.meta.generatedAt).toLocaleString()} · ${a.meta.durationMs} ms</div>
<div class="toolbar">
 <button data-cmd="refresh">↻ Re-run review</button>
 <button data-cmd="pr">Generate PR description</button>
 <button data-cmd="checks" ${running ? 'disabled' : ''}>${running ? 'Running checks…' : 'Run project checks'}</button>
 <button class="sec" data-cmd="markdown">Export as Markdown</button>
 <button class="sec" data-cmd="ai">AI second opinion</button>
</div>
<div class="cards">
 <div class="card risk ${riskCls}"><div class="n">${a.risk.score}<span style="font-size:.4em">/100</span></div><div class="l">Risk · ${e(a.risk.label)}</div><div class="bar"><i style="width:${a.risk.score}%"></i></div></div>
 <div class="card"><div class="n" style="color:var(--bad)">${b.blocking}</div><div class="l">Blocking</div></div>
 <div class="card"><div class="n" style="color:var(--warn)">${b.warning}</div><div class="l">Warnings</div></div>
 <div class="card"><div class="n" style="color:var(--info)">${b.suggestion}</div><div class="l">Suggestions</div></div>
 <div class="card"><div class="n">${s.files}</div><div class="l">Files · +${s.additions}/−${s.deletions}</div></div>
</div>
${a.meta.warnings.length ? `<p class="detail">⚠ ${a.meta.warnings.map(e).join('<br>')}</p>` : ''}
${a.impact.truncated ? '<p class="detail">⚠ Impact search stopped early (time/size budget). Results may be incomplete.</p>' : ''}

<h2>Findings</h2>
<div style="margin:6px 0"><button class="chip on" data-filter="all">all</button>${catSet.map((c) => `<button class="chip" data-filter="${e(c)}">${e(c)}</button>`).join('')}</div>
<div id="findings">${findings}</div>

<h2>Impact map</h2>
${impactRows}
${routeHtml ? `<h3>Endpoints</h3><ul class="routes">${routeHtml}</ul>` : ''}
${a.impact.testsToRun.length ? `<h3>Tests worth running</h3><pre id="runhint">${e(a.tests.runHint || a.impact.testsToRun.join('\n'))}</pre><button class="sec" data-copy="runhint">Copy</button>` : ''}

<h2>Tests</h2>
<p class="dim">Framework: ${e(a.tests.framework || 'not detected')} · test files in this change: ${a.tests.inDiff.length}</p>
${noTests ? `<ul>${noTests}</ul>` : '<p class="ok">✔ Every changed source file of meaningful size has a related test.</p>'}
${sugg}

<h2>Reversibility</h2>
<div class="rev ${rev.verdict}"><b>${e(rev.label)}</b><ul>${rev.reasons.map((r) => `<li>${e(r.text)}</li>`).join('')}</ul><b>Rollback plan</b><ul>${rev.plan.map((p) => `<li>${e(p)}</li>`).join('')}</ul></div>

<h2>Project checks</h2>
${checkHtml || '<p class="dim">Not run yet. “Run project checks” executes your lint / type-check / test commands (auto-detected or from <code>shipcheck.checkCommands</code>).</p>'}

<footer>ShipCheck ${e(a.version)} performs <b>static, heuristic</b> analysis of the diff. It finds real, common problems quickly, but it does not replace running your tests or a human review. Silence a line with a <code>shipcheck-ignore</code> comment.</footer>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-file],[data-cmd],[data-copy],[data-filter]');
  if (!t) return;
  if (t.dataset.file) { ev.preventDefault(); vscode.postMessage({ type: 'open', file: t.dataset.file, line: +t.dataset.line || 0 }); }
  else if (t.dataset.cmd) vscode.postMessage({ type: t.dataset.cmd });
  else if (t.dataset.copy) vscode.postMessage({ type: 'copy', text: document.getElementById(t.dataset.copy).innerText });
  else if (t.dataset.filter) {
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === t));
    document.querySelectorAll('#findings details.f').forEach((d) => { d.style.display = (t.dataset.filter === 'all' || d.dataset.cat === t.dataset.filter) ? '' : 'none'; });
  }
});
</script></body></html>`;
}

module.exports = { build };
