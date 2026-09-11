# ADR-006 Project Profiles Are Typed TypeScript Modules

- **Status:** Accepted
- **Date:** 2026-09-09
- **Tags:** configuration, dx

## Problem

Each project needs a profile: what it is, what it solves, what to search for, what it is explicitly not for, and the voice its drafts should use. That is configuration, and configuration usually means YAML, TOML, or JSON plus a schema and a parser.

## Decision

A profile is a `.ts` file with a default export. Inside this repository that was `{ ... } satisfies ProjectProfile`; profiles now live in an operator's workspace ([ADR-010](010-engine-and-workspace.md)) and are written `export default defineProject({ ... })`, which checks the same contract from a file the engine's compiler never sees.

The compiler is the validator. A missing field, a typo in a key, or a string where an array belongs is a type error in the editor, before the file is ever loaded — earlier and with a better message than any runtime schema check produces. No parser, no schema definition kept in sync with a type, no dependency.

Since [ADR-010](010-engine-and-workspace.md) that check happens in the workspace rather than in the engine's own `tsc` run, and Obserf executes these modules rather than compiling them, so it cannot assume anyone ran it: `obserf init` scaffolds the `tsconfig.json` and the `typecheck` script that make it available, and the loader additionally checks the fields whose absence would not announce itself — `key`, `name`, `url`, `pitch`, `voice`, `solves`, `notFor`, `queries.search`. Those are prompt text. A profile missing `voice` does not fail; it drafts in no particular voice. That is the failure being caught, and it is why the list stops there instead of growing into the schema this ADR rejects.

This works because profiles are prose and string arrays, not values that need to come from an environment or be edited by a non-programmer. Secrets stay in `.env`, where they can vary per machine; profiles are version-controlled and change through the same review as code, which is right for a file whose contents steer a model.

## Alternatives (brief)

- **TOML or YAML plus Zod** – a schema that duplicates the type, a parse step, a class of runtime errors that the compiler was already positioned to catch, and worse editing (no completion, no jump-to-definition).
- **Rows in the database** – hides the profile from git, which is the wrong place for the text that determines what the model looks for.
- **A single `projects.ts` array** – fine for two projects, worse for six, and turns every profile edit into a diff against one large file.

## Impact

- Positive: autocomplete and type errors while writing a profile; zero configuration dependencies; profiles reviewed as code.
- Negative/Risks: editing a profile means editing TypeScript. For a single-operator tool whose operator writes TypeScript, that is not a cost.

## Links

- Code/Docs: `project.ts`, `projects/`
- Related ADRs: [ADR-007](./007-sources-are-adapters.md)
