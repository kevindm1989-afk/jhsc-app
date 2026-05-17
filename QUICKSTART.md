# Quickstart

## Setup (one time, 15 minutes)

1. **Extract the pack into your new project's root directory**:
   ```
   mkdir my-new-project
   cd my-new-project
   tar -xzf /path/to/agent-os.tar.gz --strip-components=1
   git init && git add . && git commit -m "Agent OS scaffold"
   ```
   The `--strip-components=1` flag extracts the pack contents directly into
   the current directory rather than into a nested `agent-os/` subfolder.

2. **Edit `.context/preferences.md`** — fill in the blanks under code style,
   architecture taste, and risk posture. Be specific. This is the seed every
   agent reads.

3. **Tune `.context/constraints.md`** — remove sections that don't apply
   (Quebec Law 25 only if Quebec users; PHIPA only if health info; etc.).
   Keep PIPEDA — it's federal and always applies for commercial work.

4. **Install Claude Code** if you haven't. The `.claude/agents/` directory
   is already set up. Verify the agents load by running `/agents` in
   Claude Code.

5. **Make the verify script executable**:
   ```
   chmod +x scripts/verify.sh
   ```

6. **Install verification tools** (as your project takes shape):
   - For Node: `eslint`, `prettier`, `typescript`
   - For Python: `ruff`, `mypy`, `pytest`
   - Cross-language: `semgrep`, `gitleaks` (install via your OS package manager)

---

## Your first project (the prompt → app loop)

1. In Claude Code, give a clear prompt. Example:

   > "Build a small web app where members of my union local can submit
   > hazard reports anonymously. Reports should be visible to JHSC
   > co-chairs only. Hosted in Canada. Mobile-first."

2. Claude (the main session, acting as orchestrator) will:
   - Ask clarifying questions
   - Call the **architect**, **threat-modeler**, and **designer** in sequence
   - Synthesize the plan and ask for your approval **(HUMAN GATE)**

3. After you approve, the orchestrator loops through tasks:
   - **test-writer** writes failing tests
   - **implementer** makes them pass
   - **verifier** runs the gate stack
   - **security-reviewer + privacy-reviewer + adversarial-reviewer** in parallel
   - You review the PR **(HUMAN GATE)**

4. When ready to ship, the **deployer** prepares a deploy plan. For anything
   touching auth, billing, or personal data, you approve explicitly
   **(HUMAN GATE)**.

5. After each task, append outcome to `.context/feedback-log.md`.

Detailed walkthrough: `workflows/new-project.md`.

---

## Weekly (10 minutes)

Run `workflows/weekly-review.md`. Then invoke the **memory-curator** agent:

```
"memory-curator: review feedback from the past 7 days and propose
updates to .context/"
```

It will produce a report of proposed additions and prunings. **Approve each
one explicitly** — don't auto-apply. Then add the approved entries to the
relevant files.

Without this loop, the system doesn't actually learn. With it, the
preferences and patterns files become genuinely useful within a month.

---

## What to expect early on

**Weeks 1-2** will feel rougher than a hand-tuned single-agent setup.
Agents will sometimes:
- Ask questions you find obvious — they're being cautious, not dim
- Block on things you'd let slide — security and privacy reviewers don't move
  the bar; you adjust the bar in `.context/preferences.md` or `constraints.md`
- Miss patterns that haven't been written down yet — write them down

**Weeks 3-4** become noticeably better as `.context/` fills in.

**Month 2+** is where the system really earns its keep — pattern reuse, fewer
clarifying questions, consistent style, fewer compliance surprises.

---

## When something feels wrong

- **Agent producing low quality?** Check that the librarian briefed it. Check
  that the relevant pattern is in `.context/patterns.md`. If not, that's a
  weekly-review item.
- **Same correction over and over?** Add it to `.context/preferences.md`.
- **An agent is too strict / too lenient?** Edit its system prompt in
  `.claude/agents/`. These are not sacred; tune them.
- **The verifier blocks something legitimately fine?** Edit `scripts/verify.sh`.
  Don't lower the bar in the verifier prompt — lower it in the gates.
- **Constraints feel too tight?** They're set to PIPEDA defaults. For non-
  commercial or non-personal-data projects, relax them in `.context/constraints.md`.

---

## When to add more

The pack already includes the full system, but you may want to add:

- **Embedding-based retrieval** when `.context/` grows past ~50 entries
- **Operations agents** (incident response, bug triage, dependency updater) when you have production traffic
- **Cross-project memory** when you have more than one project using this pack
- **CI integration** to run agents on every PR automatically

See the upgrade discussion in `README.md`.
