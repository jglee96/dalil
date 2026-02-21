# Dalil Node.js Architecture (MVP)

## 1) Architecture Choice
Dalil is a `Hybrid` product (`CLI + local HTTP Runner`) and now uses a **modular monolith** with feature-first modules.
This fits early-stage product velocity while keeping boundaries explicit for future extraction.
Hexagonal discipline is applied inside the monolith: interfaces in CLI/Runner, use-case logic in feature modules, and persistence in infrastructure.
Dependency assembly is centralized in `/Users/zakklee/dev/dalil/src/main.ts`.

## 2) Directory Tree
```text
src/
  main.ts                          # composition root + CLI transport
  shared/
    constants.ts
    types.ts
    cli-args.ts
    cli-io.ts
    system.ts
    errors/
      cli-error.ts
  infrastructure/
    persistence/
      local-store.ts
  features/
    runner/
      application/
        field-operations.ts
      interface/
        cli/
          runner-commands.ts
          run-tui.ts
        http/
          runner-server.ts
    setup/
      interface/
        cli/
          setup-commands.ts
    vault/
      application/
        profile-extraction.ts
      interface/
        cli/
          vault.command.ts
    suggest/
      application/
        suggestion-generator.ts
      interface/
        cli/
          suggest.command.ts
    apply/
      interface/
        cli/
          apply.command.ts
    history/
      interface/
        cli/
          history.command.ts
    export/
      application/
        export-markdown.use-case.ts
      interface/
        cli/
          export.command.ts
```

## 3) Dependency Rules
- `interface(main CLI/runner)` -> `features(application)` -> `shared(types/constants/errors)`
- `infrastructure(persistence)` can be used by interface/application, but domain rules must not depend on Node process globals directly.
- Feature modules must not import from other feature internals (only stable exports).
- Dependency composition and process lifecycle wiring remain in `/Users/zakklee/dev/dalil/src/main.ts` only.

## 4) OOP/FP Boundaries
- **FP core**: text/profile transforms, citation selection, markdown composition.
- **Imperative shell**: Playwright runner, filesystem persistence, network I/O(OpenAI).
- Use-cases are function-based (thin services), with side effects pushed to outer layers.

## 5) Operational Rules
- Errors are normalized through `CliError` and mapped to fixed exit codes.
- Logging/output is centralized via `shared/cli-io.ts`.
- Config/data-dir resolution is centralized in `infrastructure/persistence/local-store.ts`.
- Secrets are never printed; OpenAI key is only read from local secret store.
- Build gate: `npm run build` must pass before merge.

## 6) Migration Plan
1. Completed: split monolithic helpers into `shared/`, `features/`, `infrastructure/` modules.
2. Completed: moved runner HTTP handlers and page field operations to `features/runner/interface/http` and `features/runner/application`.
3. Completed: split suggest/apply/history CLI commands into `features/*/interface/cli/*.command.ts`.
4. Completed: split setup/vault/export commands from `main.ts` into feature-level command modules.
5. Next: add architecture tests/lint rules for import direction.
6. Later: optional package split (`packages/domain`, `packages/application`, `apps/cli-runner`) when team/scale grows.
