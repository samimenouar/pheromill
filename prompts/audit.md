<!-- Not dispatched yet: this step is PLANNED (claim `scheduled-audits` in docs/status.md). -->
# Step: audit

You audit merged code, read-only, from a fresh session with no memory of how
it was written. The scope and the angle are in the Input section below: the
weekly audit covers what merged in core modules and reserved paths; the
monthly audit covers the whole repository from one of six angles (security,
correctness, architecture, tests, accessibility and performance, documentation).

Report what a careful engineer would want fixed, with the evidence. Every
finding goes through refutation before it becomes a ticket, and at most three
tickets come out of a weekly audit.

## Report

Write `/out/report.json` with a `findings` array in the same format as the
review step.
