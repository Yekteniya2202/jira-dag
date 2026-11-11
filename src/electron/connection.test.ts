import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDesktopConnection, requireProtectedCiphertext, type CredentialCipher } from './connection.js';

test('desktop validates the stored login on restart and clears it on disconnect', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jira-dag-connection-'));
  const filename = join(directory, 'connection.v1.bin');
  t.after(async () => {
    await rm(filename, { force: true });
    await rmdir(directory);
  });
  const token = 'accepted-test-token';
  let status = 200;
  const mock = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${token}`;
    response.writeHead(authorized ? status : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ displayName: 'Test User' }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise<void>((resolve) => mock.close(() => resolve())));
  const address = mock.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/jira`;
  const cipher: CredentialCipher = {
    encrypt: async (value) => Buffer.from(Buffer.from(value).toString('base64')),
    decrypt: async (value) => Buffer.from(value.toString(), 'base64').toString(),
  };
  const login = { edition: 'data-center', url, username: '', email: '', token, remember: true };
  const initial = createDesktopConnection(filename, cipher);
  assert.equal((await initial.invoke({ method: 'connect', input: { ...login, token: 'wrong' } })).ok, false);
  await assert.rejects(stat(filename), { code: 'ENOENT' });
  assert.equal((await initial.invoke({ method: 'connect', input: login })).ok, true);
  const saved = await readFile(filename);
  initial.close();

  status = 503;
  const restarted = createDesktopConnection(filename, cipher);
  assert.equal((await restarted.restore()).ok, false);
  assert.deepEqual(await readFile(filename), saved);
  status = 200;
  assert.deepEqual(await restarted.restore(), {
    ok: true,
    data: { connection: { url, displayName: 'Test User' }, edition: 'data-center' },
  });
  assert.equal((await restarted.invoke({ method: 'disconnect', input: null })).ok, true);
  assert.deepEqual(await createDesktopConnection(filename, cipher).restore(), { ok: true, data: null });
});

test('Linux accepts only ciphertext from the pinned system keyring providers', () => {
  assert.throws(() => requireProtectedCiphertext(Buffer.from('v10fallback'), 'linux'));
  assert.throws(() => requireProtectedCiphertext(Buffer.from('unknown'), 'linux'));
  for (const version of ['v11', 'v12']) {
    const ciphertext = Buffer.from(version + 'payload');
    assert.equal(requireProtectedCiphertext(ciphertext, 'linux'), ciphertext);
  }
  const windowsCiphertext = Buffer.from('v10dpapi');
  assert.equal(requireProtectedCiphertext(windowsCiphertext, 'win32'), windowsCiphertext);
});
