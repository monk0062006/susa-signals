import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for data at rest.
 *
 * Screenshots and replay frames are the most sensitive things this service
 * stores: a screenshot is whatever was on the user's screen, and a replay is
 * that repeated hundreds of times. Redaction protects against what the *user*
 * knew was sensitive; it does nothing about a stolen backup or a misconfigured
 * read replica. Encryption at rest is the control for that, and it is the one
 * an enterprise security review asks about by name.
 *
 * AES-256-GCM, not CBC: GCM authenticates as well as encrypts, so tampered
 * ciphertext fails loudly rather than decrypting to garbage that downstream
 * code then tries to parse.
 *
 * Uses only `node:crypto` — no dependency, and nothing to audit beyond this file.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const TAG_BYTES = 16;

export interface EncryptedPayload {
  /** iv || tag || ciphertext, so one column holds everything needed to decrypt. */
  bytes: Buffer;
  /** Which key encrypted this, so keys can be rotated without a rewrite. */
  keyId: string;
}

export interface Encryptor {
  encrypt(plaintext: Buffer): EncryptedPayload;
  /** Returns null when the key that encrypted this record is not available. */
  decrypt(payload: Buffer, keyId: string): Buffer | null;
  readonly activeKeyId: string;
  readonly enabled: boolean;
}

/**
 * Encryption that does nothing.
 *
 * The default, so an existing deployment does not break on upgrade and so local
 * development needs no key material. Every read path must therefore tolerate
 * plaintext rows — see `keyId === PLAINTEXT_KEY_ID`.
 */
export const PLAINTEXT_KEY_ID = 'plaintext';

export class NoEncryption implements Encryptor {
  readonly activeKeyId = PLAINTEXT_KEY_ID;
  readonly enabled = false;

  encrypt(plaintext: Buffer): EncryptedPayload {
    return { bytes: plaintext, keyId: PLAINTEXT_KEY_ID };
  }

  decrypt(payload: Buffer, keyId: string): Buffer | null {
    // A previously-encrypted row cannot be read without a key. Returning null
    // surfaces as a 404 rather than as corrupt bytes handed to a browser.
    return keyId === PLAINTEXT_KEY_ID ? payload : null;
  }
}

export class AesEncryptor implements Encryptor {
  readonly enabled = true;
  readonly activeKeyId: string;

  /**
   * @param keys All keys this instance can decrypt with, newest first. The first
   *   is used for new writes; the rest exist so a rotation does not orphan data
   *   written under the previous key.
   */
  constructor(private readonly keys: Map<string, Buffer>, activeKeyId: string) {
    const active = keys.get(activeKeyId);
    if (!active) throw new Error(`active key "${activeKeyId}" not present in key set`);
    if (active.length !== KEY_BYTES) {
      throw new Error(`encryption key must be ${KEY_BYTES} bytes, got ${active.length}`);
    }
    this.activeKeyId = activeKeyId;
  }

  encrypt(plaintext: Buffer): EncryptedPayload {
    const key = this.keys.get(this.activeKeyId) as Buffer;
    // A fresh IV per record. Reusing one under GCM is catastrophic — it leaks
    // the XOR of two plaintexts and destroys authentication.
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { bytes: Buffer.concat([iv, tag, ciphertext]), keyId: this.activeKeyId };
  }

  decrypt(payload: Buffer, keyId: string): Buffer | null {
    // Rows written before encryption was switched on are stored as-is.
    if (keyId === PLAINTEXT_KEY_ID) return payload;

    const key = this.keys.get(keyId);
    if (!key) return null;
    if (payload.length < IV_BYTES + TAG_BYTES) return null;

    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      // GCM throws when the tag does not verify: the record was tampered with,
      // truncated, or encrypted under a different key of the same id. Never
      // return partial plaintext in that case.
      return null;
    }
  }
}

/**
 * Builds an encryptor from the environment.
 *
 *   SIGNALS_ENCRYPTION_KEY      base64 of 32 random bytes — the active key
 *   SIGNALS_ENCRYPTION_KEYS_OLD comma-separated base64 keys kept for decryption
 *
 * Key ids are derived from the key material itself (a truncated SHA-256), so a
 * rotation cannot accidentally reuse an id for different bytes, and no separate
 * id has to be tracked alongside the secret.
 */
export function encryptorFromEnv(env: NodeJS.ProcessEnv = process.env): Encryptor {
  const active = env.SIGNALS_ENCRYPTION_KEY?.trim();
  if (!active) return new NoEncryption();

  const keys = new Map<string, Buffer>();

  const add = (encoded: string): string => {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== KEY_BYTES) {
      throw new Error(
        `encryption key must decode to ${KEY_BYTES} bytes; got ${raw.length}. ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    const id = keyId(raw);
    keys.set(id, raw);
    return id;
  };

  const activeId = add(active);

  for (const old of (env.SIGNALS_ENCRYPTION_KEYS_OLD ?? '').split(',')) {
    const trimmed = old.trim();
    if (trimmed) add(trimmed);
  }

  return new AesEncryptor(keys, activeId);
}

/** Stable, non-reversible identifier for a key. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Convenience for operators: `node -e "...generateKey()"`. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
