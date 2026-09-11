# Security

## Reporting

Report a vulnerability privately through [GitHub's advisory form](https://github.com/kriasoft/obserf/security/advisories/new). Please do not open a public issue for one. This is a single-maintainer project; expect a first reply within a week.

## What is in scope

Obserf runs on one person's machine, holds their credentials, and feeds text from the open web into a model. The things most worth reporting:

- **A way to make Obserf post, write to a venue, or take any action outside the local machine.** It has no such code path by design ([ADR-005](docs/adr/005-obserf-drafts-humans-post.md)). A way to create one is the most serious bug this project can have.
- **A prompt injection that changes what Obserf does**, rather than only what it concludes. Candidate text is untrusted and goes into the prompt directly; the defense is that the model is given no tools at all, so a successful injection should be able to produce a wrong assessment or a bad draft and nothing more. Anything that escapes that is in scope.
- **Exposure of a credential or of the operator's data** — the borrowed `gh` token, `BRAVE_API_KEY`, `REDDIT_CLIENT_*`, the database, or anything that leaks them into a prompt, a log, a snapshot, or the published package.
- **Reaching the review inbox from outside the machine.** It is unauthenticated and bound to `127.0.0.1`; a way around that, including DNS rebinding, is in scope.

## What is not

A model producing a wrong, useless, or embarrassing assessment or draft is a quality problem, not a vulnerability — the operator reads and edits everything before it is posted, which is the point of the design. Third-party service outages, rate limits, and policy changes are operational, not security.

## Supported versions

The latest release only. Obserf is pre-1.0 and fixes go forward.
