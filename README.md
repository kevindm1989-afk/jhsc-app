# Agent OS — comprehensive multi-agent system for developers

**31 specialist agents** covering the full software development lifecycle,
scoped to Canadian/Ontario privacy & security requirements, that learns from
use.

**Realistic coverage of a generalist developer's role: ~88–92%.**

The remaining ~8–12% is genuinely human work (strategy, stakeholder relations,
hiring, novel domains) that no agent system can or should replace.

---

## Coverage by area

| Area | Coverage | Agents involved |
|---|---|---|
| **Code, tests, review** | 90% | test-writer, implementer, verifier, all reviewers |
| **Architecture, design, planning** | 85% | architect, threat-modeler, designer |
| **Operations, deployment, monitoring** | 90% | observability-setup, deployer, release-manager, incident-responder, rollback-orchestrator, sre-specialist |
| **Security & privacy compliance** | 95% | security-reviewer, privacy-reviewer, threat-modeler, constraints |
| **Documentation** | 90% | docs-keeper, tech-writer |
| **Mobile development** | 80% (was 60%) | mobile-specialist |
| **ML / data engineering** | 75% (was 45%) | ml-data-specialist |
| **Accessibility** | 90% (was 80%) | accessibility-specialist + automated checks |
| **Localization / French** | 85% (was ~30%) | localization-specialist |
| **Product analytics** | 80% (was 0%) | product-analytics |
| **Cost management** | 85% (was 40%) | cost-manager |
| **Support / user reports** | 75% (was 0%) | support-liaison |
| **Site reliability / SLOs** | 85% (was 60%) | sre-specialist |
| **User-facing copy** | 80% (was 0%) | tech-writer |

---

## What's NOT covered (and why that's fine)

| Not covered | Why | Approach |
|---|---|---|
| Product strategy | Requires human judgment | Use the system to execute decisions you've made |
| Stakeholder conversations | Requires human relationships | The system supports your prep, not the meeting |
| Hiring / firing / mentoring | Human work | Out of scope |
| Penetration testing | Must be independent | Hire a pentester; system flags when needed |
| Formal compliance audits | Must be independent | Use system as audit prep, not audit substitute |
| Legal review of contracts/policies | Lawyer required | System drafts; lawyer reviews |
| Game development | Specialized toolchain | Different system entirely |
| Embedded / firmware | Hardware context | Different system entirely |
| Novel research | Requires human invention | This is where you earn your salary |

---

## What's in here

```
.claude/agents/                    ← 31 specialist subagents
  Core (17):
    librarian, scaffolder
    architect, threat-modeler, designer
    test-writer, implementer
    verifier, security-reviewer, privacy-reviewer,
      adversarial-reviewer, second-opinion-reviewer,
      performance-watcher, docs-keeper
    release-manager, migration-handler, deployer
  Operations (4):
    observability-setup, incident-responder,
    rollback-orchestrator, dependency-manager
  Learning (1):
    memory-curator
  Specialists (9):
    mobile-specialist, ml-data-specialist,
    product-analytics, cost-manager,
    accessibility-specialist, localization-specialist,
    support-liaison, sre-specialist, tech-writer

.context/                          ← learning substrate
  constraints, preferences, decisions,
  patterns, lessons, glossary, feedback-log

.github/
  workflows/                       ← CI/CD
    verify, security-scan, deploy
  PULL_REQUEST_TEMPLATE.md

scripts/
  verify.sh                        ← gate stack

workflows/
  orchestration                    ← how agents wire together
  new-project, start-task,
  weekly-review, before-shipping

playbooks/
  incident-response
  backup-restore

templates/                         ← starter templates for common docs
  privacy-policy, terms-of-service,
  threat-model, runbook, adr

design-tokens.json
.pre-commit-config.yaml
.gitignore.template, .env.example, .editorconfig
Makefile
README.md, QUICKSTART.md, RELIABILITY.md, COVERAGE.md, KNOWN-GAPS.md
SECURITY.md, LICENSE, CONTRIBUTING.md, CHANGELOG.md
```

---

## The reliability model (unchanged)

Five layers, all covered:
- **Prevention** — review and verification agents
- **Detection** — observability, performance-watcher, support-liaison
- **Containment** — release-manager, migration-handler, feature flags
- **Recovery** — incident-responder, rollback-orchestrator
- **Learning** — memory-curator + post-mortems

Target: ~99.9% reliability with detection in seconds and recovery in minutes.
Not "zero errors" — rare, recoverable, detected, non-recurring errors.

---

## Human gates (always — even at 92% coverage)

Regardless of how comprehensive the agent roster, these stay your decision:

- Spec and architecture approval before code
- Privacy policy, retention, consent flows
- Cross-border transfers, new subprocessors
- Regulator responses
- Breach notification calls
- PR merges
- Production deploys touching auth/billing/personal data
- Database migrations in production
- Restore from backup
- Anything irreversible
- Product strategy decisions
- Anything customer-facing (support drafts, you send)

---

## Honest expectations

**What this system does well:**
- Solo or small-team developers building production web apps in Canada
- Compliance-sensitive applications (PIPEDA, Law 25, PHIPA)
- High-reliability requirements (financial, healthcare-adjacent, government)
- Multi-language Canadian audiences (French + English)
- Teams that need to operate above their headcount

**Where it's less effective:**
- Very large teams with established processes (your processes will conflict)
- Specialized domains (games, embedded, deep ML research)
- Pure exploratory R&D where structure gets in the way
- Hobbyist projects where the overhead exceeds the project

---

## Getting started

See `QUICKSTART.md`. The minimum useful subset for a new project is the
17 core agents; specialists join when relevant.

---

## Not legal advice

For any commercial launch handling personal information of Canadians,
get a privacy lawyer to review your compliance posture. This system gives
you a defensible baseline, not a substitute for legal review.
