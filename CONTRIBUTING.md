# Contributing

Thanks for your interest in Fletchery. Issues, questions and pull requests are welcome.

## Before you start

- **Security issues:** please don't open a public issue. Email team@fletchery.pro (see [SECURITY.md](SECURITY.md)).
- **Bigger changes:** open an issue first so we can agree the approach.
- **Licence:** the code is under the [Business Source License 1.1](LICENSE). By contributing, you agree your contribution is licensed under the same terms.

## Development

```bash
git clone --recursive https://github.com/Fletchery-Pro/Fletchery.git
cd Fletchery
./scripts/setup.sh
./scripts/test-all.sh
```

See [Getting started](docs/getting-started.md) for details.

## Guidelines

- **Keep every test green:** `forge test`, `npm test` in `engine/` and `./scripts/e2e.sh`.
- **Add a test for any new rule or behaviour.** A rule that can stop a trade should be tested in the contracts (both token orderings run automatically) and, if the engine mirrors it, in the engine too.
- **Keep the on-chain and off-chain rules in step.** If you change a check in a contract, change its mirror in the engine (for example `AgentMandates.sol` ↔ `mandates.ts`, `FairValueOracle` ↔ `BAND_POLICY`).
- **Engine:** no runtime dependencies, and erasable TypeScript syntax only, so Node can run the files directly. That means no enums and no parameter properties.
- **Contracts:** keep modules small and single-purpose; use custom errors with useful arguments; fail closed.
- **Docs:** update `docs/` when behaviour changes. Use plain English.
- **Data:** don't add real venue names, real customer data or real keys. Example data must be clearly simulated.

## Commit messages

Use a short summary line in the imperative ("Add shared cap metering for affiliated venues"), then a blank line and any detail.
