'use strict';
const U = require('./util');

function finding(o) {
  return Object.assign({
    ruleId: '', severity: 'suggestion', category: 'quality', title: '', detail: '',
    file: null, line: 0, snippet: '', why: '', fix: '', occurrences: null
  }, o);
}

// ---------------------------------------------------------------- helpers
const PLACEHOLDER = /^(?:x+|\*+|\.+|<.*>|\$\{.*\}|\{\{.*\}\}|%\(.*\)s|your[_-].*|my[_-].*|example.*|changeme|change[_-]me|replace[_-]?me|placeholder|dummy|test.*|sample.*|secret|password|passwd|null|none|undefined|todo|redacted|fake.*|foo.*|bar.*|123.*|abc.*|process\.env.*)$/i;
const isComment = (t) => /^\s*(\/\/|#|\*|\/\*|--|<!--)/.test(t);
const redact = (t) => t
  .replace(/(:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1••••@')
  .replace(/(["'`])([^"'`]{6,})\1/g, (m, q, v) => q + v.slice(0, 2) + '••••' + q)
  .replace(/[A-Za-z0-9_\-+/=]{12,}/g, (m) => m.slice(0, 4) + '••••');

const SECRET_PROVIDERS = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Slack webhook URL', /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/],
  ['Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['OpenAI / Anthropic API key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/],
  ['SendGrid API key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ['npm access token', /\bnpm_[A-Za-z0-9]{36}\b/]
];

// ---------------------------------------------------------------- rule table
const RULES = [];
function R(id, severity, category, title, o) {
  RULES.push(Object.assign({ id, severity, category, title }, o));
}
const JS = ['js'];

// ---- merge / debug leftovers
R('QUAL-CONFLICT-MARKER', 'blocking', 'quality', 'Unresolved merge conflict marker', {
  re: /^(?:<{7}(?: .*)?|>{7}(?: .*)?)$/,
  why: 'A conflict marker was committed. The file will not compile or will behave unpredictably.',
  fix: 'Resolve the conflict, remove all <<<<<<< / ======= / >>>>>>> lines and re-run the tests.'
});
R('TEST-FOCUSED', 'blocking', 'tests', 'Focused test left in (.only)', {
  langs: JS,
  re: /\b(?:describe|it|test|context)\.only\s*\(|\bf(?:describe|it)\s*\(/,
  why: 'A focused test makes the runner skip every other test, so CI can go green while most of the suite never runs.',
  fix: 'Remove `.only` / `fit` / `fdescribe`.'
});
R('TEST-SKIPPED', 'warning', 'tests', 'Test is skipped', {
  re: /\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip\b|@unittest\.skip\b|@Disabled\b|@Ignore\b|\bt\.Skip\(/,
  why: 'A skipped test hides a regression signal. If it fails today it will keep silently failing.',
  fix: 'Fix the test, delete it, or link a ticket in the skip reason.'
});
R('QUAL-DEBUGGER', 'warning', 'quality', '`debugger` statement', {
  langs: JS, skipTests: true, re: /^\s*debugger\s*;?\s*$/,
  why: 'A debugger statement pauses execution for anyone running with devtools open.', fix: 'Remove it.'
});

// ---- secrets (these also run on docs: a key in a README is still a leaked key)
R('SECRET-PRIVATE-KEY', 'blocking', 'security', 'Private key committed', {
  docs: true, re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  why: 'Private keys in git history stay recoverable forever, even after you delete the file.',
  fix: 'Remove it, rotate the key immediately, and load it from a secret manager or environment variable.'
});
R('SECRET-PROVIDER-TOKEN', 'blocking', 'security', 'Credential for a known service committed', {
  docs: true,
  match: (t) => { for (const [name, re] of SECRET_PROVIDERS) if (re.test(t)) return name; return null; },
  why: 'The value matches the exact format of a real provider credential.',
  fix: 'Revoke and rotate the credential, purge it from history if already pushed, and read it from the environment.'
});
R('SECRET-JWT', 'blocking', 'security', 'JSON Web Token committed', {
  docs: true, skipTests: true, re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  why: 'A hard-coded JWT usually grants access until it expires (or forever if it has no expiry).',
  fix: 'Remove it and generate tokens at runtime.'
});
R('SECRET-DB-URL', 'blocking', 'security', 'Database/broker URL with embedded password', {
  docs: true,
  match: (t) => {
    const m = t.match(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/([^\s:@/'"`]+):([^\s@/'"`]+)@/i);
    if (!m) return null;
    return PLACEHOLDER.test(m[2]) || /^\$|^<|^\{|^%/.test(m[2]) ? null : 'embedded password';
  },
  why: 'Connection strings with credentials grant direct data access.',
  fix: 'Use an environment variable (DATABASE_URL) and rotate the password.'
});
R('SECRET-NPMRC-TOKEN', 'blocking', 'security', 'Registry auth token in config', {
  docs: true, re: /_authToken\s*=\s*(?!\$\{)[^\s$]{8,}/,
  why: 'Registry tokens allow publishing packages as you.', fix: 'Use `${NPM_TOKEN}` in .npmrc and set it in CI.'
});
R('SECRET-GENERIC', 'blocking', 'security', 'Hard-coded secret', {
  skipComments: true,
  match: (t, c) => {
    const m = t.match(/(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*(["'`])((?:(?!\1).){8,})\1/i);
    if (!m) return null;
    const v = m[2];
    if (/\s/.test(v) || PLACEHOLDER.test(v) || /\$\{|process\.env|os\.environ|getenv/i.test(v)) return null;
    if (U.entropy(v) < 3.0) return null;
    return c.isTest ? { severity: 'warning', detail: 'looks like a secret (in a test file)' } : 'high-entropy literal assigned to a secret-like name';
  },
  why: 'A high-entropy literal is assigned to a variable named like a secret. Anyone with repo access can use it.',
  fix: 'Move it to an environment variable or secret manager and rotate it if it is real.'
});

// ---- injection & unsafe APIs
R('SEC-TLS-DISABLED', 'warning', 'security', 'TLS certificate verification disabled', {
  skipTests: true,
  re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)|ServerCertificateValidationCallback\s*=.*true/,
  why: 'Disabling certificate checks makes man-in-the-middle attacks trivial.',
  fix: 'Keep verification on; trust a custom CA through the CA bundle option instead.'
});
R('SEC-EVAL', 'warning', 'security', 'Dynamic code execution (eval / new Function)', {
  langs: ['js', 'py', 'php', 'rb'], skipTests: true, skipComments: true,
  match: (t, c) => (/\beval\s*\(|\bnew\s+Function\s*\(/.test(c.stripped()) && !/\.eval\s*\(\s*['"]/.test(t) ? true : null),
  why: 'Evaluating strings as code turns any attacker-influenced string into remote code execution.',
  fix: 'Use a parser (JSON.parse, ast.literal_eval) or a lookup table of allowed operations.'
});
R('SEC-CMD-INJECTION', 'warning', 'security', 'Shell command built from a dynamic string', {
  langs: ['js'], skipTests: true, skipComments: true,
  re: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|[^,)]*["'`]\s*\+|\w+\s*\+)/,
  why: 'Interpolating values into a shell string allows command injection.',
  fix: 'Use execFile/spawn with an argument array and no shell.'
});
R('SEC-CMD-INJECTION-PY', 'warning', 'security', 'Shell command built from a dynamic string', {
  langs: ['py'], skipTests: true, skipComments: true,
  re: /\b(?:subprocess\.\w+|os\.system|os\.popen)\(\s*(?:f["']|["'][^"']*["']\s*(?:\+|%|\.format)|\w+\s*\+)|shell\s*=\s*True/,
  why: 'Shell strings built from variables (or shell=True) allow command injection.',
  fix: 'Pass a list of arguments to subprocess and keep shell=False.'
});
R('SEC-SQL-INJECTION', 'warning', 'security', 'SQL built with string interpolation', {
  skipTests: true, skipComments: true, langs: ['js', 'py', 'java', 'cs', 'php', 'rb', 'go'],
  match: (t) => {
    if (!/\b(?:select\b[\s\S]+\bfrom\b|insert\s+into\b|update\s+[\w."`]+\s+set\b|delete\s+from\b)/i.test(t)) return null;
    const dyn = (/`[^`]*\$\{[^}]+\}/.test(t)) || /["']\s*\+\s*[\w.(]|[\w)\]]\s*\+\s*["']/.test(t) ||
      /\bf["'][^"']*\{[^}]+\}/.test(t) || /["']\s*%\s*[\w(]|\.format\(/.test(t) || /String\.format\(|\$"[^"]*\{/.test(t) ||
      /fmt\.Sprintf\(\s*["'`][^"'`]*%[sdv]/.test(t);
    return dyn ? true : null;
  },
  why: 'Values concatenated into SQL can be abused for SQL injection.',
  fix: 'Use parameterised queries / prepared statements.'
});
R('SEC-XSS', 'warning', 'security', 'Unescaped HTML injection', {
  langs: ['js', 'html', 'py'], skipTests: true, skipComments: true,
  re: /\.(?:innerHTML|outerHTML)\s*=[^=]|dangerouslySetInnerHTML|document\.write\(|\bv-html\b|\|\s*safe\b|bypassSecurityTrust\w+|\bmark_safe\(/,
  why: 'Writing untrusted data as raw HTML enables cross-site scripting.',
  fix: 'Use textContent / framework escaping, or sanitise with a vetted library (e.g. DOMPurify).'
});
R('SEC-WEAK-HASH', 'warning', 'security', 'Weak hash algorithm (MD5 / SHA-1)', {
  skipTests: true, skipComments: true,
  re: /createHash\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\(|MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"|\bmd5\(|\bsha1\(/i,
  why: 'MD5/SHA-1 are broken for security purposes (passwords, signatures, integrity).',
  fix: 'Use SHA-256+ for integrity and bcrypt/scrypt/argon2 for passwords. Ignore if it is only a non-security checksum.'
});
R('SEC-INSECURE-RANDOM', 'warning', 'security', 'Non-cryptographic randomness used for a secret', {
  skipTests: true, skipComments: true,
  re: /(?:Math\.random\(|\brandom\.(?:random|randint|choice)\(|\brand\(\)|new Random\()[^\n]*(?:token|secret|password|session|nonce|salt|otp|apikey|api_key)|(?:token|secret|password|session|nonce|salt|otp|apikey|api_key)[^\n]*(?:Math\.random\(|\brandom\.(?:random|randint|choice)\(|\brand\(\)|new Random\()/i,
  why: 'Pseudo-random generators are predictable; tokens built from them can be guessed.',
  fix: 'Use crypto.randomBytes / crypto.randomUUID / secrets.token_urlsafe / SecureRandom.'
});
R('SEC-CORS-WILDCARD', 'warning', 'security', 'CORS allows every origin', {
  skipTests: true, skipComments: true,
  re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|\borigin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]|AllowAnyOrigin\(\)/,
  why: 'A wildcard origin lets any website call this API from a victim’s browser (dangerous with cookies/credentials).',
  fix: 'List the exact origins you trust.'
});
R('SEC-PERMS-777', 'warning', 'security', 'World-writable permissions (777)', {
  skipTests: true, skipComments: true, re: /chmod\s+(?:-R\s+)?0?777\b|\b0o?777\b/,
  why: 'Any local user/process can modify the file or directory.', fix: 'Grant the minimum permissions (e.g. 755 / 644).'
});
R('SEC-DESERIALIZATION', 'warning', 'security', 'Unsafe deserialisation', {
  skipTests: true, skipComments: true,
  match: (t) => (/\bpickle\.loads?\(|\bunserialize\(|\bObjectInputStream\b|\byaml\.load\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/.test(t) ? true : null),
  why: 'Deserialising untrusted data can execute arbitrary code.',
  fix: 'Use JSON, yaml.safe_load, or a strict allow-list based deserialiser.'
});
R('SEC-SENSITIVE-LOG', 'warning', 'security', 'Sensitive value may be written to logs', {
  skipTests: true, skipComments: true,
  match: (t, c) => {
    if (!/\b(?:console\.(?:log|info|debug|warn|error)|logger\.\w+|log\.\w+|logging\.\w+|print|println|printf|fmt\.Print\w*|System\.out\.print\w*|Log\.\w)\s*\(/.test(t)) return null;
    return /\b(?:password|passwd|secret|token|api[_-]?key|authorization|credit[_-]?card|cvv|ssn)\b/i.test(c.stripped()) ? true : null;
  },
  why: 'Logs are widely readable and long-lived; credentials or personal data that land there leak.',
  fix: 'Log an identifier instead, or redact the value.'
});

// ---- reliability
R('REL-EMPTY-CATCH', 'warning', 'reliability', 'Empty catch block swallows errors', {
  langs: ['js', 'java', 'cs', 'php'], skipTests: true, re: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  why: 'Swallowed errors turn crashes into silent data corruption that is very hard to debug.',
  fix: 'Handle the error, log it, or rethrow. If ignoring is intentional, add a comment explaining why.'
});
R('REL-EXCEPT-PASS', 'warning', 'reliability', 'except block that only passes', {
  langs: ['py'], skipTests: true,
  match: (t, c) => (/^\s*except\b.*:\s*$/.test(t) && c.next && /^\s*pass\s*(#.*)?$/.test(c.next.text) ? true : null),
  why: 'Swallowed exceptions hide failures.', fix: 'Catch a specific exception and handle or log it.'
});
R('REL-BARE-EXCEPT', 'suggestion', 'reliability', 'Bare `except:` also catches KeyboardInterrupt/SystemExit', {
  langs: ['py'], skipTests: true, re: /^\s*except\s*:/, aggregate: true,
  why: 'A bare except catches everything, including exit signals.', fix: 'Use `except Exception:` or a narrower type.'
});

// ---- database (destructive SQL in any non-test source)
R('DB-DESTRUCTIVE', 'warning', 'database', 'Destructive database operation', {
  skipTests: true, skipComments: true, langs: ['sql', 'py', 'js', 'java', 'cs', 'php', 'rb', 'go', 'sh'],
  match: (t, c) => {
    if (/\bDROP\s+(?:TABLE|COLUMN|DATABASE|SCHEMA)\b/i.test(t)) return 'DROP';
    if (/\bTRUNCATE\s+(?:TABLE\s+)?[\w."`]+/i.test(t)) return 'TRUNCATE';
    if (/\b(?:dropTable|dropColumn|drop_table|drop_column|removeColumn|remove_column|DropTable|DropColumn)\s*\(/.test(t)) return 'drop via ORM/migration helper';
    if (/\bDELETE\s+FROM\s+[\w."`]+\s*(?:;|["'`)]|$)/i.test(t) && !/\bWHERE\b/i.test(t)) return 'DELETE without WHERE';
    if (/\bALTER\s+TABLE\b[^;]*\b(?:RENAME|DROP)\b/i.test(t)) return 'ALTER TABLE rename/drop';
    if (/\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b(?![^;]*\bDEFAULT\b)/i.test(t)) return 'NOT NULL column without DEFAULT';
    return null;
  },
  why: 'This removes or reshapes data/schema. Old application versions running during a rolling deploy will break, and the data cannot be restored by reverting the commit.',
  fix: 'Use an expand/contract migration (add → backfill → switch → drop later), take a backup, and verify a down-migration.'
});

// ---- CI / infra
R('CI-PULL-REQUEST-TARGET', 'warning', 'infra', '`pull_request_target` workflow trigger', {
  pathRe: /\.github\/workflows\//, docs: true, re: /\bpull_request_target\b/,
  why: 'It runs with write permissions and secrets against code from forks; combined with a checkout of the PR it is a known takeover vector.',
  fix: 'Use `pull_request`, or never check out/execute untrusted PR code in this workflow.'
});
R('CI-WRITE-ALL', 'warning', 'infra', 'Workflow grants write-all permissions', {
  pathRe: /\.github\/workflows\//, docs: true, re: /permissions\s*:\s*write-all/,
  why: 'The default token gets every write scope.', fix: 'Declare the minimal permissions per job.'
});
R('INFRA-PIPE-TO-SHELL', 'warning', 'infra', 'Remote script piped into a shell', {
  langs: ['sh', 'yaml', 'docker'], docs: false, re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
  why: 'Executing unverified remote code in your build/runtime is a supply-chain risk.',
  fix: 'Download, verify a checksum/signature, then execute.'
});
R('INFRA-DOCKER-LATEST', 'warning', 'infra', 'Docker base image uses :latest', {
  langs: ['docker'], re: /^\s*FROM\s+\S+:latest\b/i,
  why: 'Builds are not reproducible and can break or change without any code change.', fix: 'Pin a version tag or digest.'
});
R('INFRA-OPEN-CIDR', 'warning', 'infra', 'Resource open to the whole internet (0.0.0.0/0)', {
  langs: ['tf', 'yaml', 'json'], pathRe: /(terraform|\.tf$|k8s|kubernetes|helm|charts|cloudformation|security)/i,
  re: /0\.0\.0\.0\/0/, skipComments: true,
  why: 'Opening ports to every address greatly increases attack surface.', fix: 'Restrict the CIDR to known ranges.'
});

// ---- quality (suggestions, aggregated one-per-file)
R('QUAL-CONSOLE-LOG', 'suggestion', 'quality', 'console.log left in source', {
  langs: JS, skipTests: true, aggregate: true, pathRe: /^(?!.*(?:^|\/)(?:scripts?|bin|cli|tools?)\/)/i, skipComments: true,
  re: /\bconsole\.(?:log|debug)\(/,
  why: 'Debug output pollutes production logs and may leak data.', fix: 'Use the project logger or remove it.'
});
R('QUAL-TODO', 'suggestion', 'quality', 'New TODO / FIXME / HACK', {
  aggregate: true, docs: false, re: /\b(?:TODO|FIXME|HACK|XXX)\b/,
  why: 'Unowned TODOs tend to stay forever.', fix: 'Resolve it, or link a ticket in the comment.'
});
R('QUAL-TS-ANY', 'suggestion', 'quality', 'TypeScript `any` weakens type safety', {
  langs: JS, pathRe: /\.(?:ts|tsx|mts|cts)$/, skipTests: true, aggregate: true, skipComments: true,
  re: /:\s*any\b|\bas\s+any\b|<any>/,
  why: '`any` disables type checking for everything that touches the value.', fix: 'Use a concrete type or `unknown` + narrowing.'
});
R('QUAL-TS-IGNORE', 'suggestion', 'quality', 'Type/lint check suppressed', {
  langs: JS.concat(['py']), aggregate: true, docs: false,
  re: /@ts-ignore|@ts-nocheck|eslint-disable(?!-next-line|-line)|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable/,
  why: 'Suppressions hide the exact problems the tools exist to catch.', fix: 'Fix the underlying issue or scope the suppression to one line with a reason.'
});
R('QUAL-LOCALHOST-URL', 'suggestion', 'quality', 'Hard-coded localhost / private IP URL', {
  langs: ['js', 'py', 'java', 'cs', 'php', 'rb', 'go', 'rs'], skipTests: true, aggregate: true, skipComments: true,
  re: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?::\d+)?/,
  why: 'Works on your machine, fails in every other environment.', fix: 'Read the URL from configuration.'
});
R('QUAL-TRAILING-WS', 'suggestion', 'quality', 'Trailing whitespace', {
  langs: ['js', 'py', 'go', 'java', 'cs', 'php', 'rb', 'rs', 'c', 'swift', 'sh'], aggregate: true,
  re: /[ \t]+$/, why: 'Creates noisy diffs.', fix: 'Enable "trim trailing whitespace" in the editor / formatter.'
});
R('QUAL-LONG-LINE', 'suggestion', 'quality', 'Very long line', {
  langs: ['js', 'py', 'go', 'java', 'cs', 'php', 'rb', 'rs', 'c', 'swift', 'sh'], aggregate: true,
  match: (t, c) => (t.length > c.cfg.maxLineLength && !/https?:\/\/\S{80,}/.test(t) ? `${t.length} chars` : null),
  why: 'Long lines are hard to review and often hide complexity.', fix: 'Wrap or extract the expression.'
});

// ---------------------------------------------------------------- engine
function buildRules(cfg) {
  const disabled = new Set(cfg.disabledRules || []);
  const ov = cfg.severityOverrides || {};
  const rules = [];
  for (const r of RULES) {
    if (disabled.has(r.id) || ov[r.id] === 'off') continue;
    const copy = Object.assign({}, r);
    if (ov[r.id] && ['blocking', 'warning', 'suggestion'].includes(ov[r.id])) copy.severity = ov[r.id];
    rules.push(copy);
  }
  for (const cr of cfg.customRules || []) {
    try {
      if (!cr || !cr.id || !cr.pattern) continue;
      const id = 'CUSTOM-' + String(cr.id).toUpperCase().replace(/[^A-Z0-9]+/g, '-');
      if (disabled.has(id)) continue;
      const re = new RegExp(cr.pattern, cr.flags || '');
      rules.push({
        id, severity: ['blocking', 'warning', 'suggestion'].includes(cr.severity) ? cr.severity : 'warning',
        category: cr.category || 'quality', title: cr.message || cr.id, docs: true, re,
        files: Array.isArray(cr.files) ? cr.files : null,
        why: cr.why || 'Matches a project-specific rule configured in ShipCheck.', fix: cr.fix || ''
      });
    } catch (e) { /* invalid regex in user config: ignore */ }
  }
  return rules;
}

function ignored(text, prevText, ruleId) {
  const m = text.match(/shipcheck-ignore(?!-next-line)(?:\s*:?\s*([A-Z0-9-]+))?/);
  if (m && (!m[1] || m[1] === ruleId)) return true;
  if (prevText) {
    const p = prevText.match(/shipcheck-ignore-next-line(?:\s*:?\s*([A-Z0-9-]+))?/);
    if (p && (!p[1] || p[1] === ruleId)) return true;
  }
  return false;
}

function scanFile(f, cfg, rules) {
  const out = [];
  const agg = new Map();
  const L = f.added;
  const longOnly = rules.filter((r) => r.id === 'QUAL-LONG-LINE');
  for (let i = 0; i < L.length; i++) {
    const ln = L[i];
    const text = ln.text;
    const next = L[i + 1] && L[i + 1].line === ln.line + 1 ? L[i + 1] : null;
    const prev = L[i - 1] && L[i - 1].line === ln.line - 1 ? L[i - 1] : null;
    let stripped = null;
    const ctx = {
      file: f, path: f.path, lang: f.lang, isTest: f.isTest, isDoc: f.isDoc, cfg, next, prev,
      stripped: () => (stripped === null ? (stripped = U.stripStrings(text)) : stripped)
    };
    const active = text.length > 5000 ? longOnly : rules;
    let secretHit = false;
    for (const r of active) {
      if (r.langs && !r.langs.includes(f.lang)) continue;
      if (r.skipTests && f.isTest) continue;
      if (f.isDoc && !r.docs) continue;
      if (r.pathRe && !r.pathRe.test(f.path)) continue;
      if (r.files && !U.matchesAny(r.files, f.path)) continue;
      if (r.skipComments && isComment(text)) continue;
      let res;
      try { res = r.match ? r.match(text, ctx) : (r.re.test(text) ? true : null); } catch (e) { continue; }
      if (!res) continue;
      if (ignored(text, prev && prev.text, r.id)) continue;
      const sev = (res && res.severity) || r.severity;
      const detail = typeof res === 'string' ? res : (res && res.detail) || '';
      if (r.id.startsWith('SECRET')) secretHit = true;
      const fd = finding({
        ruleId: r.id, severity: sev, category: r.category, title: r.title, detail, file: f.path, line: ln.line,
        snippet: (secretHit ? redact(text) : text).trim().slice(0, 200), why: r.why, fix: r.fix
      });
      if (r.aggregate) {
        const key = r.id + '\u0000' + f.path;
        const a = agg.get(key);
        if (a) a.occurrences.push(ln.line); else { fd.occurrences = [ln.line]; agg.set(key, fd); }
      } else out.push(fd);
    }
  }
  for (const fd of agg.values()) {
    if (fd.occurrences.length > 1) fd.title += ` (${fd.occurrences.length} places)`;
    out.push(fd);
  }
  return out;
}

// ---------------------------------------------------------------- route detection
const ROUTE_RES = [
  { langs: ['js'], re: /\b(?:app|router|server|fastify|\w+Router|\w+Routes)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])([^'"`]+)\2/i, m: 1, p: 3 },
  { langs: ['js'], re: /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/, m: 1, p: 3 },
  { langs: ['py'], re: /@\w+\.(get|post|put|patch|delete|route|head|options)\(\s*(['"])([^'"]+)\2/, m: 1, p: 3 },
  { langs: ['java'], re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*(['"])([^'"]*)\2/, m: 1, p: 3 },
  { langs: ['go'], re: /\b(?:r|e|g|mux|router|app|api|v\d+|group|srv|server|engine|\w+Router|\w+Group)\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*(['"`])([^'"`]+)\2/, m: 1, p: 3 },
  { langs: ['php'], re: /\bRoute::(get|post|put|patch|delete|any)\(\s*(['"])([^'"]+)\2/, m: 1, p: 3 },
  { langs: ['rb'], pathRe: /routes\.rb$/, re: /^\s*(get|post|put|patch|delete)\s+(['"])([^'"]+)\2/, m: 1, p: 3 },
  { langs: ['cs'], re: /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)")?/, m: 1, p: 2 }
];
function extractRoutes(text, lang, filePath) {
  const out = [];
  for (const r of ROUTE_RES) {
    if (!r.langs.includes(lang)) continue;
    if (r.pathRe && !r.pathRe.test(filePath || '')) continue;
    const m = text.match(r.re);
    if (m) out.push({ method: m[r.m].toUpperCase(), path: m[r.p] || '' });
  }
  return out;
}

module.exports = { finding, buildRules, scanFile, extractRoutes, RULES, isComment };
