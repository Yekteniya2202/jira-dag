import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JiraError } from '../server/jira.js';
import { createApiSession, validateJiraSite } from '../server/session.js';
import type { ApiResponse } from '../shared/contracts.js';

const maxBodyBytes = 512 * 1024;
const idleTimeout = 30 * 60 * 1_000;
const maxSessions = 256;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface WebOptions {
  port: number;
  rendererDirectory: string;
  publicOrigin?: string;
  allowedSites?: string;
}

interface StoredSession {
  session: ReturnType<typeof createApiSession>;
  lastSeen: number;
}

function normalizedSite(url: URL): string {
  validateJiraSite(url);
  return url.href.replace(/\/+$/, '');
}

function jiraAllowlist(config = ''): Set<string> {
  try {
    return new Set(config.split(',').map(value => value.trim()).filter(Boolean)
      .map(value => normalizedSite(new URL(value))));
  } catch {
    throw new Error('JIRA_ALLOWED_SITES must contain comma-separated Jira base URLs.');
  }
}

function acceptedOrigins({ port, publicOrigin }: WebOptions): Set<string> {
  if (publicOrigin) {
    try {
      const url = new URL(publicOrigin);
      validateJiraSite(url);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.pathname !== '/' || (!loopback && url.protocol !== 'https:')) {
        throw new Error();
      }
      return new Set([url.origin]);
    } catch {
      throw new Error('WEB_ORIGIN must be the application origin. Use HTTPS for remote access.');
    }
  }
  return new Set([port, 5173].flatMap(p => [
    `http://localhost:${p}`,
    `http://127.0.0.1:${p}`,
    `http://[::1]:${p}`,
  ]));
}

function readSessionId(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(';').map(entry => entry.trim()) ?? [];
  const matching = cookies.filter(entry => entry.startsWith(`${name}=`));
  const id = matching.length === 1 ? matching[0]?.slice(name.length + 1) : undefined;
  return id && /^[\w-]{43}$/.test(id) ? id : undefined;
}

function setSessionCookie(response: ServerResponse, name: string, secure: boolean, id?: string): void {
  const value = `${name}=${id ?? ''}; Path=/; HttpOnly; SameSite=Strict`;
  response.setHeader('Set-Cookie', value + (secure ? '; Secure' : '') + (id ? '' : '; Max-Age=0'));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length']) > maxBodyBytes) {
    throw new HttpError(413, 'Request body is too large.');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function respond(response: ServerResponse, result: ApiResponse): void {
  let status = 200;
  if (!result.ok) {
    const candidate = result.status ?? 502;
    status = Number.isInteger(candidate) && candidate >= 400 && candidate < 600 ? candidate : 502;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(result));
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self' data:",
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join('; '));
}

function assetName(path: string): string {
  if (path === '/') return 'index.html';
  let name: string;
  try {
    name = decodeURIComponent(path).slice(1);
  } catch {
    throw new HttpError(404, 'File not found.');
  }
  if (name.split('/').some(segment => !/^[\w-][\w.-]*$/.test(segment))) {
    throw new HttpError(404, 'File not found.');
  }
  return name;
}

async function serveAsset(path: string, directory: string, response: ServerResponse, head: boolean): Promise<void> {
  const name = assetName(path);
  const type = contentTypes[extname(name).toLowerCase()];
  if (!type) throw new HttpError(404, 'File not found.');
  try {
    const root = await realpath(directory);
    const asset = await realpath(resolve(root, name));
    const target = relative(root, asset);
    if (target.startsWith('..') || isAbsolute(target)) throw new HttpError(404, 'File not found.');
    const contents = await readFile(asset);
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': contents.length });
    response.end(head ? undefined : contents);
  } catch {
    throw new HttpError(404, 'File not found.');
  }
}

export function createWebServer(options: WebOptions) {
  const origins = acceptedOrigins(options);
  const allowedSites = jiraAllowlist(options.allowedSites);
  const sessions = new Map<string, StoredSession>();

  function newSession() {
    return createApiSession(url => {
      if (!allowedSites.has(normalizedSite(url))) {
        throw new JiraError('This Jira URL is not allowed by the application administrator.', 403);
      }
    });
  }

  function expireSessions(now: number): void {
    for (const [id, record] of sessions) {
      if (now - record.lastSeen >= idleTimeout) {
        record.session.disconnect();
        sessions.delete(id);
      }
    }
  }

  async function handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      throw new HttpError(405, 'Use POST for this API.');
    }
    const origin = request.headers.origin;
    if (!origin || !origins.has(origin)) throw new HttpError(403, 'This request origin is not allowed.');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      throw new HttpError(415, 'Use application/json.');
    }
    const body = await readBody(request);
    const method = typeof body === 'object' && body !== null && 'method' in body ? body.method : undefined;
    const secure = origin.startsWith('https:');
    const cookie = secure ? '__Host-jira_dag_session' : 'jira_dag_session';
    const now = performance.now();
    expireSessions(now);
    let id = readSessionId(request, cookie);
    let record = id ? sessions.get(id) : undefined;
    const fresh = method === 'connect' && !record;
    if (fresh) {
      if (sessions.size >= maxSessions) throw new HttpError(503, 'Too many active connections.');
      id = randomBytes(32).toString('base64url');
      record = { session: newSession(), lastSeen: now };
      sessions.set(id, record);
    }
    if (record) record.lastSeen = now;
    const result = await (record?.session ?? newSession()).invoke(body);
    if (method === 'disconnect' && result.ok) {
      if (id) sessions.delete(id);
      setSessionCookie(response, cookie, secure);
    } else if (fresh && id) {
      if (result.ok) setSessionCookie(response, cookie, secure, id);
      else sessions.delete(id);
    }
    respond(response, result);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === '/api/rpc') {
        await handleRpc(request, response);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await serveAsset(path, options.rendererDirectory, response, request.method === 'HEAD');
      } else {
        response.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'Method not allowed.');
      }
    } catch (error) {
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 413) response.setHeader('Connection', 'close');
      respond(response, {
        ok: false,
        status,
        error: error instanceof HttpError ? error.message : 'Internal application error.',
      });
    }
  }

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 15_000 }, (request, response) => {
    void handle(request, response);
  });
  const cleanup = setInterval(() => expireSessions(performance.now()), 60_000).unref();
  server.once('close', () => {
    clearInterval(cleanup);
    for (const record of sessions.values()) record.session.disconnect();
    sessions.clear();
  });
  return server;
}

function start(): void {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PORT.');
  const host = process.env.HOST ?? '127.0.0.1';
  createWebServer({
    port,
    rendererDirectory: fileURLToPath(new URL('../../renderer/', import.meta.url)),
    publicOrigin: process.env.WEB_ORIGIN,
    allowedSites: process.env.JIRA_ALLOWED_SITES,
  }).listen(port, host, () => console.log(`Jira DAG is listening on ${host}:${port}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
