'use strict';
const path = require('path');
const U = require('./util');
const G = require('./git');
const { finding, extractRoutes } = require('./rules');
const S = require('./symbols');

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;
const major = (v) => { const m = String(v || '').match(SEMVER) || String(v || '').match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return {}; } };
const dirOf = (p) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));

// ------------------------------------------------------------------ dependencies
function deps(ctx, out) {
  const changed = new Set(ctx.all.map((f) => f.path));
  const tracked = ctx.tracked();
  const manifests = ctx.all.filter((f) => /(^|\/)package\.json$/.test(f.path) && f.status !== 'deleted' && !/node_modules/.test(f.path));
  ctx.depChanges = [];

  for (const f of manifests) {
    const oldJ = f.status === 'added' ? {} : safeJson(ctx.readOld(f.oldPath || f.path) || '{}');
    const newJ = safeJson(ctx.readNew(f.path) || '{}');
    let depChanged = false;
    for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const a = oldJ[sec] || {}; const b = newJ[sec] || {};
      for (const name of Object.keys(b)) {
        if (!(name in a)) {
          depChanged = true;
          ctx.depChanges.push({ file: f.path, section: sec, name, to: b[name], kind: 'added' });
          const unpinned = /^(\*|latest|next|x)$/i.test(b[name]) || /^(git|http|github:|file:)/i.test(b[name]);
          out.push(finding({
            ruleId: unpinned ? 'DEP-UNPINNED' : 'DEP-NEW', severity: unpinned ? 'warning' : 'suggestion', category: 'deps',
            title: `New ${sec === 'dependencies' ? 'runtime ' : ''}dependency: ${name}@${b[name]}`, file: f.path, line: 0,
            why: unpinned ? 'An unpinned or non-registry version makes builds non-reproducible and is a supply-chain risk.'
              : 'Every new dependency adds attack surface, bundle size, licence obligations and maintenance cost.',
            fix: unpinned ? 'Pin an exact or caret version from the registry.' : 'Confirm the licence, maintenance status and that no existing dependency already covers this.'
          }));
        } else if (a[name] !== b[name]) {
          depChanged = true;
          ctx.depChanges.push({ file: f.path, section: sec, name, from: a[name], to: b[name], kind: 'changed' });
          const ma = major(a[name]); const mb = major(b[name]);
          if (ma != null && mb != null && mb > ma) {
            out.push(finding({
              ruleId: 'DEP-MAJOR-BUMP', severity: 'warning', category: 'deps', title: `Major version bump: ${name} ${a[name]} → ${b[name]}`, file: f.path,
              why: 'Major releases may contain breaking API changes.', fix: 'Read the changelog/migration guide and run the full test-suite.'
            }));
          } else if (ma != null && mb != null && mb < ma) {
            out.push(finding({
              ruleId: 'DEP-DOWNGRADE', severity: 'suggestion', category: 'deps', title: `Dependency downgraded: ${name} ${a[name]} → ${b[name]}`, file: f.path,
              why: 'Downgrades can reintroduce fixed bugs or vulnerabilities.', fix: 'Confirm the downgrade is intentional.'
            }));
          }
        }
      }
      for (const name of Object.keys(a)) {
        if (name in b) continue;
        depChanged = true;
        ctx.depChanges.push({ file: f.path, section: sec, name, from: a[name], kind: 'removed' });
        const esc = U.escapeRe(name);
        const hits = G.grepCount(ctx.root, `(from|require\\(|import)[[:space:]]*\\(?['"]${esc}(/[^'"]*)?['"]`, 'regex')
          .filter((h) => !U.isTestFile(h.path) || true)
          .filter((h) => !/package(-lock)?\.json$|\.md$/.test(h.path));
        if (hits.length) {
          out.push(finding({
            ruleId: 'DEP-REMOVED-IN-USE', severity: 'blocking', category: 'deps', title: `Dependency "${name}" removed but still imported`, file: f.path,
            detail: hits.slice(0, 5).map((h) => h.path).join(', '),
            why: 'Code still imports this package, so builds or runtime will fail with "module not found".', fix: 'Restore the dependency or remove the remaining imports.'
          }));
        }
      }
    }
    // install scripts
    const os = oldJ.scripts || {}; const ns = newJ.scripts || {};
    for (const k of ['preinstall', 'install', 'postinstall']) {
      if (ns[k] && ns[k] !== os[k]) {
        out.push(finding({
          ruleId: 'DEP-INSTALL-SCRIPT', severity: 'warning', category: 'deps', title: `package.json adds/changes "${k}" script`, file: f.path, detail: ns[k],
          why: 'Install scripts run on every consumer machine and CI runner.', fix: 'Make sure this is intentional and does not download or execute remote code.'
        }));
      }
    }
    if (depChanged) {
      const dir = dirOf(f.path);
      const locks = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json'].map((l) => (dir ? dir + '/' : '') + l);
      const existing = locks.filter((l) => tracked.has(l));
      if (existing.length && !existing.some((l) => changed.has(l))) {
        out.push(finding({
          ruleId: 'DEP-LOCK-MISSING', severity: 'warning', category: 'deps', title: 'Dependencies changed but the lockfile did not', file: f.path,
          why: 'CI and teammates will resolve different versions than you tested with.', fix: `Run your package manager install and commit ${existing[0]}.`
        }));
      }
    }
  }
  // lockfile changed without manifest
  for (const f of ctx.all) {
    if (!U.LOCK_RE.test(f.path) || f.status === 'deleted') continue;
    if (/(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f.path)) {
      const dir = dirOf(f.path);
      const man = (dir ? dir + '/' : '') + 'package.json';
      if (!changed.has(man)) {
        out.push(finding({
          ruleId: 'DEP-LOCK-ONLY', severity: 'warning', category: 'deps', title: 'Lockfile changed without a manifest change', file: f.path,
          why: 'Usually an accidental `install` or a silent transitive upgrade that nobody reviewed.', fix: 'Revert the lockfile, or explain the upgrade in the PR description.'
        }));
      }
    }
  }
  // other ecosystems: one summary suggestion per manifest
  for (const f of ctx.all) {
    if (!U.DEPS_RE.test(f.path) || U.LOCK_RE.test(f.path) || /(^|\/)package\.json$/.test(f.path) || f.status === 'deleted' || f.binary) continue;
    const add = f.added.filter((l) => l.text.trim() && !/^\s*(#|\/\/)/.test(l.text)).length;
    const rem = f.removed.length;
    if (add + rem) {
      ctx.depChanges.push({ file: f.path, kind: 'manifest', added: add, removed: rem });
      out.push(finding({
        ruleId: 'DEP-MANIFEST-CHANGED', severity: 'suggestion', category: 'deps', title: `Dependency manifest changed (+${add} / −${rem} lines)`, file: f.path,
        why: 'Dependency changes alter what ships to production.', fix: 'Review versions and licences of the changed entries.'
      }));
    }
  }
}

// ------------------------------------------------------------------ database
function database(ctx, out) {
  const changedPaths = ctx.all.map((f) => f.path);
  const hasMigration = changedPaths.some((p) => U.MIGRATION_RE.test(p) || /prisma\/migrations\//.test(p));
  ctx.migrations = [];
  for (const f of ctx.all) {
    if (f.status === 'deleted' || f.binary) continue;
    const isMig = U.MIGRATION_RE.test(f.path) || /prisma\/migrations\//.test(f.path);
    if (isMig) {
      ctx.migrations.push({ file: f.path, status: f.status });
      if (f.status === 'modified' || f.status === 'renamed') {
        out.push(finding({
          ruleId: 'DB-MIGRATION-EDITED', severity: 'warning', category: 'database', title: 'Existing migration was edited', file: f.path,
          why: 'Environments that already applied this migration will not pick up the change, so schemas drift apart.',
          fix: 'Leave applied migrations immutable and add a new migration instead.'
        }));
      }
      if (f.status === 'added' && !/prisma\/migrations\//.test(f.path)) {
        const content = ctx.readNew(f.path) || '';
        const reversible = /\b(down|downgrade|rollback|revert|undo)\b/i.test(content) || /def\s+change\b/.test(content) ||
          /class\s+Migration\(migrations\.Migration\)/.test(content);
        if (!reversible) {
          out.push(finding({
            ruleId: 'DB-NO-ROLLBACK', severity: 'warning', category: 'database', title: 'New migration has no rollback / down step', file: f.path,
            why: 'If the release must be rolled back, the schema cannot be reverted automatically.', fix: 'Add a down/rollback migration, or document the manual rollback.'
          }));
        }
        if (/RunPython\(/.test(content) && !/reverse_code|noop/.test(content)) {
          out.push(finding({
            ruleId: 'DB-IRREVERSIBLE', severity: 'warning', category: 'database', title: 'RunPython without reverse_code', file: f.path,
            why: 'This migration cannot be unapplied.', fix: 'Pass reverse_code (or migrations.RunPython.noop).'
          }));
        }
      }
    } else if (f.kind === 'source' && /(^|\/)(models?|entities|schema)(\/|\.|_)/i.test(f.path) && /\.(py|ts|js|rb|java|kt|cs)$/.test(f.path) && !f.isTest && !hasMigration) {
      const touches = f.added.some((l) => /\b(Column|Field|ForeignKey|@Column|@Entity|DataTypes\.|belongs_to|has_many|t\.\w+\s*:|models\.\w+Field)\b/.test(l.text));
      if (touches) {
        out.push(finding({
          ruleId: 'DB-SCHEMA-NO-MIGRATION', severity: 'warning', category: 'database', title: 'Model/schema changed but no migration is included', file: f.path,
          why: 'The code expects a schema the database does not have yet.', fix: 'Generate and commit a migration for this change.'
        }));
      }
    }
    if (/schema\.prisma$/.test(f.path) && !hasMigration && (f.added.length || f.removed.length)) {
      out.push(finding({
        ruleId: 'DB-SCHEMA-NO-MIGRATION', severity: 'warning', category: 'database', title: 'schema.prisma changed without a migration', file: f.path,
        why: 'The Prisma client no longer matches the database.', fix: 'Run `prisma migrate dev` and commit prisma/migrations.'
      }));
    }
  }
}

// ------------------------------------------------------------------ API contracts, routes, exports
const CONTRACT_RE = /(^|\/)(openapi|swagger|asyncapi)[\w.-]*\.(ya?ml|json)$|\.(proto|graphqls?|gql|avsc)$/i;
const AUTH_HINT = /auth|login_required|permission|guard|protect|jwt|session|policy|authorize|requireUser|isAdmin/i;

function api(ctx, out) {
  ctx.api = { routesAdded: [], routesRemoved: [], exportsRemoved: [], signatureChanged: [], exportsAdded: [] };
  for (const f of ctx.all) {
    if (f.binary) continue;
    // contracts
    if (CONTRACT_RE.test(f.path)) {
      const rem = f.removed.filter((l) => l.text.trim() && !/^\s*(#|\/\/)/.test(l.text));
      if (/\.proto$/i.test(f.path)) {
        const num = (t) => { const m = t.match(/(\w+)\s*=\s*(\d+)\s*[;[]/); return m ? { name: m[1], n: m[2] } : null; };
        const added = f.added.map((l) => num(l.text)).filter(Boolean);
        for (const r of rem.map((l) => num(l.text)).filter(Boolean)) {
          const reuse = added.find((a) => a.n === r.n && a.name !== r.name);
          const kept = added.find((a) => a.n === r.n && a.name === r.name);
          if (reuse) {
            out.push(finding({
              ruleId: 'API-PROTO-FIELD-REUSED', severity: 'blocking', category: 'api', title: `Protobuf field number ${r.n} reused (${r.name} → ${reuse.name})`, file: f.path,
              why: 'Reusing a field number corrupts data read by older clients/servers.', fix: 'Reserve the old number and use a new one.'
            }));
          } else if (!kept) {
            out.push(finding({
              ruleId: 'API-PROTO-FIELD-REMOVED', severity: 'warning', category: 'api', title: `Protobuf field ${r.name} = ${r.n} removed`, file: f.path,
              why: 'Old messages still contain this field and the number may get reused later.', fix: `Add \`reserved ${r.n};\` instead of deleting silently.`
            }));
          }
        }
      }
      if (f.added.length || f.removed.length) {
        out.push(finding({
          ruleId: rem.length ? 'API-CONTRACT-BREAKING' : 'API-CONTRACT-CHANGED', severity: rem.length ? 'warning' : 'suggestion', category: 'api',
          title: rem.length ? `API contract lost ${rem.length} line(s) — possible breaking change` : 'API contract file changed', file: f.path,
          line: (rem.length ? 0 : (f.added[0] && f.added[0].line) || 0),
          why: rem.length ? 'Removing or renaming fields/endpoints breaks existing clients.' : 'Generated clients, docs and consumers may need regeneration.',
          fix: 'Verify backward compatibility, version the API if needed, and regenerate clients.'
        }));
      }
      continue;
    }
    if (f.kind !== 'source' || f.isTest) continue;

    // routes
    const rAdded = []; const rRemoved = [];
    for (const l of f.added) for (const r of extractRoutes(l.text, f.lang, f.path)) rAdded.push({ ...r, file: f.path, line: l.line, text: l.text });
    for (const l of f.removed) for (const r of extractRoutes(l.text, f.lang, f.path)) rRemoved.push({ ...r, file: f.path, line: l.line });
    const key = (r) => r.method + ' ' + r.path;
    const addedKeys = new Set(rAdded.map(key)); const removedKeys = new Set(rRemoved.map(key));
    for (const r of rRemoved) {
      if (addedKeys.has(key(r))) continue;
      const similar = rAdded.find((a) => a.method === r.method && !removedKeys.has(key(a)));
      ctx.api.routesRemoved.push(r);
      out.push(finding({
        ruleId: 'API-ROUTE-CHANGED', severity: 'warning', category: 'api', file: f.path, line: Math.min(r.line, 1e9),
        title: similar ? `Endpoint changed: ${r.method} ${r.path} → ${similar.path}` : `Endpoint removed: ${r.method} ${r.path}`,
        why: 'Clients calling the old route will start receiving 404s.', fix: 'Keep the old route (redirect/deprecate) until all consumers migrate, or ship a versioned route.'
      }));
    }
    for (const r of rAdded) {
      if (removedKeys.has(key(r))) continue;
      ctx.api.routesAdded.push(r);
      out.push(finding({
        ruleId: 'API-ROUTE-ADDED', severity: 'suggestion', category: 'api', file: f.path, line: r.line,
        title: `New endpoint: ${r.method} ${r.path}`, snippet: r.text.trim().slice(0, 160),
        detail: AUTH_HINT.test(r.text) ? '' : 'no authentication/authorisation visible on this line',
        why: 'New endpoints are new attack surface and new contract to maintain.', fix: 'Confirm auth, input validation, rate limits, tests and docs.'
      }));
    }

    // exports
    const exp = (lines) => { const m = new Map(); for (const l of lines) for (const e of S.exportsInLine(l.text, f.lang)) m.set(e.name, { ...e, line: l.line }); return m; };
    const oldE = exp(f.removed); const newE = exp(f.added);
    for (const [name, e] of newE) if (!oldE.has(name)) ctx.api.exportsAdded.push({ name, file: f.path, line: e.line, kind: e.kind, params: e.params });
    for (const [name, e] of oldE) {
      const n = newE.get(name);
      if (!n) {
        ctx.api.exportsRemoved.push({ name, file: f.path, line: e.line, kind: e.kind, deletedFile: f.status === 'deleted' });
      } else if (e.params != null && n.params != null) {
        const cmp = S.compareParams(e.params, n.params);
        if (cmp !== 'same') {
          ctx.api.signatureChanged.push({ name, file: f.path, line: n.line, from: e.params, to: n.params, compat: cmp });
          out.push(finding({
            ruleId: cmp === 'breaking' ? 'API-SIGNATURE-CHANGED' : 'API-SIGNATURE-EXTENDED', severity: cmp === 'breaking' ? 'warning' : 'suggestion', category: 'api',
            title: `${cmp === 'breaking' ? 'Signature changed' : 'Signature extended'}: ${name}(${n.params.trim()})`, file: f.path, line: n.line,
            detail: `was ${name}(${e.params.trim()})`,
            why: cmp === 'breaking' ? 'Existing callers pass arguments in the old shape.' : 'Only optional parameters were added — callers keep working.',
            fix: cmp === 'breaking' ? 'Update every caller (see Impact map) or keep a backward-compatible overload.' : ''
          }));
        }
      }
    }
  }
}

// ------------------------------------------------------------------ files: env, keys, size, infra, env vars
function files(ctx, out) {
  const infra = [];
  for (const f of ctx.all) {
    if (f.status === 'deleted') continue;
    const base = path.posix.basename(f.path);
    if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template|dist|defaults?)$/i.test(base)) {
      out.push(finding({
        ruleId: 'SEC-ENV-FILE', severity: 'blocking', category: 'security', title: `Environment file committed: ${base}`, file: f.path,
        why: '.env files usually hold real credentials, and git history keeps them forever.', fix: 'Remove it from git (`git rm --cached`), add it to .gitignore and rotate any secret it contained.'
      }));
    }
    if (/\.(pem|p12|pfx|jks|keystore)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) {
      out.push(finding({
        ruleId: 'SEC-KEY-FILE', severity: 'blocking', category: 'security', title: `Key/certificate file committed: ${base}`, file: f.path,
        why: 'Key material in a repository must be considered compromised.', fix: 'Remove it, rotate the key, and load it from a secret store.'
      }));
    }
    const kb = ctx.sizeKB(f.path);
    if (kb != null && !U.LOCK_RE.test(f.path) && (f.status === 'added' || f.status === 'untracked' || f.additions > 0 || f.binary)) {
      if (kb > ctx.cfg.maxFileSizeKB) {
        out.push(finding({
          ruleId: 'FILE-LARGE', severity: 'warning', category: 'quality', title: `Large file added/changed (${Math.round(kb)} KB)`, file: f.path,
          why: 'Large files bloat the repository forever (history is never shrunk by later deletes).', fix: 'Use Git LFS or an artifact store.'
        }));
      } else if (f.binary && f.status === 'added' && kb > 200 && !/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(f.path)) {
        out.push(finding({
          ruleId: 'FILE-BINARY', severity: 'suggestion', category: 'quality', title: `Binary file added (${Math.round(kb)} KB)`, file: f.path,
          why: 'Binary files cannot be reviewed in a diff.', fix: 'Confirm it needs to live in the repo.'
        }));
      }
    }
    if (f.kind === 'ci') infra.push(f.path);
  }
  if (infra.length) {
    out.push(finding({
      ruleId: 'INFRA-CHANGED', severity: 'suggestion', category: 'infra', title: `Build/deploy configuration changed (${infra.length} file${infra.length > 1 ? 's' : ''})`,
      file: infra[0], detail: infra.slice(0, 6).join(', '),
      why: 'Pipeline or infrastructure changes can only be fully verified by running them.', fix: 'Run the pipeline on this branch before merging and plan how to roll it back.'
    }));
  }
  // new environment variables
  const envRe = /process\.env\.([A-Z][A-Z0-9_]{2,})|process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]|os\.environ(?:\.get)?[(\[]\s*['"]([A-Z][A-Z0-9_]{2,})['"]|os\.Getenv\("([A-Z][A-Z0-9_]{2,})"\)|System\.getenv\("([A-Z][A-Z0-9_]{2,})"\)|ENV\[['"]([A-Z][A-Z0-9_]{2,})['"]\]|getenv\(['"]([A-Z][A-Z0-9_]{2,})['"]\)/;
  const vars = new Map();
  for (const f of ctx.all) {
    if (f.kind !== 'source' || f.isTest) continue;
    for (const l of f.added) {
      const m = l.text.match(envRe);
      if (m) { const name = m.slice(1).find(Boolean); if (name && !vars.has(name)) vars.set(name, { file: f.path, line: l.line }); }
    }
  }
  const docText = ctx.all.filter((f) => f.kind !== 'source' || f.isTest).map((f) => f.added.map((l) => l.text).join('\n')).join('\n');
  const undocumented = [...vars.entries()].filter(([n]) => !docText.includes(n) && !['NODE_ENV', 'PATH', 'HOME', 'CI', 'DEBUG', 'TZ', 'PORT'].includes(n));
  if (undocumented.length) {
    const [n0, loc] = undocumented[0];
    out.push(finding({
      ruleId: 'CFG-NEW-ENV', severity: 'suggestion', category: 'infra', file: loc.file, line: loc.line,
      title: `New environment variable${undocumented.length > 1 ? 's' : ''}: ${undocumented.map(([n]) => n).slice(0, 6).join(', ')}`,
      why: 'Deploying without the variable breaks startup or silently changes behaviour.', fix: 'Add it to .env.example / docs / deployment config and give it a safe default or fail fast.'
    }));
    ctx.newEnvVars = undocumented.map(([n]) => n);
  }
}

function run(ctx) {
  const out = [];
  for (const fn of [deps, database, api, files]) {
    try { fn(ctx, out); } catch (e) { ctx.warnings.push(`${fn.name} analyzer failed: ${e.message}`); }
  }
  return out;
}

module.exports = { run };
