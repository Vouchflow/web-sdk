# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Enrollment safety: a passkey may exist without this browser's IndexedDB record. Creating another credential with the same WebAuthn user ID can replace the synced passkey and invalidate data encrypted with its PRF. Preserve the recovery-before-create flow in `src/enroll/recover.ts`, `src/core/client.ts`, and the automatic enrollment paths in `src/verify/`.
- Use the scripts in `package.json` for type checking, unit tests, and builds. Recovery regression coverage is in `test/unit/recover.test.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
