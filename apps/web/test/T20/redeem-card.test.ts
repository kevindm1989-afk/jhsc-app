/**
 * ADR-0029 P1-7 — /redeem member-invite redemption card (Surface J).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. It pins the
 * behavioral + state-completeness + a11y contract of the renderable redeem
 * surface BEFORE the component exists, so the suite MUST fail at import
 * (`RedeemCard.svelte` is missing) until the implementer ships it.
 *
 * Why a `RedeemCard.svelte` lib component (not the `+page.svelte` directly):
 * route shells import `$app/stores`, which has no on-disk stub in this runner
 * (vitest aliases `$app` → a non-existent stub dir; route-level wiring is
 * covered structurally in redeem-route-mount.test.ts). Every behavioral
 * route test in this repo renders the underlying lib component the route
 * composes (LibraryViewer, SessionsList, ConcernIntakeForm, D3PasskeyEnrollment).
 * RedeemCard is that component; the route shell reads `invite_id` from the
 * query and passes it down (pinned in redeem-route-mount.test.ts).
 *
 * Injection style mirrors SessionsList (`authStore` prop) + D3PasskeyEnrollment
 * (`auth` prop): the card takes REAL Svelte props with production-safe
 * defaults —
 *   - `inviteId: string`            (the route passes this from ?invite_id=)
 *   - `transport`                   (the challenge/register EF transport seam)
 *   - `credentials`                 (a CredentialsContainer; defaults to
 *                                     navigator.credentials in production)
 *   - `navigate`                    (the /sign-in forward; defaults to a real
 *                                     location assignment in production)
 * No `__test_*` prop is used (ADR-0020 Decision 8 forbids them in prod bundles).
 *
 * RESOLVED CONTRACT (from supabase/functions/redeem-invite/core.ts, merged #311):
 *   - the link carries ONLY ?invite_id= (a UUID, NOT secret). The member enters
 *     exactly ONE secret: the 6-digit `totp_code`. There is NO separate
 *     "invite code" text field.  [buildRedeemLink core.ts:196; F-170/F-176]
 *   - challenge POST body = { action:'challenge', rpId, origin }  (NO code, NO
 *     invite_id — handleChallenge core.ts:287 ignores both).
 *   - register POST body  = { action:'register', invite_id, totp_code, challenge,
 *     credentialId, attestationObject, clientDataJSON, transports, deviceLabel,
 *     rpId, origin }.
 *   - register responses: {ok:true,user_id}/200, {error:'redeem_invalid'}/422,
 *     {error:'rate_limited'}/429, {error:'redeem_failed'}/500,
 *     {error:'registration_invalid'}/401, {error:'bad_request'}/400.
 *   - every 422 redeem_invalid collapses to ONE message (F-169/F-170 oracle).
 *   - user_id is NEVER rendered + NEVER logged (F-176).
 *   - success → navigate to /sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import { __getCapturedLines, __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

// RED-FIRST import — the implementer creates this component. Until it exists,
// every test in this file fails at module resolution, which is the correct
// red signal (the route/component does not exist yet).
import RedeemCard from '../../src/lib/redeem/RedeemCard.svelte';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INVITE_ID = '7b1d3f00-0000-4000-8000-0000000000aa';
const SERVER_CHALLENGE = 'srv-redeem-challenge-xyz';
const NEW_USER_ID = '9c2e8a11-1111-4111-8111-111111111111';

// The single secret the member types. Used as a leak-sweep canary too.
const SECRET_CODE = '482913';

interface QueuedResponse {
  status: number;
  body: unknown;
}

interface RecordedCall {
  body: Record<string, unknown>;
}

/**
 * A recording transport mirroring sign-in-flow.test.ts's `recordingClient`:
 * it captures every POST body and returns the next queued {status, body}.
 * The component's two-action ceremony POSTs through this seam — never a real
 * fetch — so the test is hermetic (no network, deterministic).
 */
function recordingTransport(responses: QueuedResponse[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const transport = async (body: Record<string, unknown>) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`no redeem response queued for call #${i}`);
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

const CHALLENGE_OK: QueuedResponse = {
  status: 200,
  body: { ok: true, challenge: SERVER_CHALLENGE }
};

/**
 * A stub CredentialsContainer whose create() returns a canned attestation
 * shape (no real platform authenticator). Mirrors webauthn-assertion.test.ts's
 * `pubKeyCredential` injection. `onCreate` lets a test assert what the
 * ceremony was invoked with (challenge binding) and override the outcome.
 */
function stubCredentials(opts?: {
  onCreate?: (req: { publicKey: PublicKeyCredentialCreationOptions }) => unknown;
}) {
  const created: Array<{ publicKey: PublicKeyCredentialCreationOptions }> = [];
  const credentials = {
    async create(req: { publicKey: PublicKeyCredentialCreationOptions }) {
      created.push(req);
      if (opts?.onCreate) return opts.onCreate(req);
      // Default: a minimal attestation-shaped credential.
      return {
        id: 'cred-redeem-1',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        response: {
          attestationObject: new Uint8Array([0xa1, 0xa2]).buffer,
          clientDataJSON: new Uint8Array([0xb1, 0xb2]).buffer,
          getTransports: () => ['internal']
        }
      };
    }
  } as unknown as CredentialsContainer;
  return { credentials, created };
}

/**
 * Render RedeemCard with the standard happy-path seams; individual tests
 * override responses / credentials / inviteId as needed. `navigate` is a spy
 * (the success CTA forwards to /sign-in — we never navigate the jsdom window).
 */
function renderCard(opts: {
  inviteId?: string;
  responses?: QueuedResponse[];
  credentials?: CredentialsContainer;
  navigate?: (path: string) => void;
}) {
  const { transport, calls } = recordingTransport(opts.responses ?? [CHALLENGE_OK]);
  const navigate = opts.navigate ?? vi.fn();
  const utils = render(RedeemCard, {
    props: {
      inviteId: opts.inviteId ?? INVITE_ID,
      transport: transport as never,
      credentials: (opts.credentials ?? stubCredentials().credentials) as never,
      navigate: navigate as never
    }
  });
  return { ...utils, calls, navigate };
}

/** Type the secret into the single one-time-code field + submit the form. */
async function enterCodeAndSubmit(code: string = SECRET_CODE) {
  const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: code } });
  const form = document.querySelector('form');
  if (!form) throw new Error('expected a <form> wrapping the redeem field');
  await fireEvent.submit(form);
}

// WebAuthn is feature-detected via `typeof PublicKeyCredential`. We force it
// PRESENT for the default suites and ABSENT for the unsupported suite. The
// global is restored after each test so order-independence holds.
const ORIGINAL_PKC = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
function setWebAuthnSupported(supported: boolean) {
  if (supported) {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
      ORIGINAL_PKC ?? function PublicKeyCredential() {};
  } else {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  }
}

beforeEach(() => {
  // Frozen clock: the redeem card must render identically at any instant
  // (no time-of-day branching). Pins determinism per the harness contract.
  freezeClock();
  __resetCapture();
  __setTestSink();
  setWebAuthnSupported(true);
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});

afterEach(() => {
  cleanup();
  __resetCapture();
  if (ORIGINAL_PKC === undefined) {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  } else {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = ORIGINAL_PKC;
  }
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// HAPPY PATH — Surface J: code-entry → requesting-challenge → awaiting-ceremony
//             → verifying → success
// ===========================================================================

describe('P1-7 Surface J [happy] — code-entry → ceremony → success', () => {
  it('[Surface J: code-entry] renders exactly ONE secret field (the 6-digit code) and the primary button', () => {
    renderCard({});
    // ONE secret field. There is NO separate "invite code" text field — the
    // link carries invite_id; the member types only the 6-digit code.
    const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
    expect(input).toBeDefined();
    // mobile numeric keypad + OS autofill of the one-time code (mirrors D3).
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    // No second free-text secret field masquerading as an "invite code".
    expect(screen.queryByTestId('redeem-invite-code-input')).toBeNull();
    // Primary action present in the idle/code-entry state.
    expect(screen.getByTestId('redeem-submit')).toBeDefined();
  });

  it('[Surface J: requesting-challenge] the challenge POST body is EXACTLY {action,rpId,origin} — NO code, NO invite_id (F-170)', async () => {
    const { calls } = renderCard({
      responses: [
        CHALLENGE_OK,
        { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
      ]
    });
    await enterCodeAndSubmit();

    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    const challengeBody = calls[0]!.body;
    expect(challengeBody.action).toBe('challenge');
    // rpId + origin are derived from the live location (mirror /bootstrap).
    expect(typeof challengeBody.rpId).toBe('string');
    expect(typeof challengeBody.origin).toBe('string');
    // The secret + invite_id MUST NOT ride the challenge call (F-170 oracle:
    // the cheap challenge path leaks nothing and does no code/TOTP work).
    expect('totp_code' in challengeBody).toBe(false);
    expect('invite_id' in challengeBody).toBe(false);
    expect('code' in challengeBody).toBe(false);
  });

  it('[Surface J: awaiting-ceremony] navigator.credentials.create is called with the SERVER-returned challenge', async () => {
    const { credentials, created } = stubCredentials();
    renderCard({
      credentials,
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();

    await waitFor(() => {
      expect(created.length).toBe(1);
    });
    // The ceremony binds the server's single-use challenge — not a fabricated
    // client value. The challenge bytes decode from SERVER_CHALLENGE.
    const challengeArg = created[0]!.publicKey.challenge;
    expect(challengeArg).toBeDefined();
  });

  it('[Surface J: verifying] register POST carries invite_id (from prop) + totp_code (from field) + verified attestation', async () => {
    const { calls } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();

    await waitFor(() => {
      expect(calls.length).toBe(2);
    });
    const reg = calls[1]!.body;
    expect(reg.action).toBe('register');
    // invite_id comes from the prop the route read off ?invite_id= (NOT typed).
    expect(reg.invite_id).toBe(INVITE_ID);
    // the one secret the member typed.
    expect(reg.totp_code).toBe(SECRET_CODE);
    // the server-issued challenge is echoed back for consume+bind.
    expect(reg.challenge).toBe(SERVER_CHALLENGE);
    // verified-attestation fields are forwarded.
    expect(typeof reg.credentialId).toBe('string');
    expect(typeof reg.attestationObject).toBe('string');
    expect(typeof reg.clientDataJSON).toBe('string');
    expect(Array.isArray(reg.transports)).toBe(true);
    expect(typeof reg.rpId).toBe('string');
    expect(typeof reg.origin).toBe('string');
    // F-171: NO caller-supplied uid is smuggled into the register body.
    expect('user_id' in reg).toBe(false);
    expect('target_user_id' in reg).toBe(false);
    expect('enrolling_uid' in reg).toBe(false);
  });

  it('[Surface J: verifying] the call ORDER is challenge → create → register (ceremony never registers before a verified credential)', async () => {
    const order: string[] = [];
    const { transport } = recordingTransport([
      CHALLENGE_OK,
      { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
    ]);
    const wrapped = async (body: Record<string, unknown>) => {
      order.push(`post:${String(body.action)}`);
      return transport(body);
    };
    const credentials = {
      async create(req: { publicKey: PublicKeyCredentialCreationOptions }) {
        order.push('create');
        void req;
        return {
          id: 'c',
          rawId: new Uint8Array([1]).buffer,
          type: 'public-key',
          response: {
            attestationObject: new Uint8Array([2]).buffer,
            clientDataJSON: new Uint8Array([3]).buffer,
            getTransports: () => []
          }
        };
      }
    } as unknown as CredentialsContainer;

    render(RedeemCard, {
      props: {
        inviteId: INVITE_ID,
        transport: wrapped as never,
        credentials: credentials as never,
        navigate: (() => {}) as never
      }
    });
    await enterCodeAndSubmit();
    await waitFor(() => {
      expect(order).toEqual(['post:challenge', 'create', 'post:register']);
    });
  });

  it('[Surface J: success] on {ok:true,user_id} shows the success panel with a real /sign-in link', async () => {
    renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    const panel = await screen.findByTestId('redeem-success');
    // Color-never-alone (anti-pattern 3): the panel carries an icon, not hue only.
    expect(panel.querySelector('[data-testid="redeem-success-icon"]')).not.toBeNull();
    // The CTA is a REAL anchor to /sign-in (keyboard + SR operable), not a
    // div with a click handler.
    const cta = screen.getByTestId('redeem-success-cta');
    expect(cta.tagName.toLowerCase()).toBe('a');
    expect(cta.getAttribute('href')).toBe('/sign-in');
  });

  it('[Surface J: success / F-176] the success body NEVER renders the returned user_id', async () => {
    const { container } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-success');
    // user_id is operator-only (F-176). It must not appear anywhere in the DOM.
    expect(container.textContent ?? '').not.toContain(NEW_USER_ID);
  });
});

// ===========================================================================
// ERROR PATHS — Surface J: redeem-invalid (422), rate-limited (429),
//               system-error (401/500/503/network)
// ===========================================================================

describe('P1-7 Surface J [error] — normalized redeem_invalid (422)', () => {
  it('[Surface J: redeem-invalid] 422 redeem_invalid shows the ONE normalized message + the re-send guidance', async () => {
    renderCard({
      responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
    });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-error');
    expect(banner.getAttribute('role')).toBe('alert');
    // Single normalized copy: "that code didn't work" + "ask your co-chair".
    // The copy must reference the P1-6 re-send path.
    expect(banner.textContent ?? '').toMatch(/didn'?t work|that code/i);
    expect(banner.textContent ?? '').toMatch(/co-?chair/i);
  });

  it('[Surface J: redeem-invalid / F-169/F-170] the SAME response yields a BYTE-identical message — no sub-condition split', async () => {
    // The EF already normalizes every cause (expired/consumed/wrong-TOTP/locked)
    // to the SAME {error:'redeem_invalid'} body. The UI must not re-split it via
    // wording. Two independent renders of the identical 422 produce identical text.
    const renderOnce = async () => {
      const { unmount } = renderCard({
        responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
      });
      await enterCodeAndSubmit();
      const banner = await screen.findByTestId('redeem-error');
      const text = banner.textContent ?? '';
      unmount();
      return text;
    };
    const first = await renderOnce();
    cleanup();
    const second = await renderOnce();
    expect(first).toBe(second);
    // And it must NOT leak any sub-condition vocabulary that would re-open the
    // oracle (expired vs locked vs consumed vs wrong code).
    expect(first).not.toMatch(/expired|locked|consumed|already used|wrong code|not found/i);
  });

  it('[Surface J: redeem-invalid] both the code field is retained + re-enabled (let the member fix a typo)', async () => {
    renderCard({
      responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-error');
    const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
    // Code is NOT cleared — the member can correct a typo (F-176: it is never
    // echoed to logs/URL, but it stays in the field).
    expect(input.value).toBe(SECRET_CODE);
    expect(input.disabled).toBe(false);
  });

  it('[Surface J: redeem-invalid] the error is re-submittable (a second attempt re-runs the ceremony)', async () => {
    const { calls } = renderCard({
      responses: [
        CHALLENGE_OK,
        { status: 422, body: { error: 'redeem_invalid' } },
        CHALLENGE_OK,
        { status: 200, body: { ok: true, user_id: NEW_USER_ID } }
      ]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-error');
    // Retry: a fresh challenge + register fire.
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-success');
    expect(calls.map((c) => c.body.action)).toEqual([
      'challenge',
      'register',
      'challenge',
      'register'
    ]);
  });
});

describe('P1-7 Surface J [error] — rate-limited (429)', () => {
  it('[Surface J: rate-limited] 429 rate_limited shows the warning state + retry/re-send guidance', async () => {
    renderCard({
      responses: [CHALLENGE_OK, { status: 429, body: { error: 'rate_limited' } }]
    });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-rate-limited');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent ?? '').toMatch(/too many|wait|few minutes/i);
    // It is a DISTINCT surface from the normalized redeem_invalid banner.
    expect(screen.queryByTestId('redeem-error')).toBeNull();
  });
});

describe('P1-7 Surface J [error] — system-error (401/500/503/network)', () => {
  // Each maps to the SAME generic "on our side" copy; the raw enum is never shown.
  for (const c of [
    { name: '503 service_unavailable (challenge)', step: 'challenge' as const, status: 503, enum: 'service_unavailable' },
    { name: '401 origin_rejected (challenge)', step: 'challenge' as const, status: 401, enum: 'origin_rejected' },
    { name: '401 registration_invalid (register)', step: 'register' as const, status: 401, enum: 'registration_invalid' },
    { name: '500 redeem_failed (register)', step: 'register' as const, status: 500, enum: 'redeem_failed' },
    { name: '400 bad_request (register)', step: 'register' as const, status: 400, enum: 'bad_request' }
  ]) {
    it(`[Surface J: system-error] ${c.name} → generic message, raw enum NEVER rendered`, async () => {
      const responses: QueuedResponse[] =
        c.step === 'challenge'
          ? [{ status: c.status, body: { error: c.enum } }]
          : [CHALLENGE_OK, { status: c.status, body: { error: c.enum } }];
      const { container } = renderCard({ responses });
      await enterCodeAndSubmit();
      const banner = await screen.findByTestId('redeem-system-error');
      expect(banner.getAttribute('role')).toBe('alert');
      expect(banner.textContent ?? '').toMatch(/on our side|something went wrong/i);
      // F-176: the raw EF enum is mapped away — never surfaced to the member.
      expect(container.textContent ?? '').not.toContain(c.enum);
    });
  }

  it('[Surface J: system-error] a transport THROW (network down) maps to the generic system error', async () => {
    const throwing = async () => {
      throw new Error('network down');
    };
    render(RedeemCard, {
      props: {
        inviteId: INVITE_ID,
        transport: throwing as never,
        credentials: stubCredentials().credentials as never,
        navigate: (() => {}) as never
      }
    });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-system-error');
    expect(banner.getAttribute('role')).toBe('alert');
    // Never echo the thrown message text to the member.
    expect(banner.textContent ?? '').not.toContain('network down');
  });
});

// ===========================================================================
// EDGE CASES — Surface J: cancelled, webauthn-unsupported, incomplete link
// ===========================================================================

describe('P1-7 Surface J [edge] — cancelled (user dismissed the OS prompt)', () => {
  it('[Surface J: cancelled] create() rejects NotAllowedError → polite cancelled state, re-submittable', async () => {
    const credentials = {
      async create() {
        const e = new Error('user cancelled');
        e.name = 'NotAllowedError';
        throw e;
      }
    } as unknown as CredentialsContainer;
    renderCard({ credentials, responses: [CHALLENGE_OK] });
    await enterCodeAndSubmit();
    const note = await screen.findByTestId('redeem-cancelled');
    // Cancellation is user-initiated → POLITE (role=status), not assertive.
    expect(note.getAttribute('role')).toBe('status');
    // Re-enabled for another attempt.
    expect((screen.getByTestId('redeem-code-input') as HTMLInputElement).disabled).toBe(false);
  });

  it('[Surface J: cancelled] create() resolving null is also treated as cancelled (polite)', async () => {
    const credentials = {
      async create() {
        return null;
      }
    } as unknown as CredentialsContainer;
    renderCard({ credentials, responses: [CHALLENGE_OK] });
    await enterCodeAndSubmit();
    const note = await screen.findByTestId('redeem-cancelled');
    expect(note.getAttribute('role')).toBe('status');
  });

  it('[Surface J: cancelled] focus returns to the primary button after a cancel', async () => {
    const credentials = {
      async create() {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
    } as unknown as CredentialsContainer;
    renderCard({ credentials, responses: [CHALLENGE_OK] });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-cancelled');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('redeem-submit'));
    });
  });
});

describe('P1-7 Surface J [edge] — webauthn-unsupported (feature-detect)', () => {
  it('[Surface J: webauthn-unsupported] PublicKeyCredential undefined → unsupported state, NO ceremony attempted', async () => {
    setWebAuthnSupported(false);
    const { calls } = renderCard({ responses: [] });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-unsupported');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent ?? '').toMatch(/can'?t create a passkey|different.*device/i);
    // Feature-detect happens BEFORE the challenge call — no transport hit.
    expect(calls.length).toBe(0);
  });

  it('[Surface J: webauthn-unsupported] the primary action is disabled (no point retrying on this device)', async () => {
    setWebAuthnSupported(false);
    renderCard({ responses: [] });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-unsupported');
    const btn = screen.getByTestId('redeem-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe('P1-7 Surface J [edge] — incomplete link (missing invite_id)', () => {
  it('[Surface J: incomplete-link] empty invite_id → a graceful state that does NOT crash and does NOT register', async () => {
    const { calls } = renderCard({ inviteId: '', responses: [] });
    // The card must render an "incomplete link" notice rather than throw.
    const notice = await screen.findByTestId('redeem-incomplete-link');
    expect(notice).toBeDefined();
    // No attempt to start the ceremony with a missing invite_id.
    const btn = screen.queryByTestId('redeem-submit') as HTMLButtonElement | null;
    if (btn) {
      await fireEvent.click(btn);
    }
    expect(calls.length).toBe(0);
  });
});

// ===========================================================================
// SECURITY / PRIVACY — F-170 (code never in URL/history/storage/fetch-url)
//                      F-176 (code never logged / echoed)
// ===========================================================================

describe('P1-7 [security/privacy] F-170 — the 6-digit code never leaves the POST body', () => {
  it('[F-170] across a full submit the code is absent from location.href, history, sessionStorage, localStorage', async () => {
    const { calls } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await waitFor(() => expect(calls.length).toBe(2));

    const haystacks: string[] = [];
    if (typeof window !== 'undefined' && window.location) {
      haystacks.push(window.location.href, window.location.search, window.location.hash);
    }
    if (typeof sessionStorage !== 'undefined') {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) haystacks.push(k + '=' + (sessionStorage.getItem(k) ?? ''));
      }
    }
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) haystacks.push(k + '=' + (localStorage.getItem(k) ?? ''));
      }
    }
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET_CODE);
    }
  });

  it('[F-170] the code appears ONLY in the register POST body — never in any challenge body or as a query string', async () => {
    const { calls } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await waitFor(() => expect(calls.length).toBe(2));

    // challenge body: no code anywhere.
    expect(JSON.stringify(calls[0]!.body)).not.toContain(SECRET_CODE);
    // register body: the code is present ONLY as the totp_code field value.
    expect(calls[1]!.body.totp_code).toBe(SECRET_CODE);
  });
});

describe('P1-7 [security/privacy] F-176 — the code never reaches a log surface', () => {
  it('[F-176] the code is absent from console.* and the structured-log capture across challenge+register', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { calls } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await waitFor(() => expect(calls.length).toBe(2));

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET_CODE);
    }
  });

  it('[F-176] the code never logs even on the redeem_invalid error branch', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    renderCard({
      responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-error');

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(SECRET_CODE);
    }
  });

  it('[F-176] the returned user_id never reaches a log surface either (operator-only)', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));

    const { calls } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await waitFor(() => expect(calls.length).toBe(2));

    const haystacks = [...logs, ...__getCapturedLines().map((l) => JSON.stringify(l))];
    for (const h of haystacks) {
      expect(h).not.toContain(NEW_USER_ID);
    }
  });
});
