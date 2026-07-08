/**
 * SupabaseCommitteeClient — production-shaped client for the committee-op
 * Edge Function (ADR-0029 P1-3).
 *
 * Same design rationale as SupabaseT07Client / SupabaseConcernClient /
 * SupabaseReprisalClient: the test orchestrator decomposes high-level
 * committee governance ops into many small steps; production folds them
 * into one SECURITY DEFINER SQL function per high-level op
 * (`issue_member_invite` from migration 0041, the existing
 * `committee_invite_member` / `committee_activate_membership` /
 * `committee_set_roles` / `committee_remove_member` /
 * `committee_reactivate_member` from migration 0002). This class exposes
 * the high-level ops 1:1 with the committee-op Edge Function arms.
 *
 * Wire format: every op POSTs `{ op: <name>, ...args }` JSON to committee-op
 * with the caller's JWT in `Authorization: Bearer`. The Edge Function
 * dispatches to the corresponding SQL function and returns
 * `{ ok: true, data: ... } | { ok: false, error: <CommitteeOpReason>, status: <http> }`
 * mirroring `supabase/functions/committee-op/core.ts`.
 *
 * F-176 / Decision 8 (ADR-0029): the raw 6-digit `code` rides the
 * `issueInvite` body to the Edge Function and is returned to the caller
 * IN-MEMORY only via the response wire shape. This client MUST NOT log it,
 * MUST NOT persist it (sessionStorage / localStorage / URL), and MUST NOT
 * route it through any wrapped-error path. The caller (the co-chair UI in
 * P1-8) owns the single user-visible emission.
 *
 * Transport injection: the constructor takes a transport function so this
 * module has zero runtime dependency on `@supabase/supabase-js`. Production
 * callers wire `transport` via `createSupabaseCommitteeClient`
 * (server-client/factory peer of t07/concern/reprisal/t14); tests inject a
 * stub that records calls.
 *
 * Single-tenant by construction: this module is sibling to the rest of
 * lib/committee/ — no per-group identifier is threaded through any op
 * (a CI test under apps/web/test/T06 asserts the absence of that string
 * across every .ts file in this folder).
 */

// ---------------------------------------------------------------------------
// Wire shape — mirrors supabase/functions/committee-op/core.ts CommitteeReason.
// ---------------------------------------------------------------------------

export type CommitteeOpReason =
  | 'rls_denied'
  | '4eyes_required'
  | 'last_co_chair'
  | 'invalid_role'
  | 'employer_contact_rejected'
  | 'not_found'
  | 'invite_invalid'
  | 'already_active'
  | 'membership_exists'
  | 'unknown';

export type CommitteeOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: CommitteeOpReason; status: number };

/**
 * Edge Function transport. Returns the parsed JSON body + the response
 * status. Implementations live next to whichever Supabase client the
 * caller uses; see `createSupabaseCommitteeClient` for the production wire.
 */
export type CommitteeOpTransport = (
  body: Record<string, unknown>
) => Promise<{ status: number; body: unknown }>;

interface CommitteeOpWireOk<T> {
  ok: true;
  data: T;
}
interface CommitteeOpWireErr {
  ok: false;
  error: CommitteeOpReason;
}

async function invoke<T>(
  transport: CommitteeOpTransport,
  body: Record<string, unknown>
): Promise<CommitteeOpResult<T>> {
  const r = await transport(body);
  const payload = r.body as Partial<CommitteeOpWireOk<T>> & Partial<CommitteeOpWireErr>;
  if (payload && payload.ok === true) {
    return { ok: true, data: payload.data as T };
  }
  const reason: CommitteeOpReason = (payload?.error as CommitteeOpReason | undefined) ?? 'unknown';
  return { ok: false, reason, status: r.status };
}

// ---------------------------------------------------------------------------
// SupabaseCommitteeClient
// ---------------------------------------------------------------------------

export interface SupabaseCommitteeClientOptions {
  transport: CommitteeOpTransport;
}

/** The single-row keystone return — see migration 0041:54-58. */
export interface IssueInviteData {
  invite_id: string;
  invitee_user_id: string;
  bootstrap_id: string;
}

/** The "re-send code" return — see migration 0043 / Amendment A-7.3. */
export interface ReissueTotpData {
  invite_id: string;
  bootstrap_id: string;
}

/**
 * ADR-0029 P1-8a — one roster row (Amendment A-8.1 / A-8.3). The 11 pinned
 * columns of `committee_roster_list`, column-for-column: the member's PI
 * (display_name / off_employer_contact, NULL when the member has no users PI)
 * + the two grant-state BADGE booleans. The UI derives the badges — `active`,
 * `pending-invite`, `pending-grant` (`has_identity_key && !has_live_wrap`),
 * `awaiting-identity` (invited but `!has_identity_key`) — from these fields.
 */
export interface RosterRow {
  user_id: string;
  roles: string[];
  active: boolean;
  invited_at: string;
  activated_at: string | null;
  deactivated_at: string | null;
  grace_until: string | null;
  display_name: string | null;
  off_employer_contact: string | null;
  has_identity_key: boolean;
  has_live_wrap: boolean;
}

/**
 * ADR-0029 P1-8a — one pending-invite row (Amendment A-8.2 / A-8.3). The 6
 * pinned columns of `committee_invite_list_pending`. 🔒 NO `bootstrap_id` /
 * secret material (the SQL fn excludes the invite's TOTP-bootstrap FK by
 * construction and reads no TOTP-secret store, F-178). `expires_at` is the
 * INVITE TTL (7 days), never a TOTP window; `display_name` is the target's PI
 * (NULL when absent).
 */
export interface PendingInvite {
  invite_id: string;
  target_user_id: string;
  display_name: string | null;
  roles: string[];
  issued_at: string;
  expires_at: string;
}

export class SupabaseCommitteeClient {
  constructor(private opts: SupabaseCommitteeClientOptions) {}

  /**
   * ADR-0029 P1-3 — co-chair issues an invite. The keystone runs SQL-side:
   * co-chair gate + role validation + invitee `public.users` row + TOTP
   * bootstrap (HMAC at rest, 15-min TTL) + `committee_invite_member`
   * delegation, all in one txn. The raw 6-digit code rides this method's
   * input + the wire body ONLY; it is never logged, never persisted, and
   * the client does NOT echo it back on the result (callers already hold
   * it in memory). F-176 / Decision 8.
   */
  issueInvite(input: {
    roles: string[];
    code: string;
    ttl_minutes: number;
  }): Promise<CommitteeOpResult<IssueInviteData>> {
    return invoke<IssueInviteData>(this.opts.transport, {
      op: 'issue_invite',
      roles: input.roles,
      code: input.code,
      ttl_minutes: input.ttl_minutes
    });
  }

  /**
   * ADR-0029 P1-6 — co-chair "re-send code". Re-arms a FRESH 15-min TOTP
   * against an EXISTING, still-unconsumed invite (the 15-min TOTP expires long
   * before the 7-day invite TTL). The SQL fn `reissue_member_totp` swaps ONLY
   * the bootstrap row (delete-then-insert under the UNIQUE(user_id) cap-of-1;
   * the OLD code dies), re-points the invite's bootstrap_id, and emits the
   * success-only `member.totp_reissued` audit event — leaving the user / invite
   * / membership untouched.
   *
   * Re-send is a SIBLING of `issueInvite`: it carries NO `ttl_minutes` and NO
   * `roles` (those are server-bound at issue and untouched by re-send — a body
   * that threaded ttl_minutes would invite a "re-send extends the invite" bug).
   *
   * F-176 / Decision 8: the raw 6-digit `code` rides this method's input + the
   * wire body ONLY; it is returned to the caller IN-MEMORY only via the response
   * shape. This client MUST NOT log it, persist it (sessionStorage / localStorage
   * / URL), or route it through any wrapped-error path. The link still carries
   * only `invite_id`, never the code.
   */
  reissueTotp(input: {
    invite_id: string;
    code: string;
  }): Promise<CommitteeOpResult<ReissueTotpData>> {
    return invoke<ReissueTotpData>(this.opts.transport, {
      op: 'reissue_totp',
      invite_id: input.invite_id,
      code: input.code
    });
  }

  /**
   * ADR-0029 P1-8a — the co-chair roster read (Amendment A-8.1 / A-8.3). POSTs
   * a PARAMETERLESS `{ op: 'list_roster' }` to committee-op (the co-chair
   * identity is the JWT-bound `auth.uid()`, the roster is whole-committee — no
   * target uid / filter is threaded). The underlying RPC is SETOF, so the
   * result unwraps to a `RosterRow[]` on `data`. The server co-chair gate
   * (F-178) RAISEs `rls_denied` (403) for a non-co-chair — the /committee route
   * treats that as "not authorized" (A-8.4). F-176: this client MUST NOT log or
   * persist any returned member PI / raw uid.
   */
  listRoster(): Promise<CommitteeOpResult<RosterRow[]>> {
    return invoke<RosterRow[]>(this.opts.transport, { op: 'list_roster' });
  }

  /**
   * ADR-0029 P1-8a — the co-chair pending-invite read (Amendment A-8.2 /
   * A-8.3). SIBLING of `listRoster`: POSTs a parameterless
   * `{ op: 'list_pending_invites' }` and unwraps the SETOF result to a
   * `PendingInvite[]`. 🔒 The rows carry the 6 pinned columns ONLY — never
   * `bootstrap_id` / secret material (F-178). Same F-176 PI-free posture.
   */
  listPendingInvites(): Promise<CommitteeOpResult<PendingInvite[]>> {
    return invoke<PendingInvite[]>(this.opts.transport, { op: 'list_pending_invites' });
  }
}
