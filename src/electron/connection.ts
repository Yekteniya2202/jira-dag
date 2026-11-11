import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApiResponse, JiraConnection, JiraCredentials, JiraLogin, RestoredJiraConnection } from '../shared/contracts.js';
import { createApiSession, parseJiraCredentials } from '../server/session.js';

export interface CredentialCipher {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

export function requireProtectedCiphertext(value: Buffer, platform = process.platform): Buffer {
  // Chromium's Linux async storage prefixes ciphertext with its key provider.
  // v11 and v12 use a system keyring, while v10 is the built-in fallback.
  if (!value.length || (platform === 'linux' && !['v11', 'v12'].includes(value.toString('latin1', 0, 3)))) {
    throw new Error('System credential storage is unavailable.');
  }
  return value;
}

async function waitForCredentialStorage<T>(operation: Promise<T>): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(10_000, undefined, { signal: timer.signal, ref: false }).then(() => {
        throw new Error('System credential storage did not respond.');
      }),
    ]);
  } finally {
    timer.abort();
  }
}

export function createDesktopConnection(filename: string, cipher: CredentialCipher) {
  let jira = createApiSession();
  let active: RestoredJiraConnection | undefined;
  let closed = false;
  let pending = Promise.resolve();

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = pending.then(action);
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readCredentials() {
    const encrypted = await readFile(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (encrypted === undefined) return undefined;
    const plaintext = await waitForCredentialStorage(cipher.decrypt(encrypted));
    return parseJiraCredentials(JSON.parse(plaintext) as unknown);
  }

  async function saveCredentials(credentials: JiraCredentials) {
    const encrypted = await waitForCredentialStorage(cipher.encrypt(JSON.stringify(credentials)));
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function invoke(value: unknown): Promise<ApiResponse> {
    const request = value as { method?: unknown; input?: unknown } | null | undefined;
    if (request?.method === 'connect') {
      return serialize(async () => {
        const next = createApiSession();
        const result = await next.invoke(value);
        if (!result.ok) return result;
        if (closed) {
          next.disconnect();
          return { ok: false, error: 'The Jira connection changed.', status: 409 };
        }
        const credentials = parseJiraCredentials(request.input);
        const connection = result.data as JiraConnection;
        jira.disconnect();
        jira = next;
        active = { connection, edition: credentials.edition };
        try {
          if ((request.input as JiraLogin).remember === true) await saveCredentials(credentials);
          else await rm(filename, { force: true });
          return result;
        } catch {
          return { ok: true, data: { ...connection, rememberFailed: true } };
        }
      });
    }
    if (request?.method === 'disconnect' && request.input === null) {
      return serialize(async () => {
        try {
          await rm(filename, { force: true });
        } catch {
          return { ok: false, error: 'Could not remove the saved Jira connection.' };
        }
        active = undefined;
        return jira.invoke(value);
      });
    }
    return jira.invoke(value);
  }

  function restore(): Promise<ApiResponse<RestoredJiraConnection | null>> {
    return serialize(async () => {
      if (active) return { ok: true, data: active };
      try {
        const credentials = await readCredentials();
        if (!credentials || closed) return { ok: true, data: null };
        const result = await jira.invoke({ method: 'connect', input: credentials });
        if (!result.ok) return result;
        active = { connection: result.data as JiraConnection, edition: credentials.edition };
        return { ok: true, data: active };
      } catch {
        return { ok: false, error: 'Could not read the saved Jira connection.' };
      }
    });
  }

  return {
    invoke,
    restore,
    close: () => {
      closed = true;
      jira.disconnect();
    },
    getIssueUrl: (key: unknown) => jira.getIssueUrl(key),
  };
}
