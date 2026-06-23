/**
 * ADR-0029 P1-7 — /redeem card ACCESSIBILITY contract (Surface J a11y packet).
 *
 * RED-FIRST (TDD). The implementer treats this file as READ-ONLY. These tests
 * become the accessibility-specialist's checklist: every mandatory a11y
 * behavior the designer specified in Surface J is pinned as an assertion.
 *
 * Surface J a11y packet (design-system.md §4 Surface J):
 *   - the single code input has an associated <label for> + helper via
 *     aria-describedby; on error the error-banner id is appended to
 *     aria-describedby.
 *   - the ceremony container toggles aria-busy true during
 *     requesting/awaiting/verifying.
 *   - role="status" (polite) for requesting/verifying/success/cancelled;
 *     role="alert" (assertive) for redeem_invalid/rate_limited/unsupported/
 *     system_error.
 *   - focus moves: to the error heading (tabindex=-1) on error; to the success
 *     heading on success; to the primary button on cancelled; to the code input
 *     on mount.
 *   - the "follow your device prompt" waiting note is in the DOM (aria-live
 *     polite) BEFORE navigator.credentials.create is invoked.
 *   - color-never-alone: each state panel carries an icon + text.
 *
 * Mirrors the a11y assertion style of sessions-list.test.ts +
 * concern-intake-source-name-alert.test.ts (role/aria-busy/aria-describedby/
 * focus assertions against the rendered DOM) and uses the project axe helper
 * for the structural WCAG 2 AA sweep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { freezeClock, restoreClock } from '../_helpers/clock';
import axeCheck from '../_helpers/axe-check';
import { __resetCapture, __setTestSink } from '../../src/lib/log/test-sink';

// RED-FIRST import — created by the implementer.
import RedeemCard from '../../src/lib/redeem/RedeemCard.svelte';

const INVITE_ID = '7b1d3f00-0000-4000-8000-0000000000aa';
const SERVER_CHALLENGE = 'srv-redeem-challenge-xyz';
const NEW_USER_ID = '9c2e8a11-1111-4111-8111-111111111111';
const SECRET_CODE = '482913';

interface QueuedResponse {
  status: number;
  body: unknown;
}

function recordingTransport(responses: QueuedResponse[]) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const transport = async (body: Record<string, unknown>) => {
    calls.push({ body });
    const r = responses[i++];
    if (!r) throw new Error(`no redeem response queued for call #${i}`);
    return { status: r.status, body: r.body };
  };
  return { transport, calls };
}

const CHALLENGE_OK: QueuedResponse = { status: 200, body: { ok: true, challenge: SERVER_CHALLENGE } };

/**
 * A create() stub that lets the test observe whether the "follow your device
 * prompt" waiting note was in the DOM BEFORE create() ran. The `beforeCreate`
 * callback is invoked synchronously at the top of create().
 */
function stubCredentials(beforeCreate?: () => void) {
  const credentials = {
    async create() {
      if (beforeCreate) beforeCreate();
      return {
        id: 'cred-redeem-1',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        response: {
          attestationObject: new Uint8Array([0xa1]).buffer,
          clientDataJSON: new Uint8Array([0xb1]).buffer,
          getTransports: () => ['internal']
        }
      };
    }
  } as unknown as CredentialsContainer;
  return credentials;
}

function renderCard(opts: {
  responses?: QueuedResponse[];
  credentials?: CredentialsContainer;
  inviteId?: string;
}) {
  const { transport, calls } = recordingTransport(opts.responses ?? [CHALLENGE_OK]);
  const utils = render(RedeemCard, {
    props: {
      inviteId: opts.inviteId ?? INVITE_ID,
      transport: transport as never,
      credentials: (opts.credentials ?? stubCredentials()) as never,
      navigate: (() => {}) as never
    }
  });
  return { ...utils, calls };
}

async function enterCodeAndSubmit(code: string = SECRET_CODE) {
  const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
  await fireEvent.input(input, { target: { value: code } });
  const form = document.querySelector('form');
  if (!form) throw new Error('expected a <form> wrapping the redeem field');
  await fireEvent.submit(form);
}

const ORIGINAL_PKC = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;

beforeEach(() => {
  freezeClock();
  __resetCapture();
  __setTestSink();
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
    ORIGINAL_PKC ?? function PublicKeyCredential() {};
});

afterEach(() => {
  cleanup();
  __resetCapture();
  if (ORIGINAL_PKC === undefined) {
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  } else {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = ORIGINAL_PKC;
  }
  vi.restoreAllMocks();
  restoreClock();
});

// ===========================================================================
// LABEL + DESCRIBEDBY association
// ===========================================================================

describe('P1-7 [a11y] code input — label + helper association', () => {
  it('the single code input has an associated <label for> AND an aria-describedby helper', () => {
    renderCard({});
    const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
    // A real <label for=id> association (so clicking the label focuses it and
    // SR announces the label).
    const id = input.getAttribute('id');
    expect(id).toBeTruthy();
    const label = document.querySelector(`label[for="${id}"]`);
    expect(label, 'expected a <label for> bound to the code input').not.toBeNull();
    // Helper text wired via aria-describedby.
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.trim().length).toBeGreaterThan(0);
    for (const tokenId of describedBy.split(/\s+/)) {
      expect(document.getElementById(tokenId), `aria-describedby points at #${tokenId}`).not.toBeNull();
    }
  });

  it('on the redeem_invalid error the error-banner id is APPENDED to the input aria-describedby (not replacing the helper)', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }] });
    const input = screen.getByTestId('redeem-code-input') as HTMLInputElement;
    const helperBefore = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);

    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-error');
    const bannerId = banner.getAttribute('id');
    expect(bannerId, 'the error banner must carry an id to be referenced').toBeTruthy();

    const describedAfter = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    // The helper id(s) are still present...
    for (const h of helperBefore) expect(describedAfter).toContain(h);
    // ...and the error id is appended.
    expect(describedAfter).toContain(bannerId);
  });
});

// ===========================================================================
// aria-busy on the ceremony container during in-flight states
// ===========================================================================

describe('P1-7 [a11y] ceremony container — aria-busy toggling', () => {
  it('aria-busy is "false" at rest (code-entry)', () => {
    renderCard({});
    const container = screen.getByTestId('redeem-ceremony');
    expect(container.getAttribute('aria-busy')).toBe('false');
  });

  it('aria-busy flips to "true" while the ceremony is in flight (requesting/awaiting/verifying)', async () => {
    // Hold the challenge response open so we can observe the in-flight state.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transport = async (body: Record<string, unknown>) => {
      void body;
      await gate;
      return { status: 200, body: { ok: true, challenge: SERVER_CHALLENGE } };
    };
    render(RedeemCard, {
      props: {
        inviteId: INVITE_ID,
        transport: transport as never,
        credentials: stubCredentials() as never,
        navigate: (() => {}) as never
      }
    });
    await enterCodeAndSubmit();
    await waitFor(() => {
      expect(screen.getByTestId('redeem-ceremony').getAttribute('aria-busy')).toBe('true');
    });
    release();
  });

  it('aria-busy returns to "false" once an error terminal state is reached', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }] });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-error');
    expect(screen.getByTestId('redeem-ceremony').getAttribute('aria-busy')).toBe('false');
  });
});

// ===========================================================================
// role split — polite (status) vs assertive (alert)
// ===========================================================================

describe('P1-7 [a11y] live-region role split — polite vs assertive', () => {
  it('the in-flight waiting note is POLITE (role="status" / aria-live polite)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const credentials = {
      async create() {
        await gate;
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
    renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }],
      credentials
    });
    await enterCodeAndSubmit();
    const note = await screen.findByTestId('redeem-waiting');
    // Polite: the user is mid-ceremony; do not interrupt.
    expect(note.getAttribute('role')).toBe('status');
    release();
  });

  it('success is POLITE (role="status")', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }] });
    await enterCodeAndSubmit();
    const panel = await screen.findByTestId('redeem-success');
    expect(panel.getAttribute('role')).toBe('status');
  });

  it('cancelled is POLITE (role="status") — user-initiated, not an interruption', async () => {
    const credentials = {
      async create() {
        const e = new Error('cancel');
        e.name = 'NotAllowedError';
        throw e;
      }
    } as unknown as CredentialsContainer;
    renderCard({ responses: [CHALLENGE_OK], credentials });
    await enterCodeAndSubmit();
    const note = await screen.findByTestId('redeem-cancelled');
    expect(note.getAttribute('role')).toBe('status');
  });

  it('redeem_invalid / rate_limited / system_error / unsupported are ASSERTIVE (role="alert")', async () => {
    // redeem_invalid
    {
      const { unmount } = renderCard({
        responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
      });
      await enterCodeAndSubmit();
      expect((await screen.findByTestId('redeem-error')).getAttribute('role')).toBe('alert');
      unmount();
      cleanup();
    }
    // rate_limited
    {
      const { unmount } = renderCard({
        responses: [CHALLENGE_OK, { status: 429, body: { error: 'rate_limited' } }]
      });
      await enterCodeAndSubmit();
      expect((await screen.findByTestId('redeem-rate-limited')).getAttribute('role')).toBe('alert');
      unmount();
      cleanup();
    }
    // system_error
    {
      const { unmount } = renderCard({
        responses: [CHALLENGE_OK, { status: 500, body: { error: 'redeem_failed' } }]
      });
      await enterCodeAndSubmit();
      expect((await screen.findByTestId('redeem-system-error')).getAttribute('role')).toBe('alert');
      unmount();
      cleanup();
    }
    // unsupported
    {
      delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
      const { unmount } = renderCard({ responses: [] });
      await enterCodeAndSubmit();
      expect((await screen.findByTestId('redeem-unsupported')).getAttribute('role')).toBe('alert');
      unmount();
    }
  });
});

// ===========================================================================
// focus management
// ===========================================================================

describe('P1-7 [a11y] focus management', () => {
  it('focus is on the code input on mount', async () => {
    renderCard({});
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('redeem-code-input'));
    });
  });

  it('focus moves to the error heading (tabindex=-1) on an error state', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }] });
    await enterCodeAndSubmit();
    const heading = await screen.findByTestId('redeem-error-heading');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  it('focus moves to the success heading on success', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }] });
    await enterCodeAndSubmit();
    const heading = await screen.findByTestId('redeem-success-heading');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });
});

// ===========================================================================
// "follow your device prompt" note ordering (rendered BEFORE create())
// ===========================================================================

describe('P1-7 [a11y] WebAuthn-prompt timing — explainer precedes the OS dialog', () => {
  it('the "follow your device prompt" waiting note is in the DOM BEFORE navigator.credentials.create runs', async () => {
    let noteWasPresentAtCreate: boolean | null = null;
    const credentials = stubCredentials(() => {
      // create() is about to open the OS dialog. The waiting note MUST already
      // be in the DOM so SR users hear what is about to happen (§3.1).
      noteWasPresentAtCreate = document.querySelector('[data-testid="redeem-waiting"]') !== null;
    });
    renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }],
      credentials
    });
    await enterCodeAndSubmit();
    await waitFor(() => {
      expect(noteWasPresentAtCreate).not.toBeNull();
    });
    expect(noteWasPresentAtCreate).toBe(true);
  });
});

// ===========================================================================
// color-never-alone — each state panel carries an icon + text
// ===========================================================================

describe('P1-7 [a11y] color-never-alone — icon accompanies every state panel', () => {
  it('the redeem_invalid panel has an icon (not color alone)', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }] });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-error');
    expect(banner.querySelector('[data-testid="redeem-error-icon"]')).not.toBeNull();
    expect((banner.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('the rate_limited panel has an icon', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 429, body: { error: 'rate_limited' } }] });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-rate-limited');
    expect(banner.querySelector('[data-testid="redeem-rate-limited-icon"]')).not.toBeNull();
  });

  it('the system_error panel has an icon', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 500, body: { error: 'redeem_failed' } }] });
    await enterCodeAndSubmit();
    const banner = await screen.findByTestId('redeem-system-error');
    expect(banner.querySelector('[data-testid="redeem-system-error-icon"]')).not.toBeNull();
  });

  it('the success panel has an icon', async () => {
    renderCard({ responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }] });
    await enterCodeAndSubmit();
    const panel = await screen.findByTestId('redeem-success');
    expect(panel.querySelector('[data-testid="redeem-success-icon"]')).not.toBeNull();
  });
});

// ===========================================================================
// structural WCAG 2 AA sweep (axe) — code-entry + error + success snapshots
// ===========================================================================

describe('P1-7 [a11y] axe WCAG 2 AA structural sweep', () => {
  it('the code-entry state has no axe violations', async () => {
    const { container } = renderCard({});
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the redeem_invalid error state has no axe violations', async () => {
    const { container } = renderCard({
      responses: [CHALLENGE_OK, { status: 422, body: { error: 'redeem_invalid' } }]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-error');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });

  it('the success state has no axe violations', async () => {
    const { container } = renderCard({
      responses: [CHALLENGE_OK, { status: 200, body: { ok: true, user_id: NEW_USER_ID } }]
    });
    await enterCodeAndSubmit();
    await screen.findByTestId('redeem-success');
    const r = await axeCheck(container, { wcagLevel: 'wcag2aa' });
    expect(r.violations).toEqual([]);
  });
});
