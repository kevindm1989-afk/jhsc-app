<!--
  Cold-instance first-co-chair bootstrap (ADR-0025 A3).

  Only useful on a freshly-deployed project where BOOTSTRAP_ENABLED=true is
  set on the Supabase Edge Function secret AND no public.users row exists.
  The SQL one-shot guard ensures this can succeed at most once for the
  project's lifetime; this UI is intentionally minimal — it is a CLI-shaped
  worker tool the operator visits once, then deletes the Edge Function.

  Flow:
    1. POST { action: 'challenge', rpId, origin } → server-issued single-use
       challenge bound to (rpId, origin).
    2. navigator.credentials.create({ challenge, rp, user, pubKeyCredParams,
         authenticatorSelection: { userVerification: 'required',
         residentKey: 'required' }, attestation: 'none' })
    3. POST { action: 'register', credentialId, attestationObject,
         clientDataJSON, transports, rpId, origin, challenge, deviceLabel }
       → server-side verifyRegistrationResponse + the SQL one-shot RPC.

  Security posture is server-side: this page is just the ceremony driver. All
  the trust decisions live in the Edge Function + SQL.
-->
<script>
  import { env } from '$env/dynamic/public';

  const SUPABASE_URL = env.PUBLIC_SUPABASE_URL ?? '';
  const SUPABASE_ANON_KEY = env.PUBLIC_SUPABASE_ANON_KEY ?? '';

  /** @type {'idle'|'requesting_challenge'|'awaiting_ceremony'|'verifying'|'ok'|'error'} */
  let state = 'idle';
  /** @type {string|null} */
  let errorCode = null;
  /** @type {string|null} */
  let userId = null;

  /** @param {ArrayBuffer|Uint8Array} buf */
  function toBase64Url(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  /** @param {string} b64url */
  function fromBase64Url(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** @param {string} action @param {Record<string, unknown>} body */
  async function callBootstrap(action, body) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bootstrap-first-co-chair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action, ...body })
    });
    return res.json();
  }

  async function runBootstrap() {
    try {
      state = 'requesting_challenge';
      errorCode = null;
      const origin = window.location.origin;
      // The RP-ID is the eTLD+1 host of the page (WebAuthn restriction).
      const rpId = window.location.hostname;

      const challengeResp = await callBootstrap('challenge', { rpId, origin });
      if (!challengeResp?.ok) {
        state = 'error';
        errorCode = challengeResp?.error ?? 'request_failed';
        return;
      }
      const challenge = String(challengeResp.challenge);

      state = 'awaiting_ceremony';
      // 16 bytes random user.id — required by WebAuthn; not the DB user_id
      // (the server-side guard assigns that). The browser never sees the DB id.
      const userHandle = new Uint8Array(16);
      crypto.getRandomValues(userHandle);

      const cred = /** @type {PublicKeyCredential|null} */ (
        await navigator.credentials.create({
          publicKey: {
            challenge: fromBase64Url(challenge),
            rp: { name: 'JHSC', id: rpId },
            user: {
              id: userHandle,
              name: 'first-co-chair',
              displayName: 'First Co-Chair'
            },
            // ES256 (-7) preferred; RS256 (-257) accepted. Server enforces the
            // same set via supportedAlgorithmIDs (C7).
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 }
            ],
            authenticatorSelection: {
              userVerification: 'required',
              residentKey: 'required'
            },
            attestation: 'none',
            timeout: 60_000
          }
        })
      );
      if (!cred) {
        state = 'error';
        errorCode = 'cancelled';
        return;
      }

      const att = /** @type {AuthenticatorAttestationResponse} */ (cred.response);
      state = 'verifying';
      const registerResp = await callBootstrap('register', {
        credentialId: cred.id,
        attestationObject: toBase64Url(att.attestationObject),
        clientDataJSON: toBase64Url(att.clientDataJSON),
        transports: typeof att.getTransports === 'function' ? att.getTransports() : [],
        rpId,
        origin,
        challenge,
        deviceLabel: 'first-co-chair-bootstrap'
      });
      if (!registerResp?.ok) {
        state = 'error';
        errorCode = registerResp?.error ?? 'request_failed';
        return;
      }
      userId = String(registerResp.user_id);
      state = 'ok';
    } catch (e) {
      state = 'error';
      errorCode = (e && /** @type {Error} */ (e).name) || 'ceremony_failed';
    }
  }
</script>

<svelte:head>
  <title>JHSC — First co-chair bootstrap</title>
</svelte:head>

<main class="bootstrap">
  <h1>First co-chair bootstrap</h1>
  <p class="warn">
    <strong>Operator-only.</strong> This page is the ONE-SHOT cold-instance enrollment for the very
    first committee co-chair. It only works while
    <code>BOOTSTRAP_ENABLED=true</code> is set on the Supabase Edge Function and no committee user
    exists yet. After your passkey is bound, delete the
    <code>bootstrap-first-co-chair</code> Edge Function and unset the env secret (ADR-0025 A4).
  </p>

  {#if state === 'idle' || state === 'error'}
    <button type="button" on:click={runBootstrap} data-testid="bootstrap-start">
      Enroll first co-chair passkey
    </button>
  {/if}

  {#if state === 'requesting_challenge'}
    <p>Requesting registration challenge…</p>
  {/if}
  {#if state === 'awaiting_ceremony'}
    <p>Follow your device prompt to create the passkey…</p>
  {/if}
  {#if state === 'verifying'}
    <p>Verifying attestation server-side…</p>
  {/if}

  {#if state === 'ok'}
    <div class="ok" role="status" data-testid="bootstrap-ok">
      <h2>Done.</h2>
      <p>
        Your committee co-chair user has been created with id
        <code>{userId}</code>. Save this id; you'll need it for follow-up flows. Now disable
        bootstrap: unset the
        <code>BOOTSTRAP_ENABLED</code> secret on the Supabase project and delete the
        <code>bootstrap-first-co-chair</code> Edge Function.
      </p>
    </div>
  {/if}

  {#if state === 'error' && errorCode}
    <div class="error" role="alert" data-testid="bootstrap-error">
      <p>Bootstrap failed: <code>{errorCode}</code>.</p>
      <p class="hint">
        Common causes: <code>bootstrap_disabled</code> (operator must set
        <code>BOOTSTRAP_ENABLED=true</code>), <code>already_initialised</code> (a user already
        exists — bootstrap can only succeed once), or
        <code>origin_rejected</code> (set this page's origin in
        <code>MINT_EXPECTED_ORIGINS</code>).
      </p>
    </div>
  {/if}
</main>

<style>
  .bootstrap {
    max-inline-size: 38rem;
    margin: 3rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
    line-height: 1.45;
  }
  .warn {
    border: 1px solid #b45309;
    background: #fef3c7;
    color: #78350f;
    padding: 0.75rem 1rem;
    border-radius: 4px;
  }
  .ok {
    border: 1px solid #15803d;
    background: #dcfce7;
    color: #14532d;
    padding: 0.75rem 1rem;
    border-radius: 4px;
    margin-top: 1.5rem;
  }
  .error {
    border: 1px solid #b91c1c;
    background: #fee2e2;
    color: #7f1d1d;
    padding: 0.75rem 1rem;
    border-radius: 4px;
    margin-top: 1.5rem;
  }
  button {
    padding: 0.6rem 1.2rem;
    font: inherit;
    cursor: pointer;
    border: 1px solid currentcolor;
    border-radius: 4px;
    background: white;
  }
  .hint {
    font-size: 0.875rem;
    margin-top: 0.5rem;
  }
  code {
    background: rgb(0 0 0 / 5%);
    padding: 0.05rem 0.25rem;
    border-radius: 3px;
  }
</style>
