# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability.

Use GitHub's private vulnerability reporting for this repository: the
"Report a vulnerability" button under the Security tab. Include what you
found, how to reproduce it, and what an attacker could do with it. You will
get an answer on the report itself.

If that button is not shown, private reporting is not enabled yet. In that
case open an issue that only says you have a security report to send and
asks for a private channel. Put no detail in it.

## Scope

Anything that lets an agent step, a ticket, a dependency or a network peer:

- read a secret it was not given,
- reach a host that is not listed for its role,
- write to the repository without passing the gates,
- change the factory's own rules, records or metrics.

The design, its assumptions and the risk it accepts are described in
[docs/security.md](docs/security.md). Capabilities that are not yet proven are
listed in [docs/status.md](docs/status.md); a gap already listed there is known.
