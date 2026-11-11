import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app, BrowserWindow, ipcMain, net, protocol, safeStorage, session, shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { createDesktopConnection, requireProtectedCiphertext } from './connection.js';
import { createDesktopUpdateController, createNativeUpdateDriver } from './updates.js';

const rendererDirectory = resolve(import.meta.dirname, '../../renderer');
const productionUrl = 'jira-dag://app/';
const rendererUrl = !app.isPackaged && process.argv.includes('--dev')
  ? 'http://127.0.0.1:5173/'
  : productionUrl;
const smokeTest = process.argv.includes('--smoke-test');
const ownsProfile = smokeTest || app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
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

let currentWindow: { browser: BrowserWindow; jira: ReturnType<typeof createDesktopConnection> } | undefined;

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

function getAppWindow(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (currentWindow?.browser.webContents !== event.sender || !frame ||
      frame.parent !== null || frame.url.split('#')[0] !== rendererUrl) {
    throw new Error('Unrecognized Jira DAG window');
  }

  return currentWindow;
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
  const jira = createDesktopConnection(join(app.getPath('userData'), 'jira-dag-data', 'connection.v1.bin'), {
    encrypt: async (value) => requireProtectedCiphertext(await safeStorage.encryptStringAsync(value)),
    decrypt: async (value) => (await safeStorage.decryptStringAsync(requireProtectedCiphertext(value))).result,
  });
  currentWindow = { browser, jira };

  browser.webContents.on('will-frame-navigate', event => event.preventDefault());
  browser.webContents.on('will-redirect', event => event.preventDefault());
  browser.webContents.on('will-attach-webview', event => event.preventDefault());
  browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  browser.on('closed', () => {
    jira.close();
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
        typeof window.jiraDag?.invoke === 'function' && typeof window.jiraDag?.openIssue === 'function' &&
        typeof window.jiraDag?.restoreConnection === 'function' &&
        typeof window.jiraDag?.checkForUpdate === 'function' && typeof window.jiraDag?.onUpdateProgress === 'function';
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
  const displayedVersion = await browser.webContents.executeJavaScript("document.querySelector('.app-version')?.textContent");
  if (displayedVersion !== `v${app.getVersion()}`) throw new Error('The displayed version does not match the Electron package');
  const responds = await browser.webContents.executeJavaScript(
    'Promise.all([window.jiraDag.invoke(null), window.jiraDag.restoreConnection(), window.jiraDag.installUpdate()])' +
      '.then(([invalid, restored, update]) => invalid.ok === false && restored.ok && restored.data === null &&' +
      'update.status === "not-available")',
  );
  if (!responds) throw new Error('Jira DAG IPC validation failed');
}

app.whenReady().then(async () => {
  if (!ownsProfile) return;
  protocol.handle('jira-dag', serveRenderer);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('jira-dag:invoke', (event, request: unknown) => getAppWindow(event).jira.invoke(request));
  ipcMain.handle('jira-dag:restore-connection', (event) => {
    const { jira } = getAppWindow(event);
    return smokeTest ? { ok: true, data: null } : jira.restore();
  });
  ipcMain.handle('jira-dag:open-issue', async (event, key: unknown) => {
    const url = new URL(getAppWindow(event).jira.getIssueUrl(key));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid Jira issue URL');
    }
    await shell.openExternal(url.href);
  });

  const updater = createDesktopUpdateController({
    currentVersion: app.getVersion(),
    native: createNativeUpdateDriver(app.isPackaged && !smokeTest, image => {
      app.relaunch({ execPath: image });
      setImmediate(() => app.quit());
    }),
    openExternal: url => shell.openExternal(url),
    reportProgress: progress => {
      const contents = currentWindow?.browser.webContents;
      if (contents && !contents.isDestroyed()) contents.send('jira-dag:update-progress', progress);
    },
  });
  ipcMain.handle('jira-dag:check-for-update', event => {
    getAppWindow(event);
    return updater.checkForUpdate();
  });
  ipcMain.handle('jira-dag:download-update', event => {
    getAppWindow(event);
    return updater.downloadUpdate();
  });
  ipcMain.handle('jira-dag:install-update', event => {
    getAppWindow(event);
    return updater.installUpdate();
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

app.on('second-instance', () => {
  const browser = currentWindow?.browser;
  if (!browser) return;
  if (browser.isMinimized()) browser.restore();
  browser.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function exitOnError(error: unknown): void {
  console.error(error);
  app.exit(1);
}
