# Security policy

Fletchery is a **prototype**. The smart contracts have **not been audited** and must not be used with real funds.

## Reporting a vulnerability

Email **team@fletchery.pro** with:

- a description of the issue and its impact
- steps to reproduce, or a proof-of-concept test
- the commit you tested against

Please **don't** open a public GitHub issue for security problems. We'll acknowledge your report within 3 working days and keep you updated on the fix.

There is no paid bug bounty yet. We plan to launch one after the external audit, and we'll credit reporters who want to be credited.

## Scope

- Contracts in `contracts/src`
- The engine in `engine/src`, including the broker API

The Uniswap v4-core and forge-std submodules are third-party code; report issues in them to their maintainers.

The known issues and trust assumptions are listed in [docs/security.md](docs/security.md).
