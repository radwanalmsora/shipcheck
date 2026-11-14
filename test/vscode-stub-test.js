'use strict';
// Smoke test: loads extension.js against a minimal fake `vscode` module and exercises activate + review + tree + report.
const Module = require('module');
const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ext-'));
const sh = (c) => cp.execSync(c, { cwd: dir, stdio: 'pipe' }).toString();
sh('git init -q -b main && git config user.email a@b && git config user.name t');
fs.writeFileSync(path.join(dir, 'a.js'), 'let a = 1;\n'); sh('git add -A && git commit -qm i && git checkout -qb f');
fs.writeFileSync(path.join(dir, 'a.js'), "let a = 1;\nconst token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n"); sh('git commit -qam x');

const cmds = {}; const diagSets = []; let info = [];
class Disp { dispose() {} }
class TreeItem { constructor(l, c) { this.label = l; this.collapsibleState = c; } }
class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
class Diagnostic { constructor(r, m, s) { Object.assign(this, { r, m, s }); } }
class MD { constructor(v) { this.value = v; } }
const vscode = {
  window: {
    createOutputChannel: () => ({ clear() {}, show() {}, append() {}, appendLine() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createTreeView: () => new Disp(),
    createWebviewPanel: () => { const p = { webview: { cspSource: 'x', onDidReceiveMessage() {}, set html(v) { p.html = v; } }, reveal() {}, onDidDispose() {} }; vscode._panel = p; return p; },
    withProgress: (_o, fn) => fn({}, { onCancellationRequested() {}, isCancellationRequested: false }),
    showInformationMessage: async (m) => { info.push(m); }, showWarningMessage: async (m) => { info.push(m); }, showErrorMessage: async (m) => { info.push(m); },
    setStatusBarMessage() {}, showTextDocument: async () => ({ revealRange() {} }), get activeTextEditor() { return undefined; }
  },
  workspace: {
    workspaceFolders: [{ name: 'r', uri: { fsPath: dir, toString: () => dir } }], isTrusted: true,
    getConfiguration: () => ({ get: (k) => ({ ignorePaths: ['**/node_modules/**'], includeUncommitted: true, includeUntracked: true, maxLineLength: 160, maxFileSizeKB: 1024, minAddedLinesForTestCheck: 8, disabledRules: [], severityOverrides: {}, customRules: [], baseBranch: '' }[k]) }),
    onDidSaveTextDocument: () => new Disp(), openTextDocument: async (o) => ({ opened: o }), getWorkspaceFolder: () => undefined
  },
  commands: { registerCommand: (id, fn) => { cmds[id] = fn; return new Disp(); }, executeCommand: async (id, ...a) => (cmds[id] ? cmds[id](...a) : undefined) },
  languages: { createDiagnosticCollection: () => ({ clear() {}, set: (u, l) => diagSets.push([u, l]), dispose() {} }) },
  env: { clipboard: { writeText: async () => {} } },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }) },
  TreeItem, Range, Diagnostic, MarkdownString: MD, ThemeIcon: class { constructor(i, c) { this.i = i; this.c = c; } }, ThemeColor: class { constructor(i) { this.i = i; } },
  EventEmitter: class { constructor() { this.event = () => new Disp(); } fire() {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 }, ConfigurationTarget: { Workspace: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 }
};
const orig = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? vscode : orig.call(this, req, ...r); };
const ext = require('../extension');
const ctx = { subscriptions: [], extensionPath: path.join(__dirname, '..'), extension: { id: 'x.shipcheck' }, globalState: { get() {}, update: async () => {} } };
ext.activate(ctx);
(async () => {
  await cmds['shipcheck.review']();
  await cmds['shipcheck.showReport']();
  const html = vscode._panel && vscode._panel.html;
  const ok = diagSets.length === 1 && html && html.includes('Credential for a known service') && !html.includes('abcdefghijklmnopqrstuvwxyz0123456789');
  await cmds['shipcheck.generatePR']();
  console.log('messages:', info.slice(0, 2));
  console.log('diagnostics:', diagSets.length, 'html bytes:', html && html.length);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!ok) { console.log('EXT SMOKE FAILED'); process.exit(1); }
  console.log('EXT SMOKE OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
