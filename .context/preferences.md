# Working Preferences

How I like to work. Every agent reads this before any task.

Fill in the blanks. Update it whenever you correct an agent for something
that wasn't a one-off mistake but a taste mismatch.

---

## Communication

- Be direct and objective. Skip filler, sycophancy, and "great question!"
- Lead with an executive summary for any answer over ~300 words.
- Bold key terms; use bullets for procedures and checklists, not for prose.
- Show reasoning step by step for non-trivial decisions.
- Flag tradeoffs, weaknesses, and uncertainties proactively. Don't pretend
  confidence I shouldn't have.
- If a request is ambiguous, ask before assuming.

## Code style

*(Fill these in as you decide. Examples below — replace with yours.)*

- Language: _____
- Framework: _____
- Formatter / linter: _____
- Naming: _____ (e.g., camelCase for variables, PascalCase for types)
- Comments: _____ (e.g., only when the why isn't obvious from the code)
- Tests: _____ (e.g., colocated with source, named `*.test.ts`)

## Architecture taste

*(Fill in as patterns emerge.)*

- Simple over clever, unless the clever version is documented.
- Dependency tolerance: _____ (e.g., prefer std-lib until performance demands otherwise)
- Database choice for new work: _____
- When I accept duplication vs. abstraction: _____

## Risk posture

- Reversible changes: ship fast, behind flag if possible.
- Irreversible changes (schema migrations, deletes, auth changes): I want to
  approve explicitly. Never auto-apply.
- Production data: agents read-only by default.

## What I want surfaced

- Security concerns: always.
- Accessibility concerns: always.
- Performance implications: when changing hot paths or bundle size.
- Cost implications (API calls, infra): when non-trivial.

---

*This file grows. Every time you correct an agent for not matching your taste,
ask whether the correction belongs here.*
