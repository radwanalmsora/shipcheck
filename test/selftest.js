'use strict';
// End-to-end self test: builds a throw-away git repo, makes risky changes, and checks that ShipCheck reports them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { analyze } = require('../src/core');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipcheck-'));
const sh = (c) => cp.execSync(c, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };

sh('git init -q -b main');
w('package.json', JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodash: '^3.0.0', leftpad: '1.0.0' } }, null, 2));
w('package-lock.json', '{}');
w('src/util.js', 'export function formatPrice(value, currency) {\n  return value + currency;\n}\nexport function oldHelper() { return 1; }\n');
w('src/old.js', 'export const legacy = 1;\n');
w('src/app.js', "import { formatPrice } from './util';\nimport { legacy } from './old';\nconst express = require('express');\nconst app = express();\napp.get('/api/users', (req, res) => res.json(formatPrice(1, '$')));\napp.delete('/api/users/:id', (req, res) => res.end());\nmodule.exports = app;\n");
w('src/use-leftpad.js', "const pad = require('leftpad');\nmodule.exports = pad;\n");
w('test/util.test.js', "import { formatPrice } from '../src/util';\ntest('x', () => expect(formatPrice(1,'$')).toBe('1$'));\n");
w('db/migrations/001_init.sql', 'CREATE TABLE users (id int);\n-- migrate:down\nDROP TABLE users;\n');
sh('git add -A && git commit -q -m init');
sh('git checkout -q -b feature/risky');

w('package.json', JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { lodash: '^4.0.0', 'left-pad-ng': '*' } }, null, 2));
w('src/util.js', 'export function formatPrice(value, currency, locale) {\n  if (!currency) throw new Error("x");\n  return value + currency;\n}\n'
  + 'export function computeTax(amount, region) {\n  if (amount < 0) { throw new Error("neg"); }\n  if (region === "EU") { return amount * 0.2; }\n  if (region === "US") { return amount * 0.1; }\n  switch (region) { case "UK": return amount * 0.2; default: return 0; }\n}\n'
  + 'export function computeDiscount(a, b) {\n  return a - b;\n}\n');
sh('git rm -q src/old.js');
w('src/app.js', "import { formatPrice } from './util';\nimport { legacy } from './old';\nconst express = require('express');\nconst app = express();\napp.get('/api/v2/users', (req, res) => res.json(formatPrice(1, '$')));\napp.post('/api/orders', (req, res) => res.json({}));\nconst API_KEY = 'sk_live_4eC39HqLyjWDarjtT1zdp7dcXYZ123';\nconst password = 'Tr0ub4dor&3xK9qZ';\nconsole.log('password', password);\nconst q = `SELECT * FROM users WHERE id = ${req.params.id}`;\nmodule.exports = app;\n");
w('src/app.test.js', "describe.only('a', () => { it('b', () => {}); });\n");
w('db/migrations/002_drop.sql', 'ALTER TABLE users DROP COLUMN email;\nTRUNCATE TABLE sessions;\n');
w('.env', 'DB=postgres://admin:S3cr3tPassw0rd@db.example.com:5432/app\n');
w('src/pricing.js', Array.from({length: 14}, (_, i) => `export function rule${i}(x) {\n  return x + ${i};\n}`).join('\n') + '\n');
w('src/cfg.js', 'const k = process.env.NEW_REQUIRED_TOKEN_X;\nmodule.exports = k;\n');
sh('git add -A && git commit -q -m "risky change"');
w('src/untracked.js', 'debugger;\nconst x = 1;   \n');

const a = analyze(dir, {}, { scope: 'branch' });
const ids = new Set(a.findings.map((f) => f.ruleId));
const expect = [
  'SECRET-PROVIDER-TOKEN', 'SECRET-GENERIC', 'SEC-SENSITIVE-LOG', 'SEC-SQL-INJECTION', 'TEST-FOCUSED', 'DB-DESTRUCTIVE', 'SEC-ENV-FILE',
  'SECRET-DB-URL', 'DEP-LOCK-MISSING', 'DEP-MAJOR-BUMP', 'DEP-UNPINNED', 'DEP-REMOVED-IN-USE', 'IMPORT-BROKEN',
  'API-ROUTE-CHANGED', 'API-ROUTE-ADDED', 'API-SIGNATURE-CHANGED', 'TEST-NOT-UPDATED', 'TEST-MISSING', 'DB-NO-ROLLBACK', 'CFG-NEW-ENV', 'QUAL-DEBUGGER'
];
let bad = 0;
for (const id of expect) { if (!ids.has(id)) { console.log('MISSING', id); bad++; } }
console.log(`findings=${a.findings.length} blocking=${a.stats.bySeverity.blocking} warning=${a.stats.bySeverity.warning} suggestion=${a.stats.bySeverity.suggestion} risk=${a.risk.score}/${a.risk.label} rev=${a.reversibility.verdict} files=${a.stats.files} ${a.meta.durationMs}ms`);
console.log([...ids].sort().join(', '));
const secretLeak = JSON.stringify(a).includes('4eC39HqLyjWDarjtT1zdp7dcXYZ123') || JSON.stringify(a).includes('Tr0ub4dor&3xK9qZ');
if (secretLeak) { console.log('SECRET LEAKED IN REPORT'); bad++; }
fs.rmSync(dir, { recursive: true, force: true });
if (bad) { console.log('SELFTEST FAILED'); process.exit(1); }
console.log('SELFTEST OK');
