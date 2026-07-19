<script lang="ts">
  /**
   * CommitteeManageMemberCard — Surface K screen 5 (ADR-0029 P1-8e): the
   * co-chair-side per-roster-row member management (change roles / remove /
   * reactivate) under the single-call inline 4-eyes control and the
   * last-co-chair guard.
   *
   * The sibling of CommitteeGrantCard (screen 3): a per-row inline child that
   * mounts ONLY when the /committee route wires the management deps (mirrors the
   * grant-card optional-deps attach — `CommitteeRoster.svelte:436-443`). It owns
   * the modal state machine + a11y packet; the parent owns the server-truthed
   * badge refresh.
   *
   * Load-bearing security posture (threat-model §3.18 F-181 / F-182):
   *   - F-181 ANTI-OPTIMISM — the TERMINAL is rendered ONLY from the server
   *     return. `done` iff the RPC returns with NO raised reason; a
   *     `4eyes_required` return → the 4eyes state (NOT done); a `last_co_chair`
   *     return → the explained block (NOT done); a thrown/failed return → failed.
   *     The row badge NEVER flips before the server confirms — on `done` the card
   *     signals `onChanged()`/`changed` and the parent re-runs `listRoster()`
   *     (no optimistic local flip).
   *   - F-181 SELF-APPROVE SUPPRESSION — the second-approver picker appears ONLY
   *     on a self-action that drops the actor's OWN worker-co-chair role, and only
   *     when at least one OTHER active worker co-chair exists (`eligibleApprovers`
   *     is derived by the parent, self already excluded). On an other-member
   *     action there is NO picker (the server ignores the approver there —
   *     rendering one would be dishonest signage). On an empty eligible list there
   *     is NO picker and Confirm stays ENABLED (self-removal must not dead-end —
   *     the server truths `last_co_chair`).
   *   - F-181 SERVER-TRUTHED `last_co_chair` — the block renders from
   *     `reason === 'last_co_chair'`, NEVER from a local "am I the last co-chair"
   *     count.
   *   - F-160 — the `4eyes_required` / `last_co_chair` / `failed` blocking copy
   *     names NO member (generic phrasing only). Confirm copy MAY name the member
   *     being acted on (the co-chair chose that target).
   *   - F-182 HONEST COPY — under auto-rotate (ADR-0030 Amendment C) the
   *     remove-confirm copy states the removal ROTATES the committee key (forward
   *     secrecy: it cuts access to committee data filed from now on, and cannot
   *     reach records the member already opened); it carries NO absolute/
   *     retroactive data-access-revocation claim. Self-removal is the exception —
   *     the leaver can't run the rotation, so the self variant says a remaining
   *     worker co-chair must still rotate the key. The reactivate-confirm copy
   *     states access returns via the RETAINED wrap, not a fresh grant.
   *
   * No member PI / raw uid is written to a URL / storage / log here (F-176); the
   * raw `reason` enum is mapped to copy, never echoed. No `console.*`.
   */
  import { tick, createEventDispatcher, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import type {
    RosterRow,
    CommitteeOpReason,
    CommitteeOpResult
  } from './supabase-committee-client';

  type SetRolesResult = CommitteeOpResult<null>;
  type RemoveResult = CommitteeOpResult<string>;
  type ReactivateResult = CommitteeOpResult<null>;

  // F182-6 / ADR-0030 Amendment C — the rotation status union (a structural
  // MIRROR of production-flows.ts `RotateCommitteeKeyOnRemovalResult`, declared
  // LOCALLY so the presentational card imports NO crypto module and never sees
  // key bytes: it carries opaque `rotation_id` / `new_key_id` handles + a uid[]
  // only — NEVER key material (AC-C13). Those handles are never rendered/logged.
  type RotationResult =
    | {
        status: 'ok';
        rotation_id: string;
        new_key_id: string;
        members_rewrapped_count: number;
        pending_members: string[];
      }
    | {
        status: 'ok_with_pending';
        rotation_id: string;
        new_key_id: string;
        members_rewrapped_count: number;
        pending_members: string[];
      }
    | { status: 'orphaned'; rotation_id: string; new_key_id: string }
    | { status: 'incomplete'; rotation_id: string; new_key_id: string; pending_members: string[] }
    | { status: 'cannot_resume_not_holder'; rotation_id: string; new_key_id: string }
    | { status: 'failed'; reason: string; http?: number };

  type RotateOnRemovalInput = {
    removed_member_id: string;
    remaining_members: ReadonlyArray<{ user_id: string }>;
    resume?: { rotation_id: string; new_key_id: string };
  };

  /** The governance-op methods this card drives (structural subset of
   *  SupabaseCommitteeClient — tests inject a fake that records inputs).
   *  `rotateOnRemoval` (F182-6) is OPTIONAL: present only on a rotation-capable
   *  mount (the roster threads it when the three crypto deps are wired). Its
   *  ABSENCE gates the Remove CTA off in a rotation-aware mount (VC-1). */
  type ManageClient = {
    // `_input` is a TYPE-SIGNATURE label only (never a runtime binding); the
    // underscore keeps no-unused-vars quiet on the structural method shapes.
    setRoles: (_input: {
      target_user_id: string;
      roles: string[];
      second_approver_id?: string | null;
    }) => Promise<SetRolesResult>;
    removeMember: (_input: {
      target_user_id: string;
      second_approver_id?: string | null;
    }) => Promise<RemoveResult>;
    reactivateMember: (_input: { target_user_id: string }) => Promise<ReactivateResult>;
    rotateOnRemoval?: (_input: RotateOnRemovalInput) => Promise<RotationResult>;
  };

  /** The roster row this card manages. */
  export let member: RosterRow;
  /** Whether `member` is the acting co-chair themselves (parent derives it as
   *  `member.user_id === getCurrentUserId()`) — the self-action discriminator. */
  export let isSelf = false;
  /** The eligible second approvers, derived by the parent as
   *  `rows.filter(r => r.active && r.roles.includes('worker_co_chair') && r.user_id !== getCurrentUserId())`
   *  — keyed off the `active` boolean + role (NOT the badge), self already
   *  excluded. Empty ⟺ the actor is the only active worker co-chair. */
  export let eligibleApprovers: RosterRow[] = [];
  /** F182-6 (Decision C3) — the roster-derived rotation set: the active members
   *  who currently hold committee-key access, minus the member being removed.
   *  Threaded by the roster ONLY on a rotation-capable mount; forwarded verbatim
   *  into `rotateOnRemoval` on a fresh run (AC-C15). */
  export let remainingMembers: ReadonlyArray<{ user_id: string }> = [];
  /** The management client (the governance ops + the optional rotation seam). */
  export let client: ManageClient;
  /** Parent callback — invoked on a clean server mutation so the roster re-fetches
   *  (server-truthed badge refresh; no optimistic flip). A `changed` event is also
   *  dispatched for callers that prefer the event API. */
  export let onChanged: () => void = () => {};

  const dispatch = createEventDispatcher<{ changed: void }>();

  // ── Row-level derivation (mirrors CommitteeRoster.badgeKind predicates) ─────
  // The `active` boolean is the authoritative live/not-live gate; a live member
  // (active/pending_grant/awaiting_identity) gets Change role + Remove, a removed
  // member (inactive, in grace) gets Reactivate, a pending invite gets nothing.
  $: isActiveFamily = member.active === true;
  $: isRemoved = member.active === false && member.deactivated_at != null;
  $: memberIsCoChair = member.roles.includes('worker_co_chair');
  // A nameless member gets the roster's unnamed fallback (never the raw uid) so no
  // PI-shaped uid enters the copy.
  $: nameForCopy = member.display_name ?? t('committee.roster.row.unnamed');

  // ── State machine ──────────────────────────────────────────────────────────
  type OpKind = 'role' | 'remove' | 'reactivate';
  type Phase =
    | 'form'
    | 'submitting'
    | 'done'
    | 'fourEyes'
    | 'lastCoChair'
    | 'failed'
    // F182-6 rotation sub-phase + five terminals (Decision C2).
    | 'rotating'
    | 'rotationDone'
    | 'rotationIncomplete'
    | 'rotationOrphaned'
    | 'rotationCannotResume'
    | 'rotationFailed';

  let openModal: OpKind | null = null;
  let phase: Phase = 'form';

  // Change-role checkboxes (initialised from `member.roles` on open).
  let roleCoChair = false;
  let roleWorkerMember = false;
  let roleCertified = false;

  // The chosen second approver (the picker value); '' = none chosen yet.
  let selectedApprover = '';
  // Whether the current 4eyes state is a stale-approver case (an approver was
  // supplied but the server still returned 4eyes — concurrently demoted).
  let staleApprover = false;
  // Polite announce for the picker selection (no focus move).
  let approverAnnounce = '';
  // The grace horizon returned by removeMember (interpolated into the done copy).
  let graceDate = '';
  // The reason-mapped failed body key (never the raw enum — F-176).
  let failedBodyKey = 'committee.manage.failed.generic_body';

  // F182-6 rotation transient state (server-truthed; carried across resume/retry).
  // `removalCommitted` flips true the instant `removeMember` returns ok, so every
  // Resume/Re-run/Retry calls `rotateOnRemoval` ONLY — never `removeMember` again
  // (re-pass #27). The resume handle + pending set come from an `incomplete`.
  let removalCommitted = false;
  let rotationResume: { rotation_id: string; new_key_id: string } | null = null;
  let rotationPending: string[] = [];
  let rotationHasPending = false;
  let rotationPendingCount = 0;
  // The reason-mapped rotation-failed body key + affordance (never the raw enum).
  let rotationFailedBodyKey = 'committee.remove.rotationFailed.generic_body';
  let rotationFailedAffordance: 'retry' | 'signin' | 'recovery' | 'close' = 'close';

  // The card root — the stable anchor used to reach the enclosing roster subtree
  // (background-inert target + the A11Y-6 focus-return group when a CTA detaches).
  let mmRootEl: HTMLDivElement | null = null;
  // Background-lock bookkeeping (A11Y-1 inert + A11Y-2 body scroll lock): the
  // prior body overflow to restore on close, and the app-content container we
  // marked inert while the modal is open (null in the standalone card mount).
  let prevBodyOverflow = '';
  let bgInerted: HTMLElement | null = null;

  // Focus targets — one deliberate move per state (§3.1 modal-return discipline).
  let dialogEl: HTMLDivElement | null = null;
  let headingEl: HTMLHeadingElement | null = null;
  let fourEyesHeadingEl: HTMLHeadingElement | null = null;
  let lastCoChairHeadingEl: HTMLHeadingElement | null = null;
  let failedHeadingEl: HTMLHeadingElement | null = null;
  let doneHeadingEl: HTMLHeadingElement | null = null;
  // F182-6 — one deliberate focus move to each rotation terminal heading, plus
  // the in-flight `rotating` sub-phase heading (it also carries the dialog name so
  // aria-labelledby never dangles while the rotation is in flight).
  let rotatingHeadingEl: HTMLHeadingElement | null = null;
  let rotationDoneHeadingEl: HTMLHeadingElement | null = null;
  let rotationIncompleteHeadingEl: HTMLHeadingElement | null = null;
  let rotationOrphanedHeadingEl: HTMLHeadingElement | null = null;
  let rotationCannotResumeHeadingEl: HTMLHeadingElement | null = null;
  let rotationFailedHeadingEl: HTMLHeadingElement | null = null;
  // The per-row CTA that opened the modal — return-focus target on close.
  let roleCtaEl: HTMLButtonElement | null = null;
  let removeCtaEl: HTMLButtonElement | null = null;
  let reactivateCtaEl: HTMLButtonElement | null = null;
  let lastCta: HTMLButtonElement | null = null;

  $: dialogHeadingId = `committee-manage-heading-${member.user_id}`;
  $: approverSelectId = `committee-manage-approver-${member.user_id}`;

  // The next role set from the checkboxes (fixed order: co-chair / member /
  // certified — matches the modal's checkbox order).
  $: nextRoles = [
    ...(roleCoChair ? ['worker_co_chair'] : []),
    ...(roleWorkerMember ? ['worker_member'] : []),
    ...(roleCertified ? ['certified_member'] : [])
  ];
  $: rolesChanged = !sameRoleSet(nextRoles, member.roles);

  // The self-drop trigger — EXACTLY the shape the server gates (self demoting out
  // of worker-co-chair, or self-removing while a co-chair). Keyed off `isSelf` +
  // the role membership, never a badge.
  $: selfDropsCoChair =
    openModal === 'role'
      ? isSelf && memberIsCoChair && !nextRoles.includes('worker_co_chair')
      : openModal === 'remove'
        ? isSelf && memberIsCoChair
        : false;
  // The picker matches the server EXACTLY: shown iff the action drops the actor's
  // own co-chair role AND an eligible OTHER co-chair exists. Empty eligible list →
  // no picker, no dead-end (the server truths last_co_chair).
  $: showPicker = selfDropsCoChair && eligibleApprovers.length > 0;
  $: emptyEligibleNote = selfDropsCoChair && eligibleApprovers.length === 0;
  $: approverGated = showPicker && selectedApprover === '';

  // VC-1 / AC-C14 — the Remove CTA requires rotation capability, FULL STOP. Under
  // auto-rotate (ADR-0030 Amendment C) removal ALWAYS rotates the committee key;
  // a mount without `rotateOnRemoval` (the crypto deps are not wired) must NOT
  // offer Remove at all — else a governance-only removal would run under the
  // forward-secrecy copy that promises a rotation (the "silent no-rotate removal
  // under false copy" VC-1 forbids). Change-role + Reactivate still render (they
  // need no crypto). The gate is PURE presence — never keyed on member count or
  // any other incidental signal, so a future route that wires governance ops
  // without the crypto deps still cannot offer a dishonest removal (defense in
  // depth: the invariant is enforced here, not assumed at the call site).
  $: canOfferRemove = typeof client.rotateOnRemoval === 'function';

  // ADV-3 stale-roster dead-end recovery: the server returned `4eyes_required`
  // while the local snapshot shows NO eligible co-chair (a second co-chair was
  // added elsewhere). No picker can render, so instead of looping a null-approver
  // resubmit we offer a single coherent refetch affordance and GATE Confirm.
  $: staleFourEyesNoPicker =
    phase === 'fourEyes' && selfDropsCoChair && eligibleApprovers.length === 0;

  // The empty-role-selection gate (all boxes cleared) — a discrete gated case that
  // needs its own discoverable hint (A11Y-3), distinct from the no-change gate.
  $: emptyRoleSelection = openModal === 'role' && rolesChanged && nextRoles.length === 0;

  // Confirm gating per op. Role: no-op (selection === current) / empty selection /
  // picker-unfilled. Remove: only the picker-unfilled path (an other-member or
  // last-co-chair removal must never be blocked by a missing approver). Reactivate:
  // never gated. The stale-4eyes dead-end gates every op (recover via refetch).
  $: confirmGated =
    staleFourEyesNoPicker ||
    (openModal === 'role'
      ? !rolesChanged || nextRoles.length === 0 || approverGated
      : openModal === 'remove'
        ? approverGated
        : false);

  // A11Y-3: the gated Confirm always points aria-describedby at the live gating
  // hint — the approver-required gate AND the empty-role-selection gate (was
  // previously wired only for the no-change gate).
  $: confirmDescribedBy =
    openModal === 'role'
      ? emptyRoleSelection
        ? `${approverSelectId}-empty-roles`
        : approverGated
          ? `${approverSelectId}-approver-hint`
          : !rolesChanged
            ? `${approverSelectId}-nochange`
            : undefined
      : openModal === 'remove'
        ? approverGated
          ? `${approverSelectId}-approver-hint`
          : undefined
        : undefined;

  $: failedRetryable =
    failedBodyKey === 'committee.role.failed.invalid_role.body' ||
    failedBodyKey === 'committee.manage.failed.generic_body';

  // ── Copy resolvers (openModal-scoped) ───────────────────────────────────────
  $: confirmLabel =
    openModal === 'role'
      ? t('committee.role.modal.confirm')
      : openModal === 'remove'
        ? isSelf
          ? t('committee.remove.modal.confirm_self')
          : t('committee.remove.modal.confirm')
        : openModal === 'reactivate'
          ? t('committee.reactivate.modal.confirm')
          : '';
  $: cancelLabel =
    openModal === 'role'
      ? t('committee.role.modal.cancel')
      : openModal === 'remove'
        ? t('committee.remove.modal.cancel')
        : t('committee.reactivate.modal.cancel');
  $: submittingLabel =
    openModal === 'role'
      ? t('committee.role.submitting')
      : openModal === 'remove'
        ? t('committee.remove.submitting')
        : t('committee.reactivate.submitting');
  $: submittingAnnounce =
    openModal === 'role'
      ? t('a11y.committee.role.submitting')
      : openModal === 'remove'
        ? t('a11y.committee.remove.submitting')
        : t('a11y.committee.reactivate.submitting');
  $: modalHeading =
    openModal === 'role'
      ? t('committee.role.modal.heading')
      : openModal === 'remove'
        ? t('committee.remove.modal.heading', { name: nameForCopy })
        : openModal === 'reactivate'
          ? t('committee.reactivate.modal.heading', { name: nameForCopy })
          : '';
  $: doneHeading =
    openModal === 'role'
      ? t('committee.role.done.heading')
      : openModal === 'remove'
        ? t('committee.remove.done.heading')
        : t('committee.reactivate.done.heading');
  $: doneBody =
    openModal === 'role'
      ? t('committee.role.done.body', { name: nameForCopy })
      : openModal === 'remove'
        ? t('committee.remove.done.body', { name: nameForCopy, date: graceDate })
        : t('committee.reactivate.done.body', { name: nameForCopy });
  $: doneAnnounce =
    openModal === 'role'
      ? t('a11y.committee.role.done')
      : openModal === 'remove'
        ? t('a11y.committee.remove.done', { date: graceDate })
        : t('a11y.committee.reactivate.done');

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function sameRoleSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((r) => sb.has(r));
  }

  function focusEl(el: HTMLElement | null): void {
    if (el && typeof el.focus === 'function') el.focus();
  }

  function approverLabel(a: RosterRow): string {
    return a.display_name ?? `${t('committee.roster.row.unnamed')} ${a.user_id.slice(0, 8)}`;
  }

  // A11Y-1: portal the dialog out of the (soon-to-be-inert) roster subtree to a
  // top-level container, so the background can be inerted while the dialog itself
  // stays operable. A tiny Svelte action — moves the node to <body> on mount and
  // removes it on destroy (idempotent with Svelte's own detach).
  function portal(node: HTMLElement) {
    if (typeof document !== 'undefined') document.body.appendChild(node);
    return {
      destroy() {
        if (node.isConnected) node.remove();
      }
    };
  }

  // A11Y-1 + A11Y-2: on modal open, lock body scroll and mark the app background
  // (the enclosing roster list / page) inert so only the portaled dialog is
  // reachable. Standalone card mounts have no such ancestor — inert is skipped,
  // the scroll lock still applies.
  function lockBackground(): void {
    if (typeof document === 'undefined') return;
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    bgInerted =
      mmRootEl?.closest<HTMLElement>('[data-testid="committee-roster-list"]') ??
      mmRootEl?.closest<HTMLElement>('[data-testid="committee-page"]') ??
      null;
    // The dialog is portaled to <body>, so inerting this ancestor never inerts the
    // dialog. Attribute form (not the `.inert` prop) so it is observable in jsdom.
    bgInerted?.setAttribute('inert', '');
  }

  function unlockBackground(): void {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = prevBodyOverflow;
    bgInerted?.removeAttribute('inert');
    bgInerted = null;
  }

  // Lifecycle safety net: if this card is destroyed while a modal is still open,
  // closePanel() never runs, so the body scroll-lock and the roster `inert`
  // would be stranded permanently. This fires on the GUARANTEED self-governance
  // path (a co-chair self-removes/self-demotes → the success refetch 403s because
  // they are no longer an active co-chair → the roster list unmounts this card
  // mid-modal) and on any navigate-away-while-open. unlockBackground() is
  // idempotent, so this is safe even when closePanel() already ran.
  onDestroy(() => {
    if (openModal) unlockBackground();
  });

  // A11Y-6: the return-focus target on close. Normally the CTA that opened the
  // modal — but a mutation can flip the row's affordance (remove→reactivate),
  // detaching that CTA. When it is gone, return focus to a STABLE, still-connected
  // element (the row's role="group" unit), never the detached node or <body>.
  function resolveReturnFocus(): HTMLElement | null {
    if (lastCta && lastCta.isConnected) return lastCta;
    const group = mmRootEl?.closest<HTMLElement>('[role="group"]') ?? null;
    if (group) {
      if (!group.hasAttribute('tabindex')) group.setAttribute('tabindex', '-1');
      return group;
    }
    return mmRootEl;
  }

  // ADV-3: the stale-4eyes recovery affordance re-runs the roster read so the
  // newly-eligible co-chair surfaces as an approver. The modal stays open — once
  // `eligibleApprovers` refreshes, the picker replaces this affordance in place.
  function onRefetchApprover(): void {
    onChanged();
    dispatch('changed');
  }

  // ── Open / close ─────────────────────────────────────────────────────────────
  async function openRole(): Promise<void> {
    lastCta = roleCtaEl;
    roleCoChair = member.roles.includes('worker_co_chair');
    roleWorkerMember = member.roles.includes('worker_member');
    roleCertified = member.roles.includes('certified_member');
    resetTransient();
    openModal = 'role';
    phase = 'form';
    lockBackground();
    await tick();
    focusEl(headingEl);
  }
  async function openRemove(): Promise<void> {
    lastCta = removeCtaEl;
    resetTransient();
    openModal = 'remove';
    phase = 'form';
    lockBackground();
    await tick();
    focusEl(headingEl);
  }
  async function openReactivate(): Promise<void> {
    lastCta = reactivateCtaEl;
    resetTransient();
    openModal = 'reactivate';
    phase = 'form';
    lockBackground();
    await tick();
    focusEl(headingEl);
  }

  function resetTransient(): void {
    selectedApprover = '';
    staleApprover = false;
    approverAnnounce = '';
    graceDate = '';
    failedBodyKey = 'committee.manage.failed.generic_body';
    removalCommitted = false;
    rotationResume = null;
    rotationPending = [];
    rotationHasPending = false;
    rotationPendingCount = 0;
    rotationFailedBodyKey = 'committee.remove.rotationFailed.generic_body';
    rotationFailedAffordance = 'close';
  }

  async function closePanel(): Promise<void> {
    openModal = null;
    phase = 'form';
    resetTransient();
    unlockBackground();
    await tick();
    // Resolve AFTER tick so a flipped-affordance CTA has settled (detached) and
    // the stable fallback target is chosen (A11Y-6).
    focusEl(resolveReturnFocus());
  }

  function onApproverChange(e: Event): void {
    const val = (e.target as HTMLSelectElement).value;
    selectedApprover = val;
    const a = eligibleApprovers.find((x) => x.user_id === val);
    approverAnnounce = a ? t('a11y.committee.approver.selected', { name: approverLabel(a) }) : '';
  }

  // ── Submit + terminal transitions (server-truthed only — F-181) ──────────────
  async function onConfirm(): Promise<void> {
    // Re-activation guard + the defense-in-depth "gated Confirm fires nothing".
    if (phase !== 'form' && phase !== 'fourEyes') return;
    if (confirmGated) return;
    if (openModal === 'role') await submitRole();
    else if (openModal === 'remove') await submitRemove();
    else if (openModal === 'reactivate') await submitReactivate();
  }

  async function onRetry(): Promise<void> {
    if (phase !== 'failed') return;
    if (openModal === 'role') await submitRole();
    else if (openModal === 'remove') await submitRemove();
    else if (openModal === 'reactivate') await submitReactivate();
  }

  async function onReload(): Promise<void> {
    onChanged();
    dispatch('changed');
    await closePanel();
  }

  async function submitRole(): Promise<void> {
    phase = 'submitting';
    await tick();
    let result: SetRolesResult;
    try {
      result = await client.setRoles({
        target_user_id: member.user_id,
        roles: nextRoles,
        // null (not undefined) on the non-picker path — the client omits the
        // field, so the server never reads a fabricated approver.
        second_approver_id: showPicker ? selectedApprover : null
      });
    } catch {
      await enterFailed('unknown', 0);
      return;
    }
    await applyResult(result);
  }

  async function submitRemove(): Promise<void> {
    phase = 'submitting';
    await tick();
    let result: RemoveResult;
    try {
      result = await client.removeMember({
        target_user_id: member.user_id,
        second_approver_id: showPicker ? selectedApprover : null
      });
    } catch {
      await enterFailed('unknown', 0);
      return;
    }
    if (!result.ok) {
      // AC-C1 — a non-ok governance result removed NO member, so the rotation
      // MUST NOT run: take the existing governance terminals unchanged.
      await applyResult(result);
      return;
    }
    // The membership removal is committed + server-truthed the instant this
    // returns ok. `removalCommitted` guards every later retry/resume against a
    // second `removeMember` (re-pass #27).
    removalCommitted = true;
    graceDate = isoDate(result.data);
    if (!isSelf && typeof client.rotateOnRemoval === 'function') {
      // AC-C2 — an other-member removal AUTO-RUNS the forward-secrecy rotation
      // in the same action (ADR-0030 Amendment C).
      await runRotationFresh();
    } else if (isSelf) {
      // Self-removal (the leaver cannot run the rotation — AC-C9/C6) → the
      // membership terminal; the reconciled self-removal copy states a remaining
      // co-chair must still rotate the key. This non-rotate `done` path is for
      // `isSelf` ONLY.
      await enterDone(result.data);
    } else {
      // Defense-in-depth: a NON-self removal that reached here without a rotation
      // seam is unreachable given the Remove CTA is gated on `rotateOnRemoval`
      // presence (VC-1 / canOfferRemove). Make the invariant explicit — never
      // silently show the self-removal copy + skip the forward-secrecy rotation;
      // fail LOUD into an unrecoverable rotation terminal instead.
      await enterRotationFailed('invalid_input', undefined);
    }
  }

  // ── F182-6 rotation follow-through (Decision C1/C2) ──────────────────────────
  async function runRotation(input: RotateOnRemovalInput): Promise<void> {
    phase = 'rotating';
    await tick();
    // AC-C11 / Accessibility F2 — one deliberate focus move onto the rotating
    // heading (it carries the dialog name), so focus never strands on <body> when
    // the submitting Confirm unmounts (mirrors enterRotationDone's focus move).
    focusEl(rotatingHeadingEl);
    const rotate = client.rotateOnRemoval;
    if (typeof rotate !== 'function') {
      // Defensive: the Remove CTA is gated on presence, so this never fires.
      await enterRotationFailed('unknown', undefined);
      return;
    }
    let res: RotationResult;
    try {
      res = await rotate(input);
    } catch {
      // A thrown rotation is a failure, never a false success (AC-C8).
      await enterRotationFailed('unknown', undefined);
      return;
    }
    await applyRotationResult(res);
  }

  /** A FRESH rotation (resume undefined, full injected remaining set) — the
   *  initial submit, an orphaned Re-run, and a transient failed Retry. A fresh
   *  run of an orphan mints the NEXT epoch (never resumes the orphan — F-137). */
  async function runRotationFresh(): Promise<void> {
    rotationResume = null;
    await runRotation({
      removed_member_id: member.user_id,
      remaining_members: remainingMembers
    });
  }

  /** A RESUME (Decision C5) — carries the incomplete result's resume handle +
   *  `remaining_members = pending_members`; continues from the step-5 install so
   *  only the still-missing set is re-wrapped. */
  async function runRotationResume(): Promise<void> {
    await runRotation({
      removed_member_id: member.user_id,
      remaining_members: rotationPending.map((user_id) => ({ user_id })),
      // `exactOptionalPropertyTypes`: only carry `resume` when it exists.
      ...(rotationResume ? { resume: rotationResume } : {})
    });
  }

  async function applyRotationResult(res: RotationResult): Promise<void> {
    switch (res.status) {
      case 'ok':
        rotationHasPending = false;
        rotationPendingCount = 0;
        await enterRotationDone();
        return;
      case 'ok_with_pending':
        // Informational, NOT an error (AC-C4): success terminal + a count-only
        // pending note.
        rotationHasPending = true;
        rotationPendingCount = res.pending_members.length;
        await enterRotationDone();
        return;
      case 'incomplete':
        rotationResume = { rotation_id: res.rotation_id, new_key_id: res.new_key_id };
        rotationPending = [...res.pending_members];
        await enterRotationTerminal('rotationIncomplete');
        return;
      case 'orphaned':
        await enterRotationTerminal('rotationOrphaned');
        return;
      case 'cannot_resume_not_holder':
        await enterRotationTerminal('rotationCannotResume');
        return;
      case 'failed':
        await enterRotationFailed(res.reason, res.http);
        return;
    }
  }

  async function enterRotationDone(): Promise<void> {
    phase = 'rotationDone';
    await tick();
    focusEl(rotationDoneHeadingEl);
    signalRotationChanged();
  }

  async function enterRotationTerminal(
    next: 'rotationIncomplete' | 'rotationOrphaned' | 'rotationCannotResume'
  ): Promise<void> {
    phase = next;
    await tick();
    focusEl(
      next === 'rotationIncomplete'
        ? rotationIncompleteHeadingEl
        : next === 'rotationOrphaned'
          ? rotationOrphanedHeadingEl
          : rotationCannotResumeHeadingEl
    );
    signalRotationChanged();
  }

  async function enterRotationFailed(reason: string, http: number | undefined): Promise<void> {
    const mapped = rotationFailedMapping(reason, http);
    rotationFailedBodyKey = mapped.bodyKey;
    rotationFailedAffordance = mapped.affordance;
    phase = 'rotationFailed';
    await tick();
    focusEl(rotationFailedHeadingEl);
    signalRotationChanged();
  }

  /** The removal is server-truth the instant `removeMember` returned ok, so the
   *  roster refetch fires when the card reaches ANY rotation terminal (success OR
   *  loud) — never mid-flight (F-181 / AC-C10). */
  function signalRotationChanged(): void {
    onChanged();
    dispatch('changed');
  }

  /** Map a rotation `failed{reason}` (+ optional HTTP) onto its body key +
   *  affordance — NEVER the raw enum (F-176). The 401/403 split is preserved. */
  function rotationFailedMapping(
    reason: string,
    http: number | undefined
  ): { bodyKey: string; affordance: 'retry' | 'signin' | 'recovery' | 'close' } {
    if (reason === 'session_expiry' || http === 401) {
      return { bodyKey: 'committee.remove.rotationFailed.session_body', affordance: 'signin' };
    }
    if (reason === 'rls_denied' || http === 403) {
      return { bodyKey: 'committee.remove.rotationFailed.co_chair_body', affordance: 'close' };
    }
    if (reason === 'needs_recovery' || reason === 'no_wrap') {
      // VC-2 — a Resume that yields needs_recovery routes to recovery here too,
      // never the cannot_resume dead-end.
      return {
        bodyKey: 'committee.remove.rotationFailed.needs_recovery_body',
        affordance: 'recovery'
      };
    }
    if (reason === 'invalid_input' || http === 422) {
      // A retry re-seals identical bytes → identical failure: unrecoverable, Close.
      return { bodyKey: 'committee.remove.rotationFailed.unrecoverable_body', affordance: 'close' };
    }
    // rotation_in_progress / decrypt_failed / anything else → transient retry.
    return { bodyKey: 'committee.remove.rotationFailed.generic_body', affordance: 'retry' };
  }

  // Resume / Re-run / Retry — every path re-invokes `rotateOnRemoval` ONLY,
  // guarded by `removalCommitted` so `removeMember` is never re-run (re-pass #27).
  async function onResume(): Promise<void> {
    if (!removalCommitted || phase !== 'rotationIncomplete') return;
    await runRotationResume();
  }
  async function onRerun(): Promise<void> {
    if (!removalCommitted || phase !== 'rotationOrphaned') return;
    await runRotationFresh();
  }
  async function onRotationRetry(): Promise<void> {
    if (!removalCommitted || phase !== 'rotationFailed') return;
    await runRotationFresh();
  }

  async function submitReactivate(): Promise<void> {
    phase = 'submitting';
    await tick();
    let result: ReactivateResult;
    try {
      result = await client.reactivateMember({ target_user_id: member.user_id });
    } catch {
      await enterFailed('unknown', 0);
      return;
    }
    await applyResult(result);
  }

  async function applyResult(result: SetRolesResult | RemoveResult): Promise<void> {
    if (result.ok) {
      await enterDone(result.data);
      return;
    }
    if (result.reason === '4eyes_required') {
      await enterFourEyes();
      return;
    }
    if (result.reason === 'last_co_chair') {
      await enterLastCoChair();
      return;
    }
    await enterFailed(result.reason, result.status);
  }

  async function enterDone(data: unknown): Promise<void> {
    // remove returns the BARE grace ISO scalar; the other ops return void.
    if (openModal === 'remove' && typeof data === 'string') graceDate = isoDate(data);
    phase = 'done';
    await tick();
    focusEl(doneHeadingEl);
    // The row badge NEVER flips locally — signal the parent to re-fetch (F-181).
    onChanged();
    dispatch('changed');
  }

  async function enterFourEyes(): Promise<void> {
    // A supplied-approver 4eyes is a stale-approver case; re-require a fresh pick.
    staleApprover = showPicker && selectedApprover !== '';
    selectedApprover = '';
    approverAnnounce = '';
    phase = 'fourEyes';
    await tick();
    focusEl(fourEyesHeadingEl);
  }

  async function enterLastCoChair(): Promise<void> {
    phase = 'lastCoChair';
    await tick();
    focusEl(lastCoChairHeadingEl);
  }

  async function enterFailed(reason: CommitteeOpReason, status: number): Promise<void> {
    failedBodyKey = failedBodyKeyFor(reason, status);
    phase = 'failed';
    await tick();
    focusEl(failedHeadingEl);
  }

  /** Map a denial reason (+ HTTP status) onto its actionable body key — NEVER the
   *  raw enum (F-176), and every reason discriminated (never collapsed). */
  function failedBodyKeyFor(reason: CommitteeOpReason, status: number): string {
    switch (reason) {
      case 'invalid_role':
        return 'committee.role.failed.invalid_role.body';
      case 'not_found':
        return 'committee.manage.failed.not_found_body';
      case 'already_active':
        return 'committee.reactivate.failed.already_active.body';
      case 'rls_denied':
        return status === 401
          ? 'committee.manage.failed.session_body'
          : 'committee.manage.failed.co_chair_body';
      default:
        return 'committee.manage.failed.generic_body';
    }
  }

  /** ISO YYYY-MM-DD (§7) — clock-independent slice of the server ISO string. */
  function isoDate(s: string | null): string {
    return s ? s.slice(0, 10) : '';
  }

  // ── Modal keyboard: focus trap + the §3.5 protected-variant Escape rules ─────
  function focusableWithin(root: HTMLElement | null): HTMLElement[] {
    if (!root) return [];
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => el.getAttribute('aria-hidden') !== 'true'
    );
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // Never dismissable while submitting; remove is always protected; role is
      // protected while the 4-eyes picker is showing. F182-6 (AC-C11): the
      // `rotating` sub-phase and all five rotation terminals require an explicit
      // Close — Escape is swallowed (they already sit under `openModal==='remove'`,
      // but the extension is spelled out for clarity).
      const protectedModal =
        phase === 'submitting' ||
        phase === 'rotating' ||
        phase === 'rotationDone' ||
        phase === 'rotationIncomplete' ||
        phase === 'rotationOrphaned' ||
        phase === 'rotationCannotResume' ||
        phase === 'rotationFailed' ||
        openModal === 'remove' ||
        (openModal === 'role' && showPicker) ||
        phase === 'fourEyes';
      e.preventDefault();
      e.stopPropagation();
      if (!protectedModal) void closePanel();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = focusableWithin(dialogEl);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active =
        typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      // A11Y-1: the dialog container / heading carry tabindex="-1", so they are NOT
      // in the focusables set. Treat "focus on such a boundary" as an edge too, or a
      // Shift+Tab from the heading escapes to a per-row CTA. Shift+Tab from the first
      // OR any non-member boundary wraps to last; Tab from the last OR a boundary
      // wraps to first.
      const inSet = active != null && focusables.includes(active);
      if (e.shiftKey) {
        if (active === first || !inSet) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !inSet) {
        e.preventDefault();
        first.focus();
      }
    }
  }
</script>

<div class="mm-root" bind:this={mmRootEl}>
  {#if isSelf}
    <!-- Self is unmistakable — a TEXT chip (never colour-only) + an SR note. -->
    <span class="mm-you">
      <span class="mm-you-text">{t('committee.manage.you_chip')}</span>
      <span class="mm-sr">{t('a11y.committee.manage.you')}</span>
    </span>
  {/if}

  {#if isActiveFamily}
    <div class="mm-actions-row">
      <button
        type="button"
        class="btn-outline mm-cta"
        data-testid={`committee-manage-role-cta-${member.user_id}`}
        aria-haspopup="dialog"
        aria-label={t('committee.role.row.cta_aria', { name: nameForCopy })}
        bind:this={roleCtaEl}
        on:click={openRole}
      >
        <svg class="mm-cta-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {t('committee.role.row.cta')}
      </button>
      {#if canOfferRemove}
        <button
          type="button"
          class="btn-destructive mm-cta"
          data-testid={`committee-manage-remove-cta-${member.user_id}`}
          aria-haspopup="dialog"
          aria-label={t('committee.remove.row.cta_aria', { name: nameForCopy })}
          bind:this={removeCtaEl}
          on:click={openRemove}
        >
          <svg class="mm-cta-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <circle cx="9" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2" />
            <path
              d="m17 8 5 5m0-5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          {t('committee.remove.row.cta')}
        </button>
      {/if}
    </div>
  {:else if isRemoved}
    <div class="mm-actions-row">
      <button
        type="button"
        class="btn-outline mm-cta"
        data-testid={`committee-manage-reactivate-cta-${member.user_id}`}
        aria-haspopup="dialog"
        aria-label={t('committee.reactivate.row.cta_aria', { name: nameForCopy })}
        bind:this={reactivateCtaEl}
        on:click={openReactivate}
      >
        <svg class="mm-cta-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {t('committee.reactivate.row.cta')}
      </button>
    </div>
  {/if}

  {#if openModal}
    <!-- A11Y-1: portaled to <body> so the roster subtree can be inerted behind it
         (background non-operable) while the dialog itself stays operable. -->
    <div class="mm-backdrop" use:portal>
      <!-- The keydown listener is the WAI-ARIA modal focus trap + the §3.5
           protected-variant Escape rules — focus management, not a click
           affordance. A11Y-4: aria-busy is NOT on the dialog (it would suppress
           the submitting live region below); the submitting Confirm button owns
           the aria-busy flag instead. -->
      <div
        class="mm-dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogHeadingId}
        tabindex="-1"
        data-testid={`committee-${openModal}-modal`}
        bind:this={dialogEl}
        on:keydown={onKeyDown}
      >
        {#if phase === 'done'}
          <div class="mm-terminal mm-success" role="status" data-testid="committee-manage-done">
            <svg class="mm-terminal-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m8.5 12 2.5 2.5 4.5-5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <div>
              <h2
                id={dialogHeadingId}
                class="mm-terminal-heading"
                tabindex="-1"
                bind:this={doneHeadingEl}
              >
                {doneHeading}
              </h2>
              <p class="mm-terminal-body">{doneBody}</p>
              <span class="mm-sr">{doneAnnounce}</span>
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.manage.close')}
              </button>
            </div>
          </div>
        {:else if phase === 'rotating'}
          <!-- F182-6 rotating sub-phase: the membership removal is committed +
               server-truthed; the forward-secrecy rotation is in flight. The
               busy CTA owns aria-busy (mirrors the `submitting` treatment). -->
          <div class="mm-rotating">
            <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
            <!-- The rotating sub-phase carries the dialog name (id={dialogHeadingId})
                 so aria-labelledby never dangles in flight, and is the one
                 deliberate focus target when this phase is entered (Accessibility
                 F2 / AC-C11). -->
            <h2
              id={dialogHeadingId}
              class="mm-heading"
              tabindex="-1"
              bind:this={rotatingHeadingEl}
              data-testid="committee-manage-rotating-heading"
            >
              {t('committee.remove.rotating.status')}
            </h2>
            <div class="mm-actions">
              <button
                type="button"
                class="mm-confirm btn-destructive"
                data-testid="committee-manage-rotating"
                aria-busy="true"
                aria-disabled="true"
              >
                {t('committee.remove.rotating.cta')}
              </button>
            </div>
            <span class="mm-sr" role="status" aria-live="polite">
              {t('a11y.committee.remove.rotation.rotating')}
            </span>
          </div>
        {:else if phase === 'rotationDone'}
          <!-- SUCCESS terminal (ok | ok_with_pending). role="status", green. -->
          <div
            class="mm-terminal mm-success"
            role="status"
            data-testid="committee-manage-rotation-done"
          >
            <svg class="mm-terminal-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m8.5 12 2.5 2.5 4.5-5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <div>
              <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
              <h2
                id={dialogHeadingId}
                class="mm-terminal-heading"
                tabindex="-1"
                bind:this={rotationDoneHeadingEl}
              >
                {t('committee.remove.rotationDone.heading')}
              </h2>
              <p class="mm-terminal-body">{t('committee.remove.rotationDone.body')}</p>
              {#if rotationHasPending}
                <!-- AC-C4: informational, NOT an alert. Count-only (F-160). -->
                <div
                  class="mm-callout mm-callout-info"
                  role="status"
                  data-testid="committee-manage-rotation-pending-note"
                >
                  <svg class="mm-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    />
                    <path
                      d="M12 11v5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                    <path
                      d="M12 8h.01"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                  <div>
                    <p class="mm-callout-body">
                      {t('committee.remove.rotationDone.pending_note', {
                        count: rotationPendingCount
                      })}
                    </p>
                  </div>
                </div>
              {/if}
              <span class="mm-sr">
                {#if rotationHasPending}{t('a11y.committee.remove.rotation.done_pending', {
                    count: rotationPendingCount
                  })}{:else}{t('a11y.committee.remove.rotation.done')}{/if}
              </span>
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.manage.close')}
              </button>
            </div>
          </div>
        {:else if phase === 'rotationIncomplete'}
          <!-- LOUD terminal (role="alert", amber) + Resume. Does NOT claim future
               access is cut; existing records are still readable. -->
          <div
            class="mm-alert mm-alert-warning"
            role="alert"
            data-testid="committee-manage-rotation-incomplete"
          >
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linejoin="round"
              />
              <path
                d="M12 9v4"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
              <circle cx="12" cy="17" r="1" fill="currentColor" />
            </svg>
            <div>
              <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={rotationIncompleteHeadingEl}
              >
                {t('committee.remove.rotationIncomplete.heading')}
              </h2>
              <p class="mm-alert-body">{t('committee.remove.rotationIncomplete.body')}</p>
              <span class="mm-sr">{t('a11y.committee.remove.rotation.incomplete')}</span>
              <div class="mm-actions">
                <button
                  type="button"
                  class="mm-confirm"
                  data-testid="committee-manage-rotation-resume"
                  on:click={onResume}
                >
                  {t('committee.remove.rotationIncomplete.resume_cta')}
                </button>
                <button type="button" class="btn-outline" on:click={closePanel}>
                  {t('committee.manage.close')}
                </button>
              </div>
            </div>
          </div>
        {:else if phase === 'rotationOrphaned'}
          <!-- LOUD terminal (role="alert", red) + Re-run FRESH. -->
          <div
            class="mm-alert mm-alert-danger"
            role="alert"
            data-testid="committee-manage-rotation-orphaned"
          >
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m15 9-6 6m0-6 6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={rotationOrphanedHeadingEl}
              >
                {t('committee.remove.rotationOrphaned.heading')}
              </h2>
              <p class="mm-alert-body">{t('committee.remove.rotationOrphaned.body')}</p>
              <span class="mm-sr">{t('a11y.committee.remove.rotation.orphaned')}</span>
              <div class="mm-actions">
                <button
                  type="button"
                  class="mm-confirm"
                  data-testid="committee-manage-rotation-rerun"
                  on:click={onRerun}
                >
                  {t('committee.remove.rotationOrphaned.rerun_cta')}
                </button>
                <button type="button" class="btn-outline" on:click={closePanel}>
                  {t('committee.manage.close')}
                </button>
              </div>
            </div>
          </div>
        {:else if phase === 'rotationCannotResume'}
          <!-- LOUD terminal (role="alert", red). No in-session completion is
               offered (F182-5 deferred): Close only, NO cross-session control. -->
          <div
            class="mm-alert mm-alert-danger"
            role="alert"
            data-testid="committee-manage-rotation-cannot-resume"
          >
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m15 9-6 6m0-6 6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={rotationCannotResumeHeadingEl}
              >
                {t('committee.remove.rotationCannotResume.heading')}
              </h2>
              <p class="mm-alert-body">{t('committee.remove.rotationCannotResume.body')}</p>
              <span class="mm-sr">{t('a11y.committee.remove.rotation.cannotResume')}</span>
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.manage.close')}
              </button>
            </div>
          </div>
        {:else if phase === 'rotationFailed'}
          <!-- LOUD terminal (role="alert", red) — DISTINCT from the governance
               `failed` terminal. Per-reason affordance (raw enum never rendered,
               F-176). -->
          <div
            class="mm-alert mm-alert-danger"
            role="alert"
            data-testid="committee-manage-rotation-failed"
          >
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m15 9-6 6m0-6 6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <p class="mm-eyebrow">{t('committee.remove.rotation.status_removed')}</p>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={rotationFailedHeadingEl}
              >
                {t('committee.remove.rotationFailed.heading')}
              </h2>
              <p class="mm-alert-body">{t(rotationFailedBodyKey)}</p>
              <span class="mm-sr">{t('a11y.committee.remove.rotation.failed')}</span>
              <div class="mm-actions">
                {#if rotationFailedAffordance === 'retry'}
                  <button
                    type="button"
                    class="mm-confirm"
                    data-testid="committee-manage-rotation-retry"
                    on:click={onRotationRetry}
                  >
                    {t('committee.remove.rotationFailed.retry_cta')}
                  </button>
                {:else if rotationFailedAffordance === 'signin'}
                  <a
                    class="mm-confirm mm-confirm-link"
                    href="/sign-in"
                    data-testid="committee-manage-rotation-signin"
                  >
                    {t('committee.remove.rotationFailed.signin_cta')}
                  </a>
                {/if}
                <!-- Adversarial F1: the needs_recovery / no_wrap recovery path is
                     MESSAGE-ONLY (mirrors the app's Concern/Reprisal needs_recovery
                     pattern) — the body already tells the user to restore committee-
                     key access on this device. It renders NO affordance beyond
                     Close; a /sign-in link belongs only to the session_expiry path
                     above (a different destination). -->
                <button type="button" class="btn-outline" on:click={closePanel}>
                  {t('committee.manage.close')}
                </button>
              </div>
            </div>
          </div>
        {:else if phase === 'lastCoChair'}
          <!-- Server-truthed block, keyed off `reason === 'last_co_chair'` (never a
               client count). Names NO member (F-160): generic "another worker
               co-chair", never a proper name. Single Close — no Retry (an unchanged
               retry cannot change the answer). -->
          <div
            class="mm-alert mm-alert-danger"
            role="alert"
            data-testid="committee-manage-last-co-chair"
          >
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m15 9-6 6m0-6 6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={lastCoChairHeadingEl}
              >
                {t('committee.manage.lastCoChair.heading')}
              </h2>
              <p class="mm-alert-body">{t('committee.manage.lastCoChair.body')}</p>
              <span class="mm-sr">{t('a11y.committee.manage.lastCoChair')}</span>
              <button type="button" class="btn-outline" on:click={closePanel}>
                {t('committee.manage.close')}
              </button>
            </div>
          </div>
        {:else if phase === 'failed'}
          <!-- Reason-mapped body (never the raw enum — F-176), names NO member
               (F-160). No identity line here. -->
          <div class="mm-alert mm-alert-danger" role="alert" data-testid="committee-manage-failed">
            <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
              <path
                d="m15 9-6 6m0-6 6 6"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              />
            </svg>
            <div>
              <h2
                id={dialogHeadingId}
                class="mm-alert-heading"
                tabindex="-1"
                bind:this={failedHeadingEl}
              >
                {t('committee.manage.failed.heading')}
              </h2>
              <p class="mm-alert-body">{t(failedBodyKey)}</p>
              <span class="mm-sr">{t('a11y.committee.manage.failed')}</span>
              <div class="mm-actions">
                {#if failedRetryable}
                  <button type="button" class="mm-confirm" on:click={onRetry}>
                    {t('committee.manage.retry')}
                  </button>
                {:else}
                  <button type="button" class="mm-confirm" on:click={onReload}>
                    {t('committee.manage.reload')}
                  </button>
                {/if}
                <button type="button" class="btn-outline" on:click={closePanel}>
                  {t('committee.manage.close')}
                </button>
              </div>
            </div>
          </div>
        {:else}
          <!-- form / submitting / fourEyes -->
          <h2 id={dialogHeadingId} class="mm-heading" tabindex="-1" bind:this={headingEl}>
            {modalHeading}
          </h2>

          <!-- Identity line (name, or unnamed + 8-char uid) — mirrors the roster
               row. Confirm copy MAY name the member being acted on. -->
          <p class="mm-member">
            {#if member.display_name}
              <span class="mm-member-name">{member.display_name}</span>
            {:else}
              <span class="mm-member-unnamed">{t('committee.roster.row.unnamed')}</span>
              <span class="mm-member-uid">{member.user_id.slice(0, 8)}</span>
            {/if}
          </p>

          {#if openModal === 'role'}
            <p class="mm-lead">{t('committee.role.modal.lead', { name: nameForCopy })}</p>
            <fieldset class="mm-fieldset">
              <legend class="mm-legend">{t('committee.role.modal.roles_legend')}</legend>
              <div class="mm-role-row">
                <input
                  id={`${approverSelectId}-role-co-chair`}
                  type="checkbox"
                  bind:checked={roleCoChair}
                  disabled={phase === 'submitting'}
                />
                <label for={`${approverSelectId}-role-co-chair`}>
                  {t('committee.roster.role.worker_co_chair')}
                </label>
              </div>
              <div class="mm-role-row">
                <input
                  id={`${approverSelectId}-role-worker-member`}
                  type="checkbox"
                  bind:checked={roleWorkerMember}
                  disabled={phase === 'submitting'}
                />
                <label for={`${approverSelectId}-role-worker-member`}>
                  {t('committee.roster.role.worker_member')}
                </label>
              </div>
              <div class="mm-role-row">
                <input
                  id={`${approverSelectId}-role-certified-member`}
                  type="checkbox"
                  bind:checked={roleCertified}
                  disabled={phase === 'submitting'}
                />
                <label for={`${approverSelectId}-role-certified-member`}>
                  {t('committee.roster.role.certified_member')}
                </label>
              </div>
            </fieldset>
            {#if isSelf}
              <p class="mm-note">{t('committee.role.modal.self_note')}</p>
            {/if}
            {#if !rolesChanged}
              <p class="mm-note" id={`${approverSelectId}-nochange`}>
                {t('committee.role.modal.no_changes_hint')}
              </p>
            {:else if emptyRoleSelection}
              <!-- A11Y-3: the empty-role gate now carries its own discoverable hint
                   (aria-describedby target for the gated Confirm). -->
              <p class="mm-note" id={`${approverSelectId}-empty-roles`}>
                {t('committee.role.modal.empty_selection_hint')}
              </p>
            {/if}
          {:else if openModal === 'remove'}
            <p class="mm-body">{t('committee.remove.modal.what', { name: nameForCopy })}</p>
            <!-- F-182 honest limit: removal AUTO-ROTATES the committee key (forward
                 secrecy — it cuts access to committee data filed from now on, and
                 cannot reach records the member already opened). NO absolute/
                 retroactive data-access-revocation claim (a string test forbids it).
                 Self-removal is the exception: the leaver can't run the rotation from
                 this device, so the self variant states a remaining worker co-chair
                 must still rotate the key (F-189 / Adversarial F2 — it must not
                 promise a rotation the self path skips). -->
            <p class="mm-body mm-limit">
              {#if isSelf}
                {t('committee.remove.modal.limit_self', { name: nameForCopy })}
              {:else}
                {t('committee.remove.modal.limit', { name: nameForCopy })}
              {/if}
            </p>
            {#if isSelf}
              <p class="mm-note">{t('committee.remove.modal.self_note')}</p>
            {/if}
          {:else if openModal === 'reactivate'}
            <p class="mm-body">{t('committee.reactivate.modal.what', { name: nameForCopy })}</p>
            <!-- F-182 retained-wrap honesty: access returns via the wrap the device
                 already had — nothing is re-issued, no fresh grant ceremony. -->
            <p class="mm-body mm-wrap">
              {t('committee.reactivate.modal.wrap', { name: nameForCopy })}
            </p>
          {/if}

          {#if phase === 'fourEyes'}
            <!-- Assertive governance alert — the user acted and must now choose an
                 approver. Names NO member (F-160): the picker (with names) sits
                 OUTSIDE this block. -->
            <div
              class="mm-alert mm-alert-warning"
              role="alert"
              data-testid="committee-manage-4eyes"
            >
              <svg class="mm-alert-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linejoin="round"
                />
                <path
                  d="M12 9v4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <circle cx="12" cy="17" r="1" fill="currentColor" />
              </svg>
              <div>
                <h3 class="mm-alert-heading" tabindex="-1" bind:this={fourEyesHeadingEl}>
                  {t('committee.manage.fourEyes.heading')}
                </h3>
                <p class="mm-alert-body">{t('committee.manage.fourEyes.body')}</p>
                <span class="mm-sr">{t('a11y.committee.manage.fourEyes')}</span>
              </div>
            </div>
          {/if}

          {#if showPicker}
            <!-- The second-approver picker — a native <select> (robust NVDA /
                 VoiceOver / TalkBack). Options exclude self by construction, so the
                 pick is distinct; keyed off active + role, so a pending_grant
                 co-chair is still offered. -->
            <div class="mm-callout mm-callout-info">
              <div>
                <h3 class="mm-callout-heading">{t('committee.approver.heading')}</h3>
                <!-- A11Y-3: the aria-describedby target for the approver-required
                     gated Confirm (a discoverable hint, not just visual context). -->
                <p class="mm-callout-body" id={`${approverSelectId}-approver-hint`}>
                  {t('committee.approver.explain')}
                </p>
              </div>
            </div>
            {#if staleApprover}
              <p class="mm-note mm-stale">{t('committee.approver.stale')}</p>
            {/if}
            <label class="mm-picker-label" for={approverSelectId}>
              {t('committee.approver.select_label')}
            </label>
            <select
              id={approverSelectId}
              class="mm-select"
              value={selectedApprover}
              aria-required="true"
              disabled={phase === 'submitting'}
              on:change={onApproverChange}
            >
              <option value="" disabled>{t('committee.approver.select_placeholder')}</option>
              {#each eligibleApprovers as appr (appr.user_id)}
                <option value={appr.user_id}>{approverLabel(appr)}</option>
              {/each}
            </select>
            <span class="mm-sr" role="status" aria-live="polite">{approverAnnounce}</span>
          {:else if staleFourEyesNoPicker}
            <!-- ADV-3: the server returned 4eyes_required but the local snapshot
                 shows no eligible co-chair (one was added elsewhere). A single
                 coherent recovery — refetch the roster to reveal the new approver.
                 NO contradictory empty-approver note here; Confirm is gated. -->
            <div class="mm-callout mm-callout-info" role="status">
              <svg class="mm-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
                <path
                  d="M12 11v5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <path
                  d="M12 8h.01"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
              <div>
                <h3 class="mm-callout-heading">{t('committee.approver.refetch_heading')}</h3>
                <p class="mm-callout-body">{t('committee.approver.refetch_body')}</p>
                <button
                  type="button"
                  class="btn-outline mm-refetch"
                  data-testid="committee-manage-refetch-approver"
                  on:click={onRefetchApprover}
                >
                  {t('committee.approver.refetch_cta')}
                </button>
              </div>
            </div>
          {:else if emptyEligibleNote}
            <!-- The actor is (client-side) the only active worker co-chair. No
                 picker, Confirm stays ENABLED — the server truths last_co_chair
                 (this note is an advisory heads-up, NOT a client-side gate). -->
            <div class="mm-callout mm-callout-info" role="status">
              <svg class="mm-callout-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
                <path
                  d="M12 11v5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
                <path
                  d="M12 8h.01"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
              <div>
                <h3 class="mm-callout-heading">{t('committee.approver.none_heading')}</h3>
                <p class="mm-callout-body">{t('committee.approver.none_body')}</p>
              </div>
            </div>
          {/if}

          <!-- Actions. The affirmative CTA is the SAME <button> across
               form→submitting (A11Y-3 focus-order): during `submitting` it becomes
               an aria-busy / aria-disabled loading button naming the literal action
               inside itself. The gated pre-submit state is aria-disabled ONLY —
               NEVER native `disabled` (which would drop it from the tab order and
               hide its aria-describedby hint); the `if (confirmGated) return;`
               no-op guard in onConfirm makes a gated click fire nothing. -->
          <div class="mm-actions">
            <button
              type="button"
              class="mm-confirm"
              class:btn-destructive={openModal === 'remove'}
              data-testid={phase === 'submitting' ? 'committee-manage-submitting' : undefined}
              aria-busy={phase === 'submitting' ? 'true' : undefined}
              aria-disabled={phase === 'submitting' ? 'true' : confirmGated ? 'true' : undefined}
              aria-describedby={confirmDescribedBy}
              on:click={onConfirm}
            >
              {#if phase === 'submitting'}{submittingLabel}{:else}{confirmLabel}{/if}
            </button>
            <button
              type="button"
              class="btn-outline"
              disabled={phase === 'submitting'}
              on:click={closePanel}
            >
              {cancelLabel}
            </button>
          </div>

          {#if phase === 'submitting'}
            <span class="mm-sr" role="status" aria-live="polite">{submittingAnnounce}</span>
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Colour / radius / shadow / border bind to the app CSS-variable token palette
     (app.html boot sheet); the two-layer AODA focus ring is inherited from
     app.css :focus-visible on every native control. Spacing + type sizing use rem
     literals matching the sibling CommitteeGrantCard / CommitteeInvite convention
     (this project exposes no spacing-scale custom properties). No raw colour
     literals: the scrim is a var(--token, fallback) (the documented boot-race
     defense the token gate elides). */
  .mm-root {
    margin-block-start: 0.5rem;
    display: grid;
    justify-items: start;
    gap: 0.375rem;
  }

  /* "You" chip — the neutral status pill (text, never colour-only). */
  .mm-you {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.4rem;
    border: var(--border-width-hairline) solid var(--color-tint-neutral-border);
    border-radius: var(--radius-sm);
    background: var(--color-tint-neutral-bg);
    color: var(--color-tint-neutral-fg);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .mm-actions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .mm-cta {
    align-self: start;
  }
  .mm-cta-icon {
    width: 1rem;
    height: 1rem;
    flex: none;
  }

  /* Modal scrim — fixed-position viewport overlay; the dialog is centred, with
     vertical scroll allowed on short viewports. The scrim colour is the
     background.scrim token with a documented fallback. */
  .mm-backdrop {
    position: fixed;
    inset: 0;
    /* z_index.modal (design-tokens.json) — the shared modal layer, 1300. (NOT the
       PanicWipeModal layer, which is the lower z_index:50 lock-screen chrome.) */
    z-index: 1300;
    display: grid;
    place-items: center;
    padding: 1rem;
    overflow-y: auto;
    background: var(--color-scrim, rgba(15, 23, 42, 0.56));
  }
  @media (prefers-color-scheme: dark) {
    .mm-backdrop {
      background: var(--color-scrim, rgba(0, 0, 0, 0.72));
    }
  }

  .mm-dialog {
    width: 100%;
    max-width: 32rem;
    margin: auto;
    box-shadow: var(--shadow-lg);
  }
  .mm-dialog > :first-child {
    margin-block-start: 0;
  }
  .mm-dialog > :last-child {
    margin-block-end: 0;
  }

  .mm-heading {
    margin: 0 0 0.5rem;
    font-size: 1.0625rem;
    color: var(--color-fg);
  }
  .mm-member {
    margin: 0 0 0.75rem;
    color: var(--color-fg);
  }
  .mm-member-name {
    font-weight: 600;
  }
  .mm-member-unnamed {
    font-weight: 500;
    color: var(--color-fg-muted);
  }
  .mm-member-uid {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  .mm-lead {
    margin: 0 0 0.75rem;
    color: var(--color-fg);
  }
  .mm-body {
    margin: 0 0 0.75rem;
    color: var(--color-fg);
    font-size: 0.9375rem;
  }
  .mm-limit,
  .mm-wrap {
    color: var(--color-fg-muted);
    font-size: 0.875rem;
  }
  .mm-note {
    margin: 0 0 0.75rem;
    color: var(--color-fg-muted);
    font-size: 0.8125rem;
  }
  /* A11Y-5: amber-fg is only an audited pair against amber-bg — never the plain
     modal surface. Wrap the stale note in the amber tint so the pairing is the
     audited one (mirrors the .mm-alert-warning treatment). */
  .mm-stale {
    padding: 0.5rem 0.75rem;
    border: var(--border-width-hairline) solid var(--color-tint-amber-border);
    border-radius: var(--radius-sm);
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
  }
  .mm-refetch {
    margin-block-start: 0.5rem;
  }

  .mm-fieldset {
    margin: 0 0 0.75rem;
    padding: 0;
    border: 0;
    display: grid;
    gap: 0.75rem;
  }
  .mm-legend {
    padding: 0;
    margin-block-end: 0.5rem;
    font-weight: 600;
    color: var(--color-fg);
  }
  .mm-role-row {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    column-gap: 0.5rem;
    /* ≥44px clickable area per role while the glyph stays visually small. */
    min-height: 2.75rem;
  }
  .mm-role-row input[type='checkbox'] {
    min-height: auto;
    width: 1.15rem;
    height: 1.15rem;
    accent-color: var(--color-accent);
  }
  .mm-role-row label {
    display: flex;
    align-items: center;
    min-height: 2.75rem;
    color: var(--color-fg);
    font-weight: 500;
  }

  .mm-picker-label {
    display: block;
    margin-block: 0.5rem 0.375rem;
    font-weight: 500;
    color: var(--color-fg);
  }
  .mm-select {
    display: block;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: var(--border-width-hairline) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-bg-elevated);
    color: var(--color-fg);
    font-family: inherit;
    font-size: 0.9375rem;
  }
  .mm-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .mm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.625rem;
    align-items: center;
    margin-block-start: 1rem;
  }
  .mm-confirm {
    background: var(--color-accent);
    color: var(--color-accent-fg);
    border-color: var(--color-accent);
  }
  .mm-confirm:hover:not(:disabled) {
    background: var(--color-accent-hover);
    border-color: var(--color-accent-hover);
    opacity: 1;
  }
  .mm-confirm[aria-disabled='true'] {
    cursor: progress;
  }
  .mm-confirm.btn-destructive {
    background: var(--color-destructive);
    color: var(--color-destructive-fg);
    border-color: var(--color-destructive);
  }

  /* Callouts + alerts — each pairs its tint with an icon AND text (never
     colour-only, anti-pattern #3). */
  .mm-callout {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block: 0.75rem;
    padding: 0.75rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-inline-start-width: var(--border-width-thick);
    border-radius: var(--radius-md);
  }
  .mm-callout-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .mm-callout-heading {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .mm-callout-body {
    margin-block: 0.25rem 0;
    font-size: 0.875rem;
  }
  .mm-callout-info {
    background: var(--color-tint-blue-bg);
    color: var(--color-tint-blue-fg);
    border-color: var(--color-tint-blue-border);
  }

  .mm-alert {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    margin-block: 0.75rem;
    padding: 0.875rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .mm-alert-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .mm-alert-heading {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .mm-alert-body {
    margin-block: 0.25rem 0.75rem;
    font-size: 0.9375rem;
  }
  .mm-alert-warning {
    background: var(--color-tint-amber-bg);
    color: var(--color-tint-amber-fg);
    border-color: var(--color-tint-amber-border);
  }
  .mm-alert-danger {
    background: var(--color-tint-red-bg);
    color: var(--color-tint-red-fg);
    border-color: var(--color-tint-red-border);
  }

  .mm-terminal {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
    padding: 0.875rem 1rem;
    border: var(--border-width-default) solid transparent;
    border-radius: var(--radius-md);
  }
  .mm-terminal-icon {
    width: 1.25rem;
    height: 1.25rem;
    flex: none;
    margin-block-start: 0.125rem;
  }
  .mm-terminal-heading {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .mm-terminal-body {
    margin-block: 0.25rem 0.75rem;
    font-size: 0.9375rem;
  }
  .mm-success {
    background: var(--color-tint-green-bg);
    color: var(--color-tint-green-fg);
    border-color: var(--color-tint-green-border);
  }

  /* F182-6 — the neutral "Membership: removed" eyebrow above each rotation
     terminal heading (the governance fact is separate from the crypto outcome). */
  .mm-eyebrow {
    margin: 0 0 0.25rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    /* On the plain card surface (the `rotating` sub-phase) the muted-fg pairing IS
       audited. */
    color: var(--color-fg-muted);
  }
  /* WCAG 1.4.3 — on a tinted terminal/alert background the muted grey drops below
     4.5:1; inherit the audited tint foreground (currentColor === the tint fg the
     container sets) instead. */
  .mm-alert .mm-eyebrow,
  .mm-terminal .mm-eyebrow {
    color: currentColor;
  }
  .mm-rotating {
    display: grid;
    gap: 0.5rem;
  }
  /* Anchor styled as the affirmative CTA (sign-in route). Unlike <button>/.btn it
     does not match the global button base, so it carries the ≥44px touch target +
     inline padding itself (matches the app.css button/cta convention). */
  .mm-confirm-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding-inline: 1rem;
    text-decoration: none;
  }

  .mm-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
</style>
