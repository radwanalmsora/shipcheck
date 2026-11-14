'use strict';
const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const crypto = require('crypto');

const core = require('./src/core');
const G = require('./src/git');
const pr = require('./src/pr');
const reportView = require('./src/report');
const checksLib = require('./src/checks');
const hook = require('./src/hook');
const ai = require('./src/ai');

const SETTING_KEYS = ['baseBranch', 'includeUncommitted', 'includeUntracked', 'ignorePaths', 'disabledRules', 'severityOverrides', 'maxLineLength', 'maxFileSizeKB', 'minAddedLinesForTestCheck', 'customRules'];

const state = {
  analysis: null, root: null, scope: 'branch', busy: false, checks: [], runningChecks: false,
  panel: null, ctx: null, saveTimer: null, output: null, status: null, diag: null, tree: null
};

// ------------------------------------------------------------------ helpers
function settings(root) {
  const c = vscode.workspace.getConfiguration('shipcheck', root ? vscode.Uri.file(root) : undefined);
  const o = {};
  for (const k of SETTING_KEYS) o[k] = c.get(k);
  return o;
}
const cfgGet = (k, root) => vscode.workspace.getConfiguration('shipcheck', root ? vscode.Uri.file(root) : undefined).get(k);

async function pickRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  let start = null;
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === 'file') {
    const wf = vscode.workspace.getWorkspaceFolder(ed.document.uri);
    start = wf ? wf.uri.fsPath : path.dirname(ed.document.uri.fsPath);
    const r = G.repoRoot(start);
    if (r) return r;
  }
  if (state.root && folders.length > 1) return state.root;
  if (folders.length === 1) start = folders[0].uri.fsPath;
  else if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath })), { placeHolder: 'Which folder do you want to review?' });
    if (!pick) return null;
    start = pick.description;
  }
  if (!start) { vscode.window.showWarningMessage('ShipCheck: open a folder that contains a git repository first.'); return null; }
  const root = G.repoRoot(start);
  if (!root) { vscode.window.showWarningMessage('ShipCheck: this folder is not inside a git repository.'); return null; }
  return root;
}

function runAnalysisProcess(root, scope) {
  return new Promise((resolve, reject) => {
    const cli = path.join(state.ctx.extensionPath, 'bin', 'cli.js');
    let child;
    const fallback = () => {
      try { resolve(core.analyze(root, core.mergeConfig(settings(root), core.loadRc(root)), { scope })); } catch (e) { reject(e); }
    };
    try {
      child = cp.spawn(process.execPath, [cli, '--json', '--config-stdin', '--fail-on', 'none', '--scope', scope, '--cwd', root], {
        cwd: root, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true
      });
    } catch (e) { return fallback(); }
    let out = ''; let err = ''; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch (e) { /* gone */ } reject(new Error('Review timed out after 3 minutes.')); } }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); fallback(); } });
    child.on('close', () => {
      if (done) return;
      done = true; clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed);
      } catch (e) { reject(new Error(err.trim() || 'ShipCheck could not read the analysis result.')); }
    });
    try { child.stdin.write(JSON.stringify(settings(root))); child.stdin.end(); } catch (e) { /* handled by close */ }
  });
}

// ------------------------------------------------------------------ main flow
async function review(scope, opts) {
  opts = opts || {};
  if (state.busy) return state.analysis;
  const root = opts.root || await pickRoot();
  if (!root) return null;
  state.busy = true; state.root = root; state.scope = scope || 'branch';
  setStatus();
  try {
    const run = () => runAnalysisProcess(root, state.scope);
    const a = opts.silent ? await run() : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ShipCheck: reviewing your changes…' }, run);
    state.analysis = a; state.checks = [];
    apply();
    if (!opts.silent) announce(a);
    return a;
  } catch (e) {
    if (!opts.silent) vscode.window.showErrorMessage('ShipCheck: ' + e.message);
    return null;
  } finally {
    state.busy = false; setStatus();
  }
}

function announce(a) {
  const b = a.stats.bySeverity;
  if (!a.stats.files) {
    vscode.window.showInformationMessage(`ShipCheck: no changes found between ${a.meta.branch || 'HEAD'} and ${a.meta.baseName}. If you expected changes, check "shipcheck.baseBranch".`);
    return;
  }
  const msg = `ShipCheck: risk ${a.risk.score}/100 (${a.risk.label}) — ${b.blocking} blocking, ${b.warning} warnings, ${b.suggestion} suggestions.`;
  const show = b.blocking ? vscode.window.showErrorMessage : b.warning ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  show(msg, 'Open report', 'PR description').then((p) => {
    if (p === 'Open report') vscode.commands.executeCommand('shipcheck.showReport');
    if (p === 'PR description') vscode.commands.executeCommand('shipcheck.generatePR');
  });
}

async function ensureAnalysis() {
  if (state.analysis) return state.analysis;
  return review(state.scope);
}

function apply() {
  const a = state.analysis;
  vscode.commands.executeCommand('setContext', 'shipcheck.hasResults', !!a);
  updateDiagnostics();
  state.tree.refresh();
  setStatus();
  renderPanel();
}

function updateDiagnostics() {
  state.diag.clear();
  const a = state.analysis;
  if (!a) return;
  const map = new Map();
  for (const f of a.findings) {
    if (!f.file) continue;
    if (f.severity === 'suggestion' && !f.line) continue;
    const uri = vscode.Uri.file(path.join(a.meta.root, f.file));
    const line = Math.max(0, (f.line || 1) - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000),
      f.title + (f.detail ? ` — ${f.detail}` : '') + (f.why ? `\nWhy: ${f.why}` : '') + (f.fix ? `\nFix: ${f.fix}` : ''),
      f.severity === 'blocking' ? vscode.DiagnosticSeverity.Error : f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
    d.source = 'ShipCheck'; d.code = f.ruleId;
    const k = uri.toString();
    if (!map.has(k)) map.set(k, { uri, list: [] });
    map.get(k).list.push(d);
  }
  for (const { uri, list } of map.values()) state.diag.set(uri, list);
}

function setStatus() {
  const s = state.status; const a = state.analysis;
  s.command = a ? 'shipcheck.showReport' : 'shipcheck.review';
  s.backgroundColor = undefined;
  if (state.busy) { s.text = '$(sync~spin) ShipCheck'; s.tooltip = 'Reviewing…'; }
  else if (!a) { s.text = '$(shield) ShipCheck'; s.tooltip = 'Review your changes before opening a PR'; }
  else {
    const b = a.stats.bySeverity;
    s.text = `$(shield) ${a.risk.score}  $(error) ${b.blocking}  $(warning) ${b.warning}`;
    s.tooltip = new vscode.MarkdownString(`**ShipCheck** — ${a.meta.branch || 'HEAD'} vs ${a.meta.baseName}\n\nRisk **${a.risk.score}/100 (${a.risk.label})** · ${a.reversibility.label}\n\n${b.blocking} blocking · ${b.warning} warnings · ${b.suggestion} suggestions\n\n_Click to open the report_`);
    if (b.blocking) s.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    else if (b.warning) s.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  s.show();
}

// ------------------------------------------------------------------ tree view
function node(label, o) {
  o = o || {};
  const t = new vscode.TreeItem(label, o.kids && o.kids.length ? (o.open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
  if (o.desc !== undefined) t.description = o.desc;
  if (o.icon) t.iconPath = new vscode.ThemeIcon(o.icon, o.color ? new vscode.ThemeColor(o.color) : undefined);
  if (o.tip) t.tooltip = o.tip;
  if (o.command) t.command = o.command;
  t.kids = o.kids || [];
  return t;
}
const openCmd = (file, line) => ({ command: 'shipcheck.openPath', title: 'Open', arguments: [file, line || 0] });

class TreeProvider {
  constructor() { this._e = new vscode.EventEmitter(); this.onDidChangeTreeData = this._e.event; }
  refresh() { this._e.fire(); }
  getTreeItem(el) { return el; }
  getChildren(el) {
    if (el) return el.kids;
    const a = state.analysis;
    if (!a) return [];
    return buildTree(a);
  }
}

function findingNode(f) {
  const tip = new vscode.MarkdownString(`**${f.title}**\n\n\`${f.ruleId}\` · ${f.category}\n\n${f.detail ? '_' + f.detail + '_\n\n' : ''}${f.why ? '**Why:** ' + f.why + '\n\n' : ''}${f.fix ? '**Fix:** ' + f.fix : ''}`);
  return node(f.title, {
    desc: f.file ? `${path.posix.basename(f.file)}${f.line ? ':' + f.line : ''}` : '',
    icon: f.severity === 'blocking' ? 'error' : f.severity === 'warning' ? 'warning' : 'lightbulb',
    color: f.severity === 'blocking' ? 'errorForeground' : f.severity === 'warning' ? 'editorWarning.foreground' : 'editorInfo.foreground',
    tip, command: f.file ? openCmd(f.file, f.line) : undefined
  });
}

function buildTree(a) {
  const items = [];
  const b = a.stats.bySeverity;
  items.push(node(`Risk ${a.risk.score}/100 · ${a.risk.label}`, {
    desc: `${a.stats.files} files +${a.stats.additions}/−${a.stats.deletions}`, icon: 'shield',
    color: a.risk.score >= 45 ? 'errorForeground' : a.risk.score >= 20 ? 'editorWarning.foreground' : 'testing.iconPassed',
    tip: `${a.meta.branch || 'HEAD'} vs ${a.meta.baseName} (${a.meta.scope})`, command: { command: 'shipcheck.showReport', title: 'Open report' }
  }));
  for (const [sev, label] of [['blocking', 'Blocking'], ['warning', 'Warnings'], ['suggestion', 'Suggestions']]) {
    const list = a.findings.filter((f) => f.severity === sev);
    const kids = list.slice(0, 300).map(findingNode);
    if (list.length > 300) kids.push(node(`… ${list.length - 300} more (see report)`, { icon: 'ellipsis' }));
    items.push(node(`${label} (${list.length})`, {
      icon: sev === 'blocking' ? 'error' : sev === 'warning' ? 'warning' : 'lightbulb',
      color: list.length ? (sev === 'blocking' ? 'errorForeground' : sev === 'warning' ? 'editorWarning.foreground' : 'editorInfo.foreground') : 'testing.iconPassed',
      kids, open: sev !== 'suggestion' && list.length > 0
    }));
  }
  // impact
  const impKids = [];
  const r = a.impact.routes;
  const routeKids = [
    ...r.added.map((x) => node(`${x.method} ${x.path}`, { desc: 'new', icon: 'add', color: 'testing.iconPassed', command: openCmd(x.file, x.line) })),
    ...r.removed.map((x) => node(`${x.method} ${x.path}`, { desc: 'removed/changed', icon: 'remove', color: 'errorForeground', command: openCmd(x.file, x.line) })),
    ...r.affected.slice(0, 25).map((x) => node(`${x.method} ${x.path}`, { desc: 'uses changed code', icon: 'link', command: openCmd(x.file, x.line) }))
  ];
  if (routeKids.length) impKids.push(node(`Endpoints (${routeKids.length})`, { icon: 'globe', kids: routeKids }));
  for (const f of a.impact.files.filter((x) => x.symbols.length || x.dependents.length)) {
    const kids = f.symbols.map((s) => node(s.name, {
      desc: s.generic ? 'too generic to trace' : `${s.refTotal} file(s)${s.tests.length ? ` · ${s.tests.length} test(s)` : ''}`,
      icon: s.exported ? 'symbol-method' : 'symbol-field',
      kids: s.refs.map((x) => node(x.path, { desc: `×${x.count}`, icon: 'file', command: openCmd(x.path, 0) }))
    }));
    if (f.dependents.length) kids.push(node(`Imported by (${f.dependents.length})`, { icon: 'references', kids: f.dependents.map((d) => node(d, { icon: 'file', command: openCmd(d, 0) })) }));
    impKids.push(node(path.posix.basename(f.path), { desc: f.path, icon: 'file-code', kids, command: openCmd(f.path, 0) }));
  }
  items.push(node('Impact map', { icon: 'type-hierarchy', kids: impKids.length ? impKids : [node('No cross-file references found', { icon: 'check' })] }));
  // tests
  const tk = [];
  tk.push(node(`Framework: ${a.tests.framework || 'not detected'}`, { icon: 'beaker' }));
  a.tests.filesWithoutTests.forEach((t) => tk.push(node(path.posix.basename(t.file), { desc: t.reason === 'stale' ? 'tests not updated' : 'no tests', icon: 'circle-slash', color: 'editorWarning.foreground', command: openCmd(t.file, 0) })));
  a.tests.suggestions.forEach((t) => tk.push(node(`Suggested tests: ${path.posix.basename(t.file)}`, { desc: t.symbols.join(', '), icon: 'sparkle', command: { command: 'shipcheck.showTestStub', title: 'Show', arguments: [t] } })));
  if (a.tests.runHint) tk.push(node('Copy command to run affected tests', { desc: a.tests.runHint.slice(0, 50), icon: 'copy', command: { command: 'shipcheck.copyText', title: 'Copy', arguments: [a.tests.runHint] } }));
  items.push(node('Tests', { icon: 'beaker', kids: tk }));
  // reversibility
  const rv = a.reversibility;
  items.push(node(rv.label, {
    icon: 'history', color: rv.verdict === 'hard' ? 'errorForeground' : rv.verdict === 'careful' ? 'editorWarning.foreground' : 'testing.iconPassed',
    kids: [...rv.reasons.map((x) => node(x.text, { icon: x.level === 'danger' ? 'error' : x.level === 'warn' ? 'warning' : x.level === 'good' ? 'pass' : 'info' })), ...rv.plan.map((p) => node(p, { icon: 'arrow-right' }))]
  }));
  if (state.checks.length) {
    items.push(node('Project checks', { icon: 'play', kids: state.checks.map((c) => node(c.cmd, { desc: c.code === 0 ? 'passed' : 'FAILED', icon: c.code === 0 ? 'pass' : 'error', color: c.code === 0 ? 'testing.iconPassed' : 'errorForeground', command: { command: 'shipcheck.showReport', title: 'Open' } })), open: true }));
  }
  return items;
}

// ------------------------------------------------------------------ webview
function renderPanel() {
  if (!state.panel || !state.analysis) return;
  const nonce = crypto.randomBytes(16).toString('base64');
  state.panel.webview.html = reportView.build(state.analysis, nonce, state.panel.webview.cspSource, state.checks, state.runningChecks);
}

function showReport() {
  if (!state.analysis) return;
  if (state.panel) { state.panel.reveal(); renderPanel(); return; }
  const p = vscode.window.createWebviewPanel('shipcheckReport', 'ShipCheck Report', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  state.panel = p;
  p.onDidDispose(() => { state.panel = null; });
  p.webview.onDidReceiveMessage((m) => {
    switch (m.type) {
      case 'open': openPath(m.file, m.line); break;
      case 'refresh': review(state.scope, {}); break;
      case 'pr': vscode.commands.executeCommand('shipcheck.generatePR'); break;
      case 'checks': vscode.commands.executeCommand('shipcheck.runChecks'); break;
      case 'markdown': vscode.commands.executeCommand('shipcheck.exportMarkdown'); break;
      case 'ai': vscode.commands.executeCommand('shipcheck.aiReview'); break;
      case 'copy': vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage('ShipCheck: copied', 2000); break;
      default: break;
    }
  });
  renderPanel();
}

async function openPath(rel, line) {
  const root = (state.analysis && state.analysis.meta.root) || state.root;
  if (!root || !rel) return;
  const uri = vscode.Uri.file(path.join(root, rel));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ln = Math.max(0, (line || 1) - 1);
    const ed = await vscode.window.showTextDocument(doc, { preview: true, selection: new vscode.Range(ln, 0, ln, 0) });
    ed.revealRange(new vscode.Range(ln, 0, ln, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (e) {
    vscode.window.showWarningMessage(`ShipCheck: cannot open ${rel} (deleted or moved?).`);
  }
}

async function openMarkdown(text) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
  await vscode.window.showTextDocument(doc, { preview: false });
}

// ------------------------------------------------------------------ project checks
async function runChecks() {
  const a = await ensureAnalysis();
  if (!a) return;
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('ShipCheck: running project commands requires a trusted workspace.');
    return;
  }
  if (state.runningChecks) return;
  const root = a.meta.root;
  let cmds = cfgGet('checkCommands', root) || [];
  if (!cmds.length) cmds = checksLib.detectCommands(root);
  if (!cmds.length) {
    const pick = await vscode.window.showInformationMessage('ShipCheck could not detect lint/type-check/test commands. Configure "shipcheck.checkCommands" (e.g. ["npm run lint", "npm test"]).', 'Open settings');
    if (pick) vscode.commands.executeCommand('workbench.action.openSettings', 'shipcheck.checkCommands');
    return;
  }
  state.runningChecks = true; state.checks = []; renderPanel();
  state.output.clear(); state.output.show(true);
  const timeoutSec = cfgGet('checkTimeoutSec', root) || 600;
  const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ShipCheck: running project checks…', cancellable: true }, async (_p, token) => {
    const all = [];
    for (const cmd of cmds) {
      state.output.appendLine(`\n$ ${cmd}`);
      const run = checksLib.runCommands(root, [cmd], { timeoutSec, onOutput: (t) => state.output.append(t) });
      token.onCancellationRequested(() => run.cancel());
      const r = (await run.promise)[0];
      if (r) { all.push(r); state.output.appendLine(`→ exit ${r.code}${r.timedOut ? ' (timed out)' : ''} in ${Math.round(r.durationMs / 100) / 10}s`); }
      if (token.isCancellationRequested) break;
    }
    return all;
  });
  state.checks = results; state.runningChecks = false;
  state.tree.refresh(); renderPanel();
  const failed = results.filter((r) => r.code !== 0);
  if (failed.length) vscode.window.showErrorMessage(`ShipCheck: ${failed.length} of ${results.length} check(s) failed — ${failed.map((f) => f.cmd).join(', ')}`, 'Open report').then((p) => p && showReport());
  else vscode.window.showInformationMessage(`ShipCheck: all ${results.length} project check(s) passed.`);
}

// ------------------------------------------------------------------ activate
function activate(context) {
  state.ctx = context;
  state.output = vscode.window.createOutputChannel('ShipCheck');
  state.diag = vscode.languages.createDiagnosticCollection('shipcheck');
  state.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  state.tree = new TreeProvider();
  context.subscriptions.push(state.output, state.diag, state.status,
    vscode.window.createTreeView('shipcheck.results', { treeDataProvider: state.tree, showCollapseAll: true }));
  vscode.commands.executeCommand('setContext', 'shipcheck.hasResults', false);
  setStatus();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('shipcheck.review', () => review('branch'));
  reg('shipcheck.reviewStaged', () => review('staged'));
  reg('shipcheck.reviewWorking', () => review('working'));
  reg('shipcheck.showReport', async () => { if (await ensureAnalysis()) showReport(); });
  reg('shipcheck.generatePR', async () => {
    const a = await ensureAnalysis(); if (!a) return;
    const text = pr.buildPR(a, state.checks);
    await openMarkdown(text);
    const pick = await vscode.window.showInformationMessage('PR description generated. Fill in the “why” and review the checklist.', 'Copy to clipboard');
    if (pick) { await vscode.env.clipboard.writeText(text); vscode.window.setStatusBarMessage('ShipCheck: PR description copied', 2500); }
  });
  reg('shipcheck.copyPR', async () => {
    const a = await ensureAnalysis(); if (!a) return;
    await vscode.env.clipboard.writeText(pr.buildPR(a, state.checks));
    vscode.window.showInformationMessage('ShipCheck: PR description copied to the clipboard.');
  });
  reg('shipcheck.exportMarkdown', async () => { const a = await ensureAnalysis(); if (a) await openMarkdown(pr.buildReviewMarkdown(a, state.checks)); });
  reg('shipcheck.runChecks', runChecks);
  reg('shipcheck.chooseBase', async () => {
    const root = await pickRoot(); if (!root) return;
    const out = G.gitOk(root, ['branch', '-a', '--format=%(refname:short)']) || '';
    const names = [...new Set(out.split('\n').map((s) => s.trim()).filter((s) => s && !/\bHEAD\b/.test(s) && !s.endsWith('/HEAD')))];
    const pick = await vscode.window.showQuickPick([{ label: '$(sparkle) Auto-detect', description: 'origin/main, main, master, develop…', value: '' }, ...names.map((n) => ({ label: n, value: n }))], { placeHolder: 'Compare my work against which branch?' });
    if (!pick) return;
    await vscode.workspace.getConfiguration('shipcheck', vscode.Uri.file(root)).update('baseBranch', pick.value, vscode.ConfigurationTarget.Workspace);
    review(state.scope, { root });
  });
  reg('shipcheck.installHook', async () => {
    const root = await pickRoot(); if (!root) return;
    if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('ShipCheck: installing a git hook requires a trusted workspace.'); return; }
    const ok = await vscode.window.showWarningMessage('Install a git pre-push hook? Pushes will be blocked when ShipCheck finds blocking issues in your committed changes. Bypass once with `git push --no-verify`.', { modal: true }, 'Install');
    if (ok !== 'Install') return;
    try {
      const r = hook.install(root, state.ctx.extensionPath);
      vscode.window.showInformationMessage(`ShipCheck: pre-push hook ${r.mode} (${r.hookFile}). Requires Node.js on PATH. Re-install after updating the extension to refresh the hook runtime.`);
    } catch (e) { vscode.window.showErrorMessage('ShipCheck: could not install the hook — ' + e.message); }
  });
  reg('shipcheck.uninstallHook', async () => {
    const root = await pickRoot(); if (!root) return;
    try { const r = hook.uninstall(root); vscode.window.showInformationMessage(r.removed ? 'ShipCheck: pre-push hook removed.' : 'ShipCheck: no ShipCheck hook was installed.'); } catch (e) { vscode.window.showErrorMessage('ShipCheck: ' + e.message); }
  });
  reg('shipcheck.aiReview', async () => {
    const a = await ensureAnalysis(); if (!a) return;
    try {
      const text = await ai.run(vscode, 'review', a, core.mergeConfig(settings(a.meta.root), core.loadRc(a.meta.root)), { globalState: context.globalState });
      if (text) await openMarkdown(`# AI second opinion (untrusted — verify before acting)\n\n${text}`);
    } catch (e) { vscode.window.showErrorMessage('ShipCheck AI: ' + e.message); }
  });
  reg('shipcheck.aiPR', async () => {
    const a = await ensureAnalysis(); if (!a) return;
    try {
      const text = await ai.run(vscode, 'pr', a, core.mergeConfig(settings(a.meta.root), core.loadRc(a.meta.root)), { globalState: context.globalState });
      if (text) await openMarkdown(text);
    } catch (e) { vscode.window.showErrorMessage('ShipCheck AI: ' + e.message); }
  });
  reg('shipcheck.openPath', openPath);
  reg('shipcheck.showTestStub', (t) => t && openMarkdown(`# Suggested tests for \`${t.file}\`\n\nSymbols: ${t.symbols.join(', ')}${t.branches ? ` · ${t.branches} new branch point(s)` : ''}\n\n\`\`\`\n${t.stub}\n\`\`\`\n`));
  reg('shipcheck.copyText', (t) => { vscode.env.clipboard.writeText(String(t || '')); vscode.window.setStatusBarMessage('ShipCheck: copied', 2000); });
  reg('shipcheck.clear', () => { state.analysis = null; state.checks = []; apply(); });
  reg('shipcheck.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + context.extension.id));

  // optional auto-review on save (debounced)
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!state.analysis || doc.uri.scheme !== 'file') return;
    if (!cfgGet('autoReviewOnSave', state.root)) return;
    if (!doc.uri.fsPath.startsWith(state.root)) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => review(state.scope, { silent: true, root: state.root }), 2500);
  }));
}

function deactivate() { clearTimeout(state.saveTimer); }

module.exports = { activate, deactivate };
