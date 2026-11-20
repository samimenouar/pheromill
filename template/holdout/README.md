# Holdout scenarios

Acceptance scenarios for each ticket live here. They are written by the
specify step from the ticket alone, before any implementation exists.

The agent that implements a ticket never sees this directory: its workspace is
built without it, and its patch is refused if it touches it. Your verify
command must run these scenarios (`scripts/verify.sh` is yours to write): that
is what stops an implementation from being tuned to tests it has read.

The specify step can only add files here, and no step of the factory can
change an existing scenario. Correcting one is a person's change request; it
is HIGH risk like any change to an existing test.
