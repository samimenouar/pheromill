# Holdout scenarios

Acceptance scenarios for each ticket live here. They are written by the
specify step from the ticket alone, before any implementation exists.

The agent that implements a ticket never sees this directory: its workspace is
built without it, and its patch is refused if it touches it. Your verify
command must run these scenarios (`scripts/verify.sh` is yours to write): that
is what stops an implementation from being tuned to tests it has read.

The specify step can only add files here. People may add or edit scenarios
through a ticket; a change to an existing scenario is HIGH risk and gets a
dedicated review.
