# Products built by the factory

What the factory requires of every product, and how a product starts.

## Standards every product meets

Users and administrators are assumed to have no technical background.

| Area | Requirement | Enforced by |
| --- | --- | --- |
| Engineering | Test first, domain-driven and hexagonal design, SOLID, clean code, twelve-factor, trunk-based development | `AGENTS.md` and review; the layer check once layers are declared in the configuration |
| Accessibility | WCAG 2.2 AA | The product's verify command |
| Devices | Equally usable on mobile and desktop | The product's verify command |
| Search | Unique titles and descriptions, semantic structure, fast pages | The product's verify command |
| Simplicity | Every screen is obvious without training | Review against the acceptance criteria |
| Measurement | Page load, errors, availability, customer journey, adoption, conversion, each step of the funnel; behaviour behind flags for A/B tests | Review; a monitoring contract (planned) |
| Honesty | No invented fact; missing information is marked provisional and cannot ship | `pheromill check --production`, called from the verify command |
| Decisions | Each significant choice is recorded and reversible | `docs/decisions/` in the product |
| Language | English only, written as if public | `pheromill check`, called from the verify command |

The honesty check finds what was marked provisional. A fact that was invented
and not marked is caught only by review.

The rules are in the template `AGENTS.md` today. The template's verify command
is a stub that fails until the product defines it: each product wires its own
tools, and the two `pheromill check` calls, into it. Reference gate scripts
for accessibility, search and performance are planned.

## From an idea to a backlog (planned)

The target is a product started from a short prompt and a few questions, with
a human free to step in at any point and to reverse any decision.

```mermaid
flowchart LR
  P[Prompt and a few questions] --> B[Project brief]
  B --> A[Target audience]
  A --> BB[Brand book]
  BB --> L[Logo and visual direction]
  L --> DS[Design system]
  DS --> M[Milestones and backlog]
  M --> ST[Technical stack]
  ST --> MR[Monorepo scaffold]
  MR --> T[Tickets for the factory]
```

Each step will be an ordinary factory step: a role, a prompt, an output with a
schema, a decision record with the alternatives considered. The brand book is
written for the audience defined just before it, and it is the input of the
design system, so that adoption and conversion are designed in rather than
added later. Tickets produced at the end follow the same form as any other.

This workflow is designed and not built. The pipeline that executes tickets
does not depend on it.
