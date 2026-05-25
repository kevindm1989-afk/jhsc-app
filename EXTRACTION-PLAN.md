# JHSC app → new repo: extraction runbook

> Prep artifact. Nothing here runs automatically. The active Claude Code session
> is scoped to `kevindm1989-afk/agent-os` and **cannot** create or push to another
> repo — every command below is for **you** to run locally / in the new repo.
> All commands operate on a **fresh clone**, never on a working tree you care about.

## 0. The finding (why we're splitting)

This repo conflates two products:

- **`agent-os` (the framework):** the reusable multi-agent pack — `.claude/agents/`
  (31 agents), `playbooks/`, `templates/`, `workflows/`, and the framework docs
  (`README.md` = "Agent OS …", `CONTRIBUTING.md`, `QUICKSTART.md`, `COVERAGE.md`,
  `RELIABILITY.md`, `KNOWN-GAPS.md`, `CHANGELOG.md`, `SECURITY.md`).
- **`jhsc-app` (the application):** the Worker-Side JHSC app. The root
  `package.json` is **already** `name: "jhsc-app"`. Everything that is the actual
  product — `apps/`, `supabase/`, `i18n/`, `observability/`, `design-tokens.json`,
  `scripts/`, `.github/workflows/`, `JHSC-APP-PLAN.md`, the `*-review-t19.md`
  files, and the **filled** `.context/` memory (`decisions.md` = ADRs 0001–0020,
  `threat-model.md`, `known-gaps.md`, `test-plan.md`, `design-system.md`,
  `a11y-review.md`, `constraints.md`, `preferences.md`, `patterns.md`,
  `glossary.md`, `lessons.md`, `privacy-review-*.md`).

The app is the bulk; the framework is the smaller carve-out. So the cleanest
extraction **keeps everything and removes the framework-only files** from the new
app repo's history.

## 1. Classification manifest

| Path | Bucket | Notes |
|---|---|---|
| `apps/` | **APP** | the SvelteKit app |
| `supabase/` | **APP** | migrations, functions, seed, config |
| `i18n/`, `observability/`, `design-tokens.json` | **APP** | app config (filled with JHSC content) |
| `scripts/` | **APP** | app verification gates (onboarding/recovery/supabase-region/tokens/i18n/verify) |
| `.github/` (workflows, templates) | **APP** | the app's CI/deploy |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `Makefile` | **APP** | root is already `name: jhsc-app` |
| `JHSC-APP-PLAN.md`, `*-review-t19.md` | **APP** | plan + T19 review records |
| `.context/` **except** `feedback-log.template.md` | **APP** | the project's filled memory (ADRs, threat model, gaps, reviews, constraints, prefs, patterns, glossary, lessons) |
| `README.md` | **FRAMEWORK** | "Agent OS …" → replace with an app README in the new repo |
| `CONTRIBUTING.md`, `QUICKSTART.md`, `COVERAGE.md`, `RELIABILITY.md`, `KNOWN-GAPS.md`, `CHANGELOG.md`, `SECURITY.md` | **FRAMEWORK** | about agent-os; app can author its own later |
| `playbooks/`, `templates/`, `workflows/` | **FRAMEWORK** | reusable pack assets |
| `.context/feedback-log.template.md` | **FRAMEWORK** | the empty template (the filled feedback log, if any, is app) |
| `.claude/agents/` | **SHARED — your call** | the app uses these agents; the framework ships them. Recommend **keep a copy in the app repo** so app dev keeps working; agent-os keeps the canonical set. |
| `LICENSE` | **SHARED** | keep in both (or give the app its own) |

Two judgment calls are yours (see §4): (a) vendor `.claude/agents/` into the app
repo or not; (b) whether to also scrub the app out of `agent-os` afterward.

## 2. Recommended path — carve the app repo with history (`git filter-repo`)

Produces a `jhsc-app` repo whose history is the full development trail (T05→T19,
all reviews) with the framework-only files removed from every commit.

```bash
# Prereq: pip install git-filter-repo   (or brew install git-filter-repo)

# 1. Fresh clone of the source (filter-repo rewrites history — never do this in place)
git clone https://github.com/kevindm1989-afk/agent-os jhsc-app
cd jhsc-app

# 2. Make the app branch the trunk for the new repo
git checkout claude/jhsc-app-plan-nUriS
git branch -m claude/jhsc-app-plan-nUriS main      # this branch becomes main
git branch -D $(git branch | grep -v '^\*' | tr -d ' ') 2>/dev/null || true  # drop other local branches

# 3. Remove the framework-only files from ALL history
git filter-repo --invert-paths \
  --path README.md \
  --path CONTRIBUTING.md \
  --path QUICKSTART.md \
  --path COVERAGE.md \
  --path RELIABILITY.md \
  --path KNOWN-GAPS.md \
  --path CHANGELOG.md \
  --path SECURITY.md \
  --path playbooks/ \
  --path templates/ \
  --path workflows/ \
  --path .context/feedback-log.template.md
  # add `--path .claude/agents/` here ONLY if you decide NOT to vendor the agents (§4a)

# 4. Sanity-check the result
ls                      # apps/ supabase/ i18n/ observability/ scripts/ .context/ ... ; NO playbooks/ templates/ workflows/
git log --oneline | head
cat package.json | grep '"name"'   # -> "jhsc-app"

# 5. Create the new EMPTY repo on GitHub (you do this — the session can't),
#    e.g. kevindm1989-afk/jhsc-app, then:
git remote add origin https://github.com/kevindm1989-afk/jhsc-app
git push -u origin main
```

Then in the new repo, add an app-level `README.md` (the old one was the framework's),
and optionally app versions of `SECURITY.md` / `CHANGELOG.md`.

### Alternative path — clone + prune (no history rewrite)
Simpler, keeps the framework's history in the app repo's past:
```bash
git clone https://github.com/kevindm1989-afk/agent-os jhsc-app && cd jhsc-app
git checkout claude/jhsc-app-plan-nUriS && git branch -m main
git rm -r README.md CONTRIBUTING.md QUICKSTART.md COVERAGE.md RELIABILITY.md \
  KNOWN-GAPS.md CHANGELOG.md SECURITY.md playbooks templates workflows \
  .context/feedback-log.template.md
git commit -m "Prune agent-os framework files; this repo is the JHSC app"
git remote set-url origin https://github.com/kevindm1989-afk/jhsc-app
git push -u origin main
```

### Alternative path — clean copy (no history at all)
Fastest, drops the dev trail: copy the app paths into a fresh `git init` repo and
make one initial commit. Not recommended given the review history has value.

## 3. CI in the new repo
The app's workflows (`.github/workflows/ci.yml`, `verify.yml`, etc.) travel with
the carve. **Enable Actions** in the new repo's Settings → Actions → General (the
current `agent-os` repo appears to have Actions disabled, which is why no checks
ran on PR #11). `ci.yml`/`verify.yml` overlap — consider consolidating to one.

## 4. The two judgment calls
- **(a) Vendor `.claude/agents/` into the app repo?** Recommend **yes** — keep a
  copy so you can keep running the agent loop inside `jhsc-app`. Pull framework
  updates from `agent-os` periodically. If you'd rather treat agent-os as an
  installed dependency, add `--path .claude/agents/` to the filter-repo exclude in
  step 3 and install the pack separately.
- **(b) Scrub the app out of `agent-os` afterward?** Optional and **destructive** —
  a separate follow-on. Once `jhsc-app` is confirmed good, you can reduce
  `agent-os` back to pure framework (remove `apps/`, `supabase/`, the filled
  `.context/`, the app `package.json`, etc.) on its own branch + PR. Do NOT do this
  until the new repo is verified. Hold a session for it; don't free-hand it.

## 5. After the carve — verify before trusting it
```bash
cd jhsc-app
pnpm install
cd apps/web && npx vitest run     # expect the full suite green (was 661 passed)
npx tsc --noEmit
```

## Open items that travel to the new repo (already tracked in `.context/known-gaps.md`)
- HG-10 labour-lawyer copy ratification (T19) — external, gates merge.
- Production wire-up backlog (~280 gaps): T05.1, T07.1, … T19→T05.1/T07.1.
- The `.1` sibling work should be done **in the new repo**, after this carve.
