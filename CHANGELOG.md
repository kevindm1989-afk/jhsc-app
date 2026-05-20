# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Automated token-consumption gate** (`scripts/token-audit.sh`). Greps
  source for raw hex / rgb / hsl colors, inline px/rem styles in
  `style={{...}}`, `outline: none` without replacement, and `!important`.
  Wired into `scripts/verify.sh` as Tier 1. Auto-skips when no UI source
  dirs exist; override with `TOKEN_AUDIT_SKIP=1` (the override is
  surfaced loudly by the verifier).
- **Expanded `design-tokens.json` scaffolding**: light + dark modes,
  density (comfortable / compact), layout grid (max-widths, gutters,
  columns per breakpoint), z-index layers, typography tracking,
  display family, focus-ring color, selection color, touch-target
  minimum, and a `components` block where every required component
  starts as `TO BE SET` so the designer has somewhere to put output.

### Changed
- **All 31 agents tightened to a consistent shape**: discovery →
  process → self-validation → explicit handoffs → hard rules →
  anti-patterns → output format → stop conditions. Behaviour is now
  predictable and cross-references between agents are load-bearing
  rather than aspirational.
- **Cross-agent enforcement**: test-writer refuses vague acceptance
  criteria and returns to architect; implementer refuses missing
  tokens or states and returns to designer; deployer refuses to trust
  "verifier passed" claims without the report; verifier marks skipped
  critical gates as FAIL (no silent pass).
- **Designer** now runs a discovery phase (audience, primary task,
  mood, references), produces every component state (default / hover /
  focus-visible / active / disabled / loading / error / empty /
  success) in light + dark, and mandates handoff to
  accessibility-specialist before tokens are considered committed.
- **Architect** now requires NFRs, capacity/cost sketch, failure modes
  per component, reversibility per stack layer, and explicit handoffs
  to threat-modeler / designer / observability-setup.
- **Test-writer** now does 1:1 acceptance-criterion → test
  traceability, full UI state coverage, and enforces hard determinism
  rules (no real clock / network / RNG / sleep).
- **Implementer** now reads the full design system before any UI
  work, runs a token-consumption self-check on its own diff, and
  refuses to ship interactive components missing any defined state.
- **Threat-modeler** now produces mitigations as testable assertions
  that the test-writer picks up directly.
- **Release-manager** now requires auto-rollback to be synthetically
  tested before any rollout starts; baseline metrics captured before,
  not after.
- **Rollback-orchestrator** now re-confirms human authorization before
  each destructive step and surfaces PIPEDA breach trigger immediately
  if PI was involved.
- **Memory-curator** now requires evidence-backed proposals with
  date-cited feedback entries and a two-data-point threshold; biased
  toward net reduction over time.

### Documentation
- README updated with new "Agent design" section (the consistent
  shape) and "How the chain wires together" (build flow, recovery
  flow, weekly learning loop).

---

## [0.1.0] - YYYY-MM-DD

### Added
- Initial release.

---

## Notes for contributors

- **Write entries for the user, not the implementer.** "Added password reset"
  not "Refactored auth module."
- **Security entries are special.** Even patch versions can include security
  fixes — document them so users know to update.
- **Date format**: ISO (YYYY-MM-DD).
- **Version format**: SemVer (MAJOR.MINOR.PATCH).
- **Move "Unreleased" entries to a new version on release.**
- **Link versions** at the bottom if hosting on GitHub:
  `[Unreleased]: https://github.com/org/repo/compare/v0.1.0...HEAD`
