'use strict';
const path = require('path');

const LANGS = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py', go: 'go', java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', cs: 'cs', php: 'php',
  rb: 'rb', rs: 'rs', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', swift: 'swift', sql: 'sql',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', yml: 'yaml', yaml: 'yaml', json: 'json', toml: 'toml',
  md: 'md', mdx: 'md', txt: 'txt', rst: 'md', tf: 'tf', html: 'html', htm: 'html', css: 'css', scss: 'css'
};
const CODE_LANGS = new Set(['js', 'py', 'go', 'java', 'cs', 'php', 'rb', 'rs', 'c', 'swift', 'sh']);

function langOf(p) {
  const b = path.posix.basename(p).toLowerCase();
  if (b === 'dockerfile' || b.startsWith('dockerfile.')) return 'docker';
  const e = b.includes('.') ? b.slice(b.lastIndexOf('.') + 1) : '';
  return LANGS[e] || e || 'other';
}

const TEST_RE = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress|fixtures|testdata)\/|\.(test|spec|e2e)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs|php)$|(Tests?|Spec|IT)\.(java|kt|cs|scala|swift)$/i;
const DOC_RE = /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\//i;
const INFRA_RE = /(^|\/)(\.github\/workflows\/|\.circleci\/|\.buildkite\/|helm\/|charts\/|k8s\/|kubernetes\/|terraform\/)|(^|\/)(\.gitlab-ci\.ya?ml|azure-pipelines[^/]*\.ya?ml|jenkinsfile|dockerfile(\.[\w.-]+)?|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$|\.(tf|tfvars)$/i;
const MIGRATION_RE = /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate|flyway|liquibase)\//i;
const DEPS_RE = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|packages\.lock\.json|[\w.-]+\.csproj)$/i;
const LOCK_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock|packages\.lock\.json)$/i;

const isTestFile = (p) => TEST_RE.test(p);
const isDocFile = (p) => DOC_RE.test(p);

function classify(p) {
  if (isTestFile(p)) return 'test';
  if (isDocFile(p)) return 'doc';
  if (DEPS_RE.test(p)) return 'deps';
  if (INFRA_RE.test(p)) return 'ci';
  if (MIGRATION_RE.test(p) || /\.sql$/i.test(p) || /schema\.prisma$/i.test(p)) return 'db';
  const l = langOf(p);
  if (CODE_LANGS.has(l)) return 'source';
  if (['json', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml'].includes(l) || /\.env/.test(p)) return 'config';
  return 'other';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end + 1;
        continue;
      }
      re += '\\{';
    } else {
      re += escapeRe(c);
    }
    i++;
  }
  return new RegExp('^' + re + '$', 'i');
}
const _globCache = new Map();
function matchesAny(globs, p) {
  for (const g of globs || []) {
    let r = _globCache.get(g);
    if (!r) { r = globToRegex(g); _globCache.set(g, r); }
    if (r.test(p)) return true;
  }
  return false;
}

function entropy(s) {
  if (!s) return 0;
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  let h = 0;
  for (const n of m.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// Replace string literals by "" but keep the expressions inside template-literal ${...}
function stripStrings(s) {
  return s
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => {
      const parts = [];
      m.replace(/\$\{([^}]*)\}/g, (_, x) => { parts.push(x); return ''; });
      return '""' + (parts.length ? ' ' + parts.join(' ') : '');
    })
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function splitParams(str) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of str || '') {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
function humanizeBranch(b) {
  if (!b || b === 'HEAD') return '';
  const s = b.replace(/^(feature|feat|fix|bugfix|hotfix|chore|refactor|docs|test|perf|ci)\//i, '')
    .replace(/^[A-Z]+-\d+[-_]?/, (m) => m.replace(/[-_]$/, ': '))
    .replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
const posix = (p) => p.split(path.sep).join('/');

module.exports = {
  LANGS, CODE_LANGS, langOf, isTestFile, isDocFile, classify, globToRegex, matchesAny, entropy, stripStrings,
  splitParams, escapeHtml, truncate, humanizeBranch, escapeRe, posix, MIGRATION_RE, DEPS_RE, LOCK_RE, INFRA_RE
};
