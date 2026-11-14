'use strict';
// Optional: uses VS Code's Language Model API (e.g. GitHub Copilot). Nothing is sent unless the user confirms.
const G = require('./git');
const U = require('./util');

const MAX_CHARS = 70000;

function diffFor(a, cfg) {
  const root = a.meta.root;
  const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--unified=4', '-M'];
  let args;
  if (a.meta.scope === 'staged') args = [...base, '--cached'];
  else if (a.meta.scope === 'working') args = [...base, 'HEAD'];
  else args = cfg.includeUncommitted ? [...base, a.meta.mergeBaseFull] : [...base, a.meta.mergeBaseFull, 'HEAD'];
  const raw = G.git(root, args);
  const parts = raw.split(/^(?=diff --git )/m).filter(Boolean);
  let out = ''; let omitted = 0;
  for (const part of parts) {
    const m = part.match(/^diff --git a\/(.*) b\/(.*)$/m);
    const file = m ? m[2] : '';
    if (U.matchesAny(cfg.ignorePaths, file)) continue;
    const chunk = part.length > 12000 ? part.slice(0, 12000) + '\n… [file diff truncated]\n' : part;
    if (out.length + chunk.length > MAX_CHARS) { omitted++; continue; }
    out += chunk;
  }
  if (omitted) out += `\n… [${omitted} more file diff(s) omitted to fit the model context]\n`;
  return out;
}

function prompt(kind, a, diff) {
  const top = a.findings.filter((f) => f.severity !== 'suggestion').slice(0, 15).map((f) => `- [${f.severity}] ${f.title} (${f.file || ''}${f.line ? ':' + f.line : ''})`).join('\n') || '- none';
  if (kind === 'pr') {
    return `You write pull-request descriptions. Based on the diff and the static-analysis summary below, write a concise, honest PR description in Markdown with these sections: Summary (what and why), Changes (grouped bullets), Risks, How to test (concrete steps), Rollback. Do not invent behaviour that is not visible in the diff; where intent is unclear write "TODO: …" instead of guessing.\n\nBranch: ${a.meta.branch} → ${a.meta.baseName}\nCommit subjects:\n${a.commits.map((c) => '- ' + c.subject).join('\n') || '- (none)'}\n\nStatic analysis found:\n${top}\n\nDIFF:\n${diff}`;
  }
  return `You are a meticulous senior code reviewer doing a pre-merge review. Review the diff below.\nRules: only report problems you can justify from the diff (bugs, security, data loss, breaking API/DB changes, concurrency, error handling, missing tests). Cite file and line. Classify each as Blocking / Warning / Suggestion and explain WHY in one or two sentences with a concrete fix. No generic advice ("improve readability"). If something cannot be verified from the diff, say what you would need to check. Finish with a one-paragraph verdict.\nA static analyzer already found these — do not repeat them unless you add insight:\n${top}\n\nDIFF:\n${diff}`;
}

async function run(vscode, kind, a, cfg, state) {
  if (!vscode.lm || !vscode.lm.selectChatModels) {
    vscode.window.showWarningMessage('AI features need VS Code 1.90+ and a chat model provider (for example GitHub Copilot).');
    return null;
  }
  const models = await vscode.lm.selectChatModels({});
  if (!models || !models.length) {
    vscode.window.showWarningMessage('No language model is available. Install and sign in to GitHub Copilot Chat (or another provider), then try again.');
    return null;
  }
  const model = models.find((m) => /copilot/i.test(m.vendor)) || models[0];
  const key = `shipcheck.aiConsent.${model.vendor}.${model.id}`;
  if (!state.globalState.get(key)) {
    const pick = await vscode.window.showInformationMessage(
      'Send this diff to an AI model?',
      { modal: true, detail: `ShipCheck will send the diff of your changes (secrets are not filtered automatically) to "${model.name || model.id}" provided by "${model.vendor}". Nothing is sent without your confirmation.` },
      'Send', 'Cancel');
    if (pick !== 'Send') return null;
    await state.globalState.update(key, true);
  }
  const diff = diffFor(a, cfg);
  const messages = [vscode.LanguageModelChatMessage.User(prompt(kind, a, diff))];
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `ShipCheck: asking ${model.name || model.id}…`, cancellable: true }, async (_p, token) => {
    const res = await model.sendRequest(messages, {}, token);
    let text = '';
    for await (const chunk of res.text) text += chunk;
    return text;
  });
}

module.exports = { run, diffFor, prompt };
