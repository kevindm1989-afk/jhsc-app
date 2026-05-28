/**
 * T07 — G-T07-10 + G-T07-15 structural-contract tests.
 *
 * Pins the interface split: the server-bound `KeyStore` MUST NOT carry any
 * method that takes or returns the identity private key, and the device-
 * local `LocalIdentityStore` is the ONLY interface that does. This is the
 * structural enforcement of Invariant 1 — a future `SupabaseKeyStore`
 * implementing `KeyStore` cannot, by typing alone, persist a private key.
 *
 * Also exercises G-T07-15: `client.identity_selftest_fail` is emitted via
 * the typed `recordSelftestFail` method — no `as unknown` cast required —
 * and lands in the same audit log as the closed-enum events but with the
 * separate event_type string.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryKeyStore,
  makeKeyCore,
  identitySelfTest,
  enrollIdentityKeypair,
  type KeyStore,
  type LocalIdentityStore
} from '../../src/lib/crypto';

describe('T07 / G-T07-10 — KeyStore vs LocalIdentityStore structural split', () => {
  it('the KeyStore interface has NO method that takes or returns a private key', () => {
    // The check is a *type-level* contract: any property named like a
    // private-key surface would be a regression. Spot-check the obvious
    // candidates. The compile-time guarantee is the real safety net (the
    // tsc gate would already have failed before we got here if anyone
    // added one), this runtime assertion is the canary in case the
    // declaration is bypassed via `as` casts.
    const store = new MemoryKeyStore();
    const ks = store as unknown as Record<string, unknown>;
    const forbidden = [
      'storeIdentityKeys', // the pre-split name; must NOT come back
      '__getIdentityPrivateKeyLocalOnly', // the pre-split name; must NOT come back
      'getIdentityPrivateKey', // belongs on LocalIdentityStore only
      'storeIdentityPrivateKey' // belongs on LocalIdentityStore only
    ];
    // MemoryKeyStore implements BOTH interfaces, so `getIdentityPrivateKey`
    // + `storeIdentityPrivateKey` DO exist on the concrete class — but
    // the LIST OF KEYS ON THE `KeyStore` TYPE does not include them. We
    // assert this via a type-level test using a satisfies-style check.
    // The line below would not compile if KeyStore re-grew a private-key
    // method, because the assigned object literal would have to satisfy
    // it. (No `as KeyStore` cast — the inference is structural.)
    const onlyServerBound: KeyStore = {
      persistIdentityPublicKey: store.persistIdentityPublicKey.bind(store),
      getIdentityPublicKey: store.getIdentityPublicKey.bind(store),
      storeRecoveryBlob: store.storeRecoveryBlob.bind(store),
      getRecoveryBlob: store.getRecoveryBlob.bind(store),
      recordRecoveryBlobViewed: store.recordRecoveryBlobViewed.bind(store),
      markRecoveryResetIssued: store.markRecoveryResetIssued.bind(store),
      initCommitteeDataKey: store.initCommitteeDataKey.bind(store),
      getCurrentCommitteeKeyMetadata: store.getCurrentCommitteeKeyMetadata.bind(store),
      insertCommitteeKeyWrap: store.insertCommitteeKeyWrap.bind(store),
      getCurrentCommitteeKeyWrap: store.getCurrentCommitteeKeyWrap.bind(store),
      deleteWrapsForMember: store.deleteWrapsForMember.bind(store),
      markCommitteeKeyRotated: store.markCommitteeKeyRotated.bind(store),
      listActiveMemberIds: store.listActiveMemberIds.bind(store),
      isActiveMember: store.isActiveMember.bind(store),
      recordKeyEvent: store.recordKeyEvent.bind(store),
      recordSelftestFail: store.recordSelftestFail.bind(store),
      pseudonymOf: store.pseudonymOf.bind(store),
      tryAcquireRotationLock: store.tryAcquireRotationLock.bind(store),
      releaseRotationLock: store.releaseRotationLock.bind(store)
    };
    // Use the binding so the variable is not flagged as unused. The real
    // assertion is the literal above type-checking.
    expect(typeof onlyServerBound.persistIdentityPublicKey).toBe('function');
    // The forbidden names should not appear on the structural KeyStore
    // type. (They DO appear on MemoryKeyStore because it implements both
    // interfaces — the test asserts the typing of `onlyServerBound`, not
    // the concrete class.)
    for (const name of forbidden) {
      // Runtime sanity: confirm none of the pre-split names exist (they
      // would only exist if a regression re-added them).
      if (name === 'storeIdentityKeys' || name === '__getIdentityPrivateKeyLocalOnly') {
        expect(ks[name]).toBeUndefined();
      }
    }
  });

  it('LocalIdentityStore is the sole holder of the private-key methods', () => {
    const store = new MemoryKeyStore();
    // The LocalIdentityStore interface has exactly the two private-key
    // methods. Construct a value-shape that satisfies it without leaning
    // on any other MemoryKeyStore method.
    const onlyDeviceLocal: LocalIdentityStore = {
      storeIdentityPrivateKey: store.storeIdentityPrivateKey.bind(store),
      getIdentityPrivateKey: store.getIdentityPrivateKey.bind(store)
    };
    expect(typeof onlyDeviceLocal.storeIdentityPrivateKey).toBe('function');
    expect(typeof onlyDeviceLocal.getIdentityPrivateKey).toBe('function');
  });

  it('enrollIdentityKeypair routes the private half through localIdentity and the public half through store', async () => {
    const store = new MemoryKeyStore();
    const core = makeKeyCore({ store });
    const result = await enrollIdentityKeypair(core, { user_id: 'u-1' });
    if (result.status !== 'ok') throw new Error(`enroll failed: ${JSON.stringify(result)}`);
    // The public half landed on KeyStore.
    const pub = await core.store.getIdentityPublicKey('u-1');
    expect(pub.length).toBe(32);
    // The private half landed on LocalIdentityStore.
    const priv = await core.localIdentity.getIdentityPrivateKey('u-1');
    expect(priv.length).toBe(32);
    // Sanity: the two halves form a valid keypair (selfTestKeypair is
    // exercised inside enrollIdentityKeypair, so reaching status:'ok' is
    // proof-of-pair).
    expect(result.public_key).toEqual(pub);
  });
});

describe('T07 / G-T07-15 — client.identity_selftest_fail via the typed emission path', () => {
  it('identitySelfTest emits client.identity_selftest_fail through recordSelftestFail on a pubkey-length mismatch', async () => {
    const store = new MemoryKeyStore();
    const core = makeKeyCore({ store });
    await enrollIdentityKeypair(core, { user_id: 'u-1' });
    // Force a corruption: overwrite the device-local privkey with a wrong-
    // length blob so the F-03 self-test trips.
    await core.localIdentity.storeIdentityPrivateKey('u-1', new Uint8Array(31));
    const result = await identitySelfTest(core, { user_id: 'u-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.next_action).toBe('recovery_flow');
    // The MemoryKeyStore audits the emission; assert the row landed via
    // the dedicated path (event_type === the non-enum string; no rotation_id).
    const rows = store.__debugAuditRows();
    const fail = rows.find((r) => r.event_type === 'client.identity_selftest_fail');
    expect(fail).toBeDefined();
    expect(fail?.rotation_id).toBeNull();
    expect(fail?.meta).toMatchObject({ actor_id: 'u-1' });
  });

  it('recordSelftestFail has its own typed signature (no `as unknown` cast required)', async () => {
    const store = new MemoryKeyStore();
    // Call the method directly via the typed surface — no `as unknown`,
    // no `as never`. This is the contract pin for G-T07-15.
    await store.recordSelftestFail({
      actor_pseudonym: store.pseudonymOf('u-1'),
      meta: { actor_id: 'u-1', reason: 'idb_corruption' }
    });
    const rows = store.__debugAuditRows();
    const last = rows[rows.length - 1];
    expect(last?.event_type).toBe('client.identity_selftest_fail');
  });
});
