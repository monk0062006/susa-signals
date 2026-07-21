import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { AuditLog } from '../src/db/audit.js';
import {
  AesEncryptor,
  NoEncryption,
  PLAINTEXT_KEY_ID,
  encryptorFromEnv,
  generateKey,
  keyId,
} from '../src/db/encryption.js';
import { Repository } from '../src/db/repository.js';
import { bugReport, replayChunk, setupSchema, testPool, truncateAll } from './helpers.js';

let pool: Pool;

before(async () => {
  pool = testPool();
  await setupSchema(pool);
});

beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE feedback.audit_log');
});

after(async () => {
  await pool.end();
});

function encryptor(): AesEncryptor {
  const key = randomBytes(32);
  return new AesEncryptor(new Map([[keyId(key), key]]), keyId(key));
}

describe('encryption primitives', () => {
  it('round-trips a payload', () => {
    const crypto = encryptor();
    const plaintext = Buffer.from('a screenshot, conceptually');

    const sealed = crypto.encrypt(plaintext);
    assert.notDeepEqual(sealed.bytes, plaintext, 'ciphertext must differ from plaintext');
    assert.deepEqual(crypto.decrypt(sealed.bytes, sealed.keyId), plaintext);
  });

  it('produces different ciphertext for identical input', () => {
    const crypto = encryptor();
    const a = crypto.encrypt(Buffer.from('same'));
    const b = crypto.encrypt(Buffer.from('same'));

    // A fresh IV per record. Reusing one under GCM leaks the XOR of two
    // plaintexts and destroys authentication entirely.
    assert.notDeepEqual(a.bytes, b.bytes);
  });

  it('refuses tampered ciphertext rather than returning garbage', () => {
    const crypto = encryptor();
    const sealed = crypto.encrypt(Buffer.from('sensitive'));

    const tampered = Buffer.from(sealed.bytes);
    tampered[tampered.length - 1] ^= 0xff;

    // This is the reason for GCM over CBC: authenticated failure instead of
    // plausible-looking rubbish that downstream code tries to parse.
    assert.equal(crypto.decrypt(tampered, sealed.keyId), null);
  });

  it('refuses truncated ciphertext', () => {
    const crypto = encryptor();
    const sealed = crypto.encrypt(Buffer.from('sensitive'));

    assert.equal(crypto.decrypt(sealed.bytes.subarray(0, 8), sealed.keyId), null);
  });

  it('returns null for a key it does not hold', () => {
    const crypto = encryptor();
    const sealed = crypto.encrypt(Buffer.from('sensitive'));

    assert.equal(crypto.decrypt(sealed.bytes, 'some-other-key-id'), null);
  });

  it('decrypts data written under a rotated-out key', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const before = new AesEncryptor(new Map([[keyId(oldKey), oldKey]]), keyId(oldKey));
    const sealed = before.encrypt(Buffer.from('written yesterday'));

    // After rotation: new key is active, old key retained for reads.
    const after = new AesEncryptor(
      new Map([[keyId(newKey), newKey], [keyId(oldKey), oldKey]]),
      keyId(newKey),
    );

    assert.equal(after.activeKeyId, keyId(newKey));
    assert.deepEqual(after.decrypt(sealed.bytes, sealed.keyId), Buffer.from('written yesterday'));
  });

  it('reads plaintext rows written before encryption was enabled', () => {
    const crypto = encryptor();
    const legacy = Buffer.from('stored before the key existed');

    // Otherwise switching encryption on would make all existing data unreadable.
    assert.deepEqual(crypto.decrypt(legacy, PLAINTEXT_KEY_ID), legacy);
  });

  it('rejects a key of the wrong length instead of silently weakening', () => {
    const short = randomBytes(16);
    assert.throws(() => new AesEncryptor(new Map([[keyId(short), short]]), keyId(short)));
  });

  it('derives stable key ids from key material', () => {
    const key = randomBytes(32);
    assert.equal(keyId(key), keyId(key));
    assert.notEqual(keyId(key), keyId(randomBytes(32)));
  });
});

describe('encryptor from environment', () => {
  it('defaults to no encryption when no key is set', () => {
    const crypto = encryptorFromEnv({});
    assert.equal(crypto.enabled, false);
    assert.equal(crypto.activeKeyId, PLAINTEXT_KEY_ID);
  });

  it('enables encryption when a key is present', () => {
    const crypto = encryptorFromEnv({ SIGNALS_ENCRYPTION_KEY: generateKey() });
    assert.equal(crypto.enabled, true);
  });

  it('rejects a malformed key loudly at boot', () => {
    // Better to fail starting than to run unencrypted while believing otherwise.
    assert.throws(() => encryptorFromEnv({ SIGNALS_ENCRYPTION_KEY: 'not-base64-32-bytes' }));
  });

  it('accepts retired keys for decryption', () => {
    const crypto = encryptorFromEnv({
      SIGNALS_ENCRYPTION_KEY: generateKey(),
      SIGNALS_ENCRYPTION_KEYS_OLD: `${generateKey()}, ${generateKey()}`,
    });
    assert.equal(crypto.enabled, true);
  });
});

describe('encryption at rest', () => {
  it('stores attachment bytes encrypted and returns them decrypted', async () => {
    const crypto = encryptor();
    const repo = new Repository(pool, crypto);
    const id = randomUUID();
    const bytes = Buffer.from('PNG-ish bytes with a secret in them');

    await repo.saveAttachment({
      id,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes,
    });

    // What actually sits on disk must not be the plaintext.
    const { rows } = await pool.query('SELECT bytes, encryption_key_id FROM feedback.attachments WHERE id = $1', [id]);
    assert.notDeepEqual(rows[0].bytes, bytes, 'attachment stored in plaintext');
    assert.notEqual(rows[0].encryption_key_id, PLAINTEXT_KEY_ID);
    assert.equal(rows[0].bytes.includes(Buffer.from('secret')), false);

    // And a legitimate read still gets the original.
    const read = await repo.readAttachment('proj_test', id);
    assert.deepEqual(read?.bytes, bytes);
  });

  it('records the plaintext size, not the ciphertext size', async () => {
    const repo = new Repository(pool, encryptor());
    const id = randomUUID();
    const bytes = randomBytes(5000);

    await repo.saveAttachment({ id, projectId: 'proj_test', kind: 'screenshot', mimeType: 'image/png', bytes });

    const { rows } = await pool.query('SELECT byte_size FROM feedback.attachments WHERE id = $1', [id]);
    // The dashboard shows this to a human; it should not change because the
    // storage layer added an envelope.
    assert.equal(rows[0].byte_size, 5000);
  });

  it('cannot read an attachment with the wrong key', async () => {
    const repo = new Repository(pool, encryptor());
    const id = randomUUID();

    await repo.saveAttachment({
      id, projectId: 'proj_test', kind: 'screenshot', mimeType: 'image/png',
      bytes: Buffer.from('secret'),
    });

    // Simulates a stolen database without the key material.
    const otherRepo = new Repository(pool, encryptor());
    assert.equal(await otherRepo.readAttachment('proj_test', id), null);
  });

  it('stores replay events encrypted', async () => {
    const repo = new Repository(pool, encryptor());
    const sessionId = randomUUID();

    await repo.appendReplayChunk(
      replayChunk({ sessionId, seq: 0, events: [{ secretText: 'do-not-store-plainly' }] }),
    );

    const { rows } = await pool.query(
      'SELECT events, events_encrypted, encryption_key_id FROM feedback.replay_chunks WHERE session_id = $1',
      [sessionId],
    );
    assert.equal(rows[0].events, null, 'plaintext events column should be empty');
    assert.ok(rows[0].events_encrypted, 'encrypted column should be populated');
    assert.equal(
      rows[0].events_encrypted.includes(Buffer.from('do-not-store-plainly')),
      false,
      'replay content found in plaintext on disk',
    );

    const session = await repo.readReplaySession('proj_test', sessionId);
    assert.deepEqual(session?.events, [{ secretText: 'do-not-store-plainly' }]);
  });

  it('still reads sessions written before encryption was enabled', async () => {
    const plain = new Repository(pool, new NoEncryption());
    const sessionId = randomUUID();
    await plain.appendReplayChunk(replayChunk({ sessionId, seq: 0, events: [{ a: 1 }] }));

    // Encryption switched on afterwards; old rows must remain playable.
    const encrypted = new Repository(pool, encryptor());
    const session = await encrypted.readReplaySession('proj_test', sessionId);

    assert.deepEqual(session?.events, [{ a: 1 }]);
  });

  it('skips an undecryptable chunk rather than losing the whole session', async () => {
    const crypto = encryptor();
    const repo = new Repository(pool, crypto);
    const sessionId = randomUUID();

    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 0, events: [{ n: 'first' }] }));
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 1, events: [{ n: 'second' }] }));

    // Corrupt one chunk's key reference, as a rotated-away key would.
    await pool.query(
      `UPDATE feedback.replay_chunks SET encryption_key_id = 'lost-key' WHERE session_id = $1 AND seq = 1`,
      [sessionId],
    );

    const session = await repo.readReplaySession('proj_test', sessionId);
    // A recording with a gap beats no recording at all.
    assert.deepEqual(session?.events, [{ n: 'first' }]);
  });
});

describe('audit log', () => {
  it('records a read and returns it', async () => {
    const audit = new AuditLog(pool);
    const sessionId = randomUUID();

    await audit.recordSync({
      projectId: 'proj_test',
      action: 'replay.read',
      subjectType: 'replay_session',
      subjectId: sessionId,
      actor: 'dana@staff.example',
      requestId: 'req-1',
      ip: '203.0.113.9',
      detail: { events: 42 },
    });

    const page = await audit.query('proj_test');
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.action, 'replay.read');
    assert.equal(page.entries[0]?.actor, 'dana@staff.example');
    assert.equal(page.entries[0]?.ip, '203.0.113.9');
  });

  it('answers "who accessed this recording"', async () => {
    const audit = new AuditLog(pool);
    const watched = randomUUID();

    await audit.recordSync({ projectId: 'proj_test', action: 'replay.read', subjectId: watched, actor: 'a@x' });
    await audit.recordSync({ projectId: 'proj_test', action: 'replay.read', subjectId: watched, actor: 'b@x' });
    await audit.recordSync({ projectId: 'proj_test', action: 'replay.read', subjectId: randomUUID(), actor: 'c@x' });

    const page = await audit.query('proj_test', { subjectId: watched });
    assert.equal(page.entries.length, 2);
    assert.deepEqual(page.entries.map((e) => e.actor).sort(), ['a@x', 'b@x']);
  });

  it('scopes to the project', async () => {
    const audit = new AuditLog(pool);
    await audit.recordSync({ projectId: 'project_a', action: 'submission.list' });
    await audit.recordSync({ projectId: 'project_b', action: 'submission.list' });

    assert.equal((await audit.query('project_a')).entries.length, 1);
  });

  it('tolerates a malformed ip rather than losing the record', async () => {
    const audit = new AuditLog(pool);
    await audit.recordSync({ projectId: 'proj_test', action: 'replay.read', ip: 'not-an-ip' });

    const page = await audit.query('proj_test');
    // The record survives; only the unparseable field is dropped.
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.ip, undefined);
  });

  it('survives the project being deleted', async () => {
    const repo = new Repository(pool);
    await repo.saveSubmission(bugReport({ projectId: 'doomed' }));

    const audit = new AuditLog(pool);
    await audit.recordSync({ projectId: 'doomed', action: 'submission.list' });

    await pool.query(`DELETE FROM feedback.projects WHERE id = 'doomed'`);

    // Deliberately not foreign-keyed: deleting a project must not erase the
    // evidence of who read it first.
    assert.equal((await audit.query('doomed')).entries.length, 1);
  });

  it('prunes entries past their retention window', async () => {
    const audit = new AuditLog(pool);
    await audit.recordSync({ projectId: 'proj_test', action: 'submission.list' });
    await pool.query(`UPDATE feedback.audit_log SET occurred_at = now() - interval '400 days'`);

    // Audit logs record IPs and actors, so they are personal data too and
    // cannot be kept indefinitely.
    assert.equal(await audit.prune(365), 1);
    assert.equal((await audit.query('proj_test')).entries.length, 0);
  });
});
