# Claude implementation handoff

Read [AGENTS.md](AGENTS.md) first. The MVP must support desktop web and mobile through one responsive, installable PWA; document 12 is mandatory. This is a detailed product implementation assignment, not a request for another plan.

Use [docs/planning/10-claude-execution-prompt.md](docs/planning/10-claude-execution-prompt.md) as the execution brief. Documents 01–12 define the contract; retain stable requirement IDs in implementation evidence. Begin with the release boundary in 01, the invariants in 02 and the architecture in 03. Implement the phases in 06 and prove them with 07. The independent reviewer will apply 08 after implementation.

Do not claim the full 33-module catalogue is implemented: the explicitly deferred modules are visible roadmap entries only. Do not treat mock adapters as real LYPay, ACH, CBL, Temenos, FLEXCUBE, SWIFT or card integrations. Do not build all screens first and defer domain controls until the end. Deliver tested vertical slices with real persistence.

Reasonable implementation choices are authorized within the plan. Record decisions; ask only when a non-inferable choice prevents useful work. Do not stop after scaffolding or the first failing test. Investigate failures and finish the agreed MVP, reporting genuine blockers without fabricating evidence.
