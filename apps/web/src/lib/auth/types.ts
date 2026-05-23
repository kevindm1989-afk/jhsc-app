/**
 * Shared types for the JHSC auth surface (T05).
 *
 * Source obligations:
 *   - `.context/decisions.md` ADR-0002 — passkeys-only, TOTP enrollment bootstrap.
 *   - `.context/threat-model.md` §3.1 F-37..F-43.
 *   - `observability/audit-log.md` §1 Auth + session.
 *
 * These types are stable contract surface. Renaming requires a coordinated
 * change to the test suite (`apps/web/test/T05/auth-passkey.test.ts`) and the
 * test harness (`apps/web/test/_helpers/supabase-test.ts`).
 */

export interface PasskeyCredential {
  /** Opaque WebAuthn credential ID (base64url-shaped synthetic in tests). */
  credentialId: string;
  /** User the credential is bound to. */
  user_id: string;
  /**
   * RP-ID derived from the eTLD+1 of the registration origin. WebAuthn
   * assertions whose origin maps to a different RP-ID are rejected per F-37.
   */
  rpId: string;
  /** Public key fingerprint placeholder; not cryptographically validated in tests. */
  publicKey: string;
  counter: number;
  /** AAGUID — passed through from the authenticator. */
  aaguid: string;
  /** Transports — `usb`, `nfc`, `internal`, etc. */
  transports: string[];
  /** User-provided device label. NEVER raw UA. */
  device_label: string;
  created_at: number;
  last_used_at: number;
}

export interface AuthSession {
  /** Server-issued opaque session id; equal to the JWT `jti`. */
  session_id: string;
  user_id: string;
  /** Short-lived access token (≤15 min TTL per ADR-0002). */
  access_token: string;
  /** Issued-at (ms epoch). */
  iat: number;
  /** Expiry (ms epoch). */
  exp: number;
  /** Optional device fingerprint (hashed, no raw UA). */
  device_fingerprint?: string;
  revoked_at: number | null;
}

export interface AuthResponse<T = unknown> {
  status: number;
  /** Response body — used by enumeration-prevention tests. */
  body: T;
  /** Response headers — used by enumeration-prevention tests. */
  headers: Record<string, string>;
}

export interface EnrollResult {
  status: number;
  passkey_credential_id?: string;
  totp_consumed?: boolean;
  /** Error reason key (i18n key) if !ok. */
  reason_key?: string;
}

export interface LoginResult {
  session_id: string;
  access_token: string;
  user_id: string;
  exp: number;
}

export interface BrowserBaselineCheck {
  ok: boolean;
  /** i18n key for the user-facing reason; undefined when ok. */
  reason_key?: string;
}

export interface PasskeyAssertResult {
  /** WebAuthn assertion ceremony error class, if any. */
  error?: string;
  /** Validated session on success. */
  session?: LoginResult;
}

export interface AuthClient {
  // ---- WebAuthn ceremony surface --------------------------------------
  attemptPasskeyAssert(user_id: string, assertion: string): Promise<AuthResponse>;
  assertFromOrigin(origin: string, credential: PasskeyCredential): Promise<PasskeyAssertResult>;

  // ---- TOTP bootstrap surface -----------------------------------------
  attemptTotpLogin(user_id: string, totp_code: string): Promise<AuthResponse>;

  // ---- Session surface -------------------------------------------------
  callProtected(jwt: string, opts?: { route?: string }): Promise<AuthResponse>;
  revokeSession(session_id: string): Promise<AuthResponse>;

  // ---- Browser-baseline gate ------------------------------------------
  checkBrowserBaseline(userAgent: string): BrowserBaselineCheck;

  // ---- Public-API operations used directly by tests --------------------
  enrollFirstDevice(opts: { totp_code: string; user_id: string }): Promise<EnrollResult>;
  loginPasskey(
    credential: PasskeyCredential,
    opts?: { device_fingerprint?: string }
  ): Promise<LoginResult>;
  listSessions(user_id: string): Promise<AuthSession[]>;
  revokeAllSessions(user_id: string): Promise<void>;
  revokePasskey(credentialId: string, revoked_by_user_id: string): Promise<void>;
}
