# ShipCheck — Pre-PR Code Review

**Don't generate more code. Trust the code you already wrote — before you merge it.**

ShipCheck reviews your *diff* (current branch vs. the base branch, plus staged/uncommitted/new files) and answers the questions you ask before opening a pull request.

| Question | What ShipCheck does |
|---|---|
| Did I break something? | Detects removed/renamed exports, changed signatures, deleted files still imported, removed dependencies still used. Runs your lint / type-check / test commands on demand. |
| Is there a vulnerability or leak? | Secrets & tokens, private keys, `.env` files, SQL/command injection patterns, `eval`, XSS sinks, disabled TLS, weak hashes, CORS `*`, sensitive data in logs… |
| Did API / DB behaviour change? | Added / removed / changed routes (Express, Fastify, NestJS, Flask/FastAPI, Spring, Go, Laravel, Rails, ASP.NET), OpenAPI/proto/GraphQL contracts, destructive SQL, migrations without rollback, schema changes without migration. |
| Are the tests enough? | Finds changed code without tests, tests that were not updated, focused/skipped tests, and generates test stubs. |
| Does it follow project standards? | Your own regex rules (`shipcheck.customRules`), long lines, `any`, suppressed lint, TODOs, localhost URLs… |
| What is affected? | **Impact map**: changed symbols → referencing files, importers, tests to run, endpoints that use the changed code. |
| Can I roll it back? | Reversibility verdict + rollback plan (migrations, lockfiles, infra, breaking API). |

Every finding is **Blocking / Warning / Suggestion**, shows the **exact file and line**, explains **why** it matters and **what to do**. Findings also appear in the Problems panel.

## Features
- **Review before you push** – works on uncommitted work; optional **git pre-push hook** blocks pushes with blocking issues (`git push --no-verify` bypasses).
- **Report panel** + **Activity Bar tree** + **status bar** risk score.
- **PR description generator** – goal, changes by area, impact, risks, test steps, rollback, checklist. Copy or open as Markdown.
- **Optional AI second opinion / AI PR text** through the VS Code Language Model API (e.g. GitHub Copilot). Off unless you run the command; asks before sending the diff.
- **Standalone CLI** (`bin/cli.js`) for CI: `node bin/cli.js --fail-on warning`.
- **Team config** – commit a `.shipcheckrc.json` (same keys as settings, no prefix).
- Suppress a line with a comment: `// shipcheck-ignore` or `// shipcheck-ignore SEC-EVAL`, or `shipcheck-ignore-next-line`.

## Getting started
1. Open a git repository. 2. Run **ShipCheck: Review Changes** (or click the shield in the Activity Bar). 3. Fix blocking items, open **Generate PR Description**.

## Settings
`shipcheck.baseBranch`, `includeUncommitted`, `includeUntracked`, `ignorePaths`, `disabledRules`, `severityOverrides`, `customRules`, `maxLineLength`, `maxFileSizeKB`, `minAddedLinesForTestCheck`, `checkCommands`, `checkTimeoutSec`, `autoReviewOnSave`.

Example `.shipcheckrc.json`:
```json
{
  "baseBranch": "origin/develop",
  "severityOverrides": { "SEC-EVAL": "blocking", "QUAL-TODO": "off" },
  "customRules": [
    { "id": "no-moment", "pattern": "from 'moment'", "severity": "warning", "message": "Use date-fns", "files": ["src/**"] }
  ]
}
```

## Honest limitations
ShipCheck is **static and heuristic** (diff + `git grep`, no type-checker or AST). Reference search is name-based, so very generic names are skipped and some matches can be unrelated. It cannot judge business logic — it complements, not replaces, tests and human review. Running project checks and installing hooks execute commands, so they are disabled in untrusted workspaces. Nothing leaves your machine unless you explicitly run an AI command.

## Privacy
No telemetry. All analysis runs locally using your installed `git`.
