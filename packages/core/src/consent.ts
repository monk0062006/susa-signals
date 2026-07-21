import type { KeyValueStore } from './platform.js';

/**
 * Consent is modelled in `core`, not in each platform's UI, because it is a
 * correctness constraint rather than a presentation detail.
 *
 * Bug reports carry implicit consent: the user pressed a button and chose what
 * to send. Session replay does not — it records continuously, before the user
 * has any reason to think about it. GDPR/CCPA treat those as different acts, so
 * the recorder is gated on an explicit grant that is stored, versioned and
 * revocable, and capture is refused when no grant exists.
 */

export type ConsentScope =
  /** Screenshot at the moment the user files a report. */
  | 'screenshot'
  /** Console and network buffers attached to a report. */
  | 'diagnostics'
  /** Continuous DOM session replay. The consequential one. */
  | 'session_replay'
  /**
   * Product analytics. A separate legal basis from diagnostics under GDPR and
   * ePrivacy, so it cannot ride on the implicit consent that filing a bug
   * report carries.
   */
  | 'analytics';

export interface ConsentRecord {
  scopes: ConsentScope[];
  /** Bumped when the consent copy changes materially; old grants stop counting. */
  policyVersion: string;
  grantedAt: number;
  /** Where the grant came from, for audit. */
  source: 'explicit_prompt' | 'host_app';
}

const STORAGE_KEY = 'susa.signals.consent.v1';

export class ConsentManager {
  private cached: ConsentRecord | null = null;
  private loaded = false;

  constructor(
    private readonly storage: KeyValueStore,
    /** Current policy version. A grant for an older version is not honoured. */
    private readonly policyVersion: string,
  ) {}

  async load(): Promise<ConsentRecord | null> {
    if (this.loaded) return this.cached;
    this.loaded = true;

    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!raw) return null;
      const record = JSON.parse(raw) as ConsentRecord;

      // A grant against superseded terms is not a grant against these ones.
      if (record.policyVersion !== this.policyVersion) {
        this.cached = null;
        return null;
      }

      this.cached = record;
      return record;
    } catch {
      // Unreadable consent must fail closed — treat as "not granted".
      this.cached = null;
      return null;
    }
  }

  /**
   * The gate every capture path calls. Defaults to false on any uncertainty:
   * a missed recording is a product problem, an unconsented one is a legal one.
   */
  async has(scope: ConsentScope): Promise<boolean> {
    const record = await this.load();
    return record?.scopes.includes(scope) ?? false;
  }

  async grant(scopes: ConsentScope[], source: ConsentRecord['source']): Promise<ConsentRecord> {
    const record: ConsentRecord = {
      scopes,
      policyVersion: this.policyVersion,
      grantedAt: Date.now(),
      source,
    };
    this.cached = record;
    this.loaded = true;
    await this.storage.set(STORAGE_KEY, JSON.stringify(record));
    return record;
  }

  /** Withdrawal must be as easy as granting, and takes effect immediately. */
  async revoke(): Promise<void> {
    this.cached = null;
    this.loaded = true;
    await this.storage.remove(STORAGE_KEY);
  }
}
