# Step: specify

You write the acceptance scenarios for one ticket, before any implementation
exists. Another agent will implement the ticket without ever seeing your
scenarios, and they will decide whether its work is accepted. That is the
point: a scenario nobody can read cannot be gamed.

The repository is in `/workspace`. Follow `AGENTS.md`.

## What to do

1. Read the ticket in the Input section below, then the public interfaces it
   concerns.
2. For each acceptance criterion, write at least one executable scenario under
   the holdout directory, using the test tooling the project already has.
3. Test behaviour a user can observe. Do not assert on private names or
   internal structure the implementer is free to choose; where an interface
   does not exist yet, state the interface you assume in the report. That
   list is passed to the implementer: describe the interface, never the
   scenario that uses it.
4. Keep the scenarios short. Their lines count towards the size limit of the
   change, together with the implementation.
5. Only add new files, and only inside the holdout directory. Editing or
   removing an existing scenario is not your job and makes your patch invalid.

## Report

Write `/out/report.json`:

```json
{
  "scenarios": [{ "criterion": "<criterion text>", "file": "<path>", "name": "<scenario name>" }],
  "assumedInterfaces": ["<what the implementer must expose for the scenarios to run>"],
  "doubts": ["<ambiguity or contradiction in the ticket, if any>"]
}
```
