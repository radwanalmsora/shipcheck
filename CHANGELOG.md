# Changelog

## 1.0.0
- Branch / staged / uncommitted review against an auto-detected base branch
- Blocking / Warning / Suggestion findings with file, line, reason and fix
- Rules: secrets, injection, unsafe APIs, destructive SQL, migrations, dependencies, API routes/exports/signatures, CI & Docker, focused/skipped tests
- Impact map: changed symbols, references, importers, affected endpoints, broken imports
- Missing-test detection with test stubs; project checks runner (lint / types / tests)
- Reversibility assessment and risk score
- PR description generator, Markdown export, optional AI second opinion via the VS Code Language Model API
- Git pre-push guard and standalone CLI
