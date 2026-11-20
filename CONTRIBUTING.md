# Contributing

Pheromill is built under its own rules. They apply to people and agents alike.

1. Work starts from a ticket: one thing a user can see or test, 1 to 5 points,
   with acceptance criteria and likely files. Use the ticket form.
2. Read [AGENTS.md](AGENTS.md). It is short and it is enforced.
3. Run `node scripts/verify.js` before you push. CI runs that command, plus
   the container tests in `integration/`, which need Docker.
4. Keep a change under 400 lines and do not touch an existing test to make it
   pass. If a test is wrong, say why in the change description.
5. A new capability comes with its claim in `proofs/registry.json`; then run
   `node bin/pheromill.js proofs render`.
6. A change to how the factory works is recorded in
   [docs/decisions.md](docs/decisions.md): what, why, benefit, risk.

Everything is written in English, and a change needs both CI jobs green
before it merges.

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
