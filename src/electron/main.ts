import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app, BrowserWindow, ipcMain, net, protocol, session, shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { createApiSession } from '../server/session.js';

const rendererDirectory = resolve(import.meta.dirname, '../../renderer');
const productionUrl = 'jira-dag://app/';
const rendererUrl = !app.isPackaged && process.argv.includes('--dev')
  ? 'http://127.0.0.1:5173/'
  : productionUrl;
const smokeTest = process.argv.includes('--smoke-test');
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{
  scheme: 'jira-dag',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let currentWindow: { browser: BrowserWindow; jira: ReturnType<typeof createApiSession> } | undefined;

async function serveRenderer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'app' || !['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 404 });
  }

  try {
    const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filename = resolve(rendererDirectory, `.${path}`);
    const asset = relative(rendererDirectory, filename);
    if (!asset || asset === '..' || asset.startsWith(`..${sep}`) || isAbsolute(asset)) {
      return new Response(null, { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(filename).href, { method: request.method });
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function getJiraSession(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (currentWindow?.browser.webContents !== event.sender || !frame ||
      frame.parent !== null || frame.url.split('#')[0] !== rendererUrl) {
    throw new Error('Unrecognized Jira DAG window');
  }

  return currentWindow.jira;
}

async function createWindow(): Promise<BrowserWindow> {
  const browser = new BrowserWindow({
    title: 'Jira DAG',
    width: 1440,
    height: 930,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: '#141622',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const jira = createApiSession();
  currentWindow = { browser, jira };

  browser.webContents.on('will-frame-navigate', event => event.preventDefault());
  browser.webContents.on('will-redirect', event => event.preventDefault());
  browser.webContents.on('will-attach-webview', event => event.preventDefault());
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browser.on('closed', () => {
    jira.disconnect();
    if (currentWindow?.browser === browser) currentWindow = undefined;
  });
  if (!smokeTest) browser.once('ready-to-show', () => browser.show());

  await browser.loadURL(rendererUrl);
  return browser;
}

async function verifyRenderer(browser: BrowserWindow): Promise<void> {
  const loaded = await browser.webContents.executeJavaScript(`
    new Promise(resolve => {
      const ready = () => document.getElementById('root')?.firstElementChild &&
        typeof window.jiraDag?.invoke === 'function' && typeof window.jiraDag?.openIssue === 'function';
      if (ready()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (ready()) {
          observer.disconnect();
          resolve(true);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(false); }, 5000);
    })
  `);
  if (!loaded) throw new Error('Jira DAG renderer or preload failed to initialize');
  const responds = await browser.webContents.executeJavaScript(
    'window.jiraDag.invoke(null).then(response => response.ok === false)',
  );
  if (!responds) throw new Error('Jira DAG IPC validation failed');
}

app.whenReady().then(async () => {
  protocol.handle('jira-dag', serveRenderer);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('jira-dag:invoke', (event, request: unknown) => getJiraSession(event).invoke(request));
  ipcMain.handle('jira-dag:open-issue', async (event, key: unknown) => {
    const url = new URL(getJiraSession(event).getIssueUrl(key));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid Jira issue URL');
    }
    await shell.openExternal(url.href);
  });

  const browser = await createWindow();
  if (smokeTest) {
    await verifyRenderer(browser);
    app.exit(0);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(exitOnError);
    }
  });
}).catch(exitOnError);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function exitOnError(error: unknown): void {
  console.error(error);
  app.exit(1);
}
