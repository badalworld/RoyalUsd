import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialManager, MEXC_CREDENTIALS_STATE_KEY, validateMexcCredentials } from '../src/server/credentials.js';
import { SqliteAuditStore } from '../src/server/store.js';

test('saved credentials are encrypted at rest and survive restart with the same passphrase', async () => {
  const store = new SqliteAuditStore(':memory:');
  const first = new CredentialManager(store, {}, 'passphrase-one');
  await first.load();
  assert.equal(first.status().source, 'none');
  await first.save({ apiKey: 'MX0key-value-1234', apiSecret: 'secret-value-5678' });

  const raw = JSON.stringify(await store.getState(MEXC_CREDENTIALS_STATE_KEY));
  assert.ok(!raw.includes('MX0key-value-1234'), 'api key must not be stored in plaintext');
  assert.ok(!raw.includes('secret-value-5678'), 'api secret must not be stored in plaintext');

  const restarted = new CredentialManager(store, {}, 'passphrase-one');
  await restarted.load();
  assert.deepEqual(restarted.current(), { apiKey: 'MX0key-value-1234', apiSecret: 'secret-value-5678' });
  const status = restarted.status();
  assert.equal(status.source, 'settings');
  assert.equal(status.persistent, true);
  assert.equal(status.apiKeyPreview, 'MX0k••••1234');
  assert.ok(!JSON.stringify(status).includes('secret-value-5678'));
  await store.close();
});

test('a wrong encryption passphrase makes the stored record unusable instead of silently using it', async () => {
  const store = new SqliteAuditStore(':memory:');
  const writer = new CredentialManager(store, {}, 'passphrase-one');
  await writer.save({ apiKey: 'MX0key-value-1234', apiSecret: 'secret-value-5678' });
  const reader = new CredentialManager(store, {}, 'different-passphrase');
  await reader.load();
  assert.equal(reader.current(), undefined);
  assert.equal(reader.status().storedRecordUnreadable, true);
  await store.close();
});

test('without an encryption passphrase, settings are kept in memory only and environment credentials remain the fallback', async () => {
  const store = new SqliteAuditStore(':memory:');
  const manager = new CredentialManager(store, { apiKey: 'env-key-0001', apiSecret: 'env-secret-0001' }, undefined);
  await manager.load();
  assert.equal(manager.status().source, 'environment');
  await manager.save({ apiKey: 'ui-key-00002', apiSecret: 'ui-secret-0002' });
  assert.equal(manager.current()?.apiKey, 'ui-key-00002');
  assert.equal(manager.status().persistent, false);
  assert.equal(await store.getState(MEXC_CREDENTIALS_STATE_KEY), undefined);
  await manager.clear();
  assert.equal(manager.current()?.apiKey, 'env-key-0001');
  await store.close();
});

test('credential validation rejects blank, short, and whitespace-containing values', () => {
  assert.throws(() => validateMexcCredentials({ apiKey: '', apiSecret: 'secret-value' }), /API key/);
  assert.throws(() => validateMexcCredentials({ apiKey: 'short', apiSecret: 'secret-value' }), /API key/);
  assert.throws(() => validateMexcCredentials({ apiKey: 'api-key-value', apiSecret: 'bad secret value' }), /API secret/);
  assert.deepEqual(validateMexcCredentials({ apiKey: '  api-key-value  ', apiSecret: 'secret-value' }), { apiKey: 'api-key-value', apiSecret: 'secret-value' });
});
