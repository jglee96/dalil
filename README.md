# Dalil (MVP v0.1)

Dalil is a local-first CLI + Runner that drafts and fills `input`/`textarea` fields on application pages.

## Scope

- Draft + insert text only
- No navigation
- No submit actions
- Local-only persistence under a user-selected data directory

## Quick start

```bash
npm install
npm run build
node dist/main.js init --data-dir /absolute/path/to/dalil-data
node dist/main.js config set openai.key
node dist/main.js run --mode managed
```

From another terminal:

```bash
node dist/main.js fields list
node dist/main.js suggest <fieldId> --variant standard --lang ko
node dist/main.js apply <fieldId> --suggestion <suggestionId>
```

## Notes

- `run` requires Playwright (`npm i playwright`) for live browser operations.
- DOCX export/import relies on macOS `textutil` when available.
- PDF export is generated locally without third-party services.
