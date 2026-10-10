import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AuditStore } from './store.js';

export const MEXC_CREDENTIALS_STATE_KEY = 'exchange.mexc.credentials.v1';

export interface MexcCredentials {
  apiKey: string;
  apiSecret: string;
}

export type CredentialSource = 'settings' | 'environment' | 'none';

export interface CredentialStatus {
  apiKeyConfigured: boolean;
  apiSecretConfigured: boolean;
  /** Masked key for recognition only. The secret is never exposed. */
  apiKeyPreview: string | null;
  source: CredentialSource;
  /** True when credentials saved from the settings page survive a restart (requires CREDENTIAL_ENCRYPTION_KEY). */
  persistent: boolean;
  /** A saved record exists but cannot be decrypted with the current CREDENTIAL_ENCRYPTION_KEY. */
  storedRecordUnreadable: boolean;
}

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}

const CREDENTIAL_PATTERN = /^[\x21-\x7E]{8,256}$/;

export function validateMexcCredentials(input: { apiKey?: unknown; apiSecret?: unknown }): MexcCredentials {
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const apiSecret = typeof input.apiSecret === 'string' ? input.apiSecret.trim() : '';
  if (!CREDENTIAL_PATTERN.test(apiKey)) throw new Error('API key must be 8–256 visible characters with no spaces.');
  if (!CREDENTIAL_PATTERN.test(apiSecret)) throw new Error('API secret must be 8–256 visible characters with no spaces.');
  return { apiKey, apiSecret };
}

function maskKey(apiKey: string): string {
  return apiKey.length <= 8 ? '••••' : `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

/**
 * Holds MEXC API credentials for the server process.
 * Precedence: credentials saved from the settings page, then environment variables.
 * Saved credentials are written to the audit store only when CREDENTIAL_ENCRYPTION_KEY is set,
 * and are encrypted with AES-256-GCM. They never leave the server.
 */
export class CredentialManager {
  private saved: MexcCredentials | undefined;
  private loadFailed = false;
  private readonly encryptionKey: Buffer | undefined;

  constructor(
    private readonly store: AuditStore,
    private readonly environment: Partial<MexcCredentials>,
    encryptionPassphrase: string | undefined,
  ) {
    const passphrase = encryptionPassphrase?.trim();
    this.encryptionKey = passphrase ? createHash('sha256').update(passphrase, 'utf8').digest() : undefined;
  }

  get persistent(): boolean {
    return this.encryptionKey !== undefined;
  }

  async load(): Promise<void> {
    if (!this.encryptionKey) return;
    const payload = await this.store.getState<EncryptedPayload>(MEXC_CREDENTIALS_STATE_KEY);
    if (!payload) return;
    try {
      this.saved = validateMexcCredentials(JSON.parse(this.decrypt(payload)) as Record<string, unknown>);
    } catch {
      // Wrong key or corrupted record: refuse to use it silently, and surface it in status.
      this.saved = undefined;
      this.loadFailed = true;
    }
  }

  /** Credentials in effect right now, or undefined when none are configured. */
  current(): MexcCredentials | undefined {
    if (this.saved) return this.saved;
    const { apiKey, apiSecret } = this.environment;
    if (apiKey?.trim() && apiSecret?.trim()) return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
    return undefined;
  }

  status(): CredentialStatus {
    const active = this.current();
    const source: CredentialSource = this.saved ? 'settings' : active ? 'environment' : 'none';
    return {
      apiKeyConfigured: Boolean(active?.apiKey),
      apiSecretConfigured: Boolean(active?.apiSecret),
      apiKeyPreview: active ? maskKey(active.apiKey) : null,
      source,
      persistent: this.persistent,
      storedRecordUnreadable: this.loadFailed,
    };
  }

  async save(credentials: MexcCredentials): Promise<void> {
    if (this.encryptionKey) {
      await this.store.setState(MEXC_CREDENTIALS_STATE_KEY, this.encrypt(JSON.stringify(credentials)));
    }
    this.saved = credentials;
    this.loadFailed = false;
  }

  async clear(): Promise<void> {
    if (this.encryptionKey) await this.store.setState(MEXC_CREDENTIALS_STATE_KEY, null);
    this.saved = undefined;
    this.loadFailed = false;
  }

  private encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey!, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  private decrypt(payload: EncryptedPayload): string {
    if (payload.version !== 1) throw new Error('Unsupported credential record version.');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey!, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  }
}
