import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, lstatSync } from 'node:fs';
import { chmod, copyFile, mkdtemp, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import electronUpdater, { type BaseUpdater } from 'electron-updater';
import {
  checkRelease, compareStableVersions, updateReleaseUrl, updateRepository,
} from '../server/update-release.js';
import type {
  AvailableUpdate, UpdateCheckResult, UpdateDownloadResult, UpdateInstallResult, UpdateProgress,
} from '../shared/updates.js';

type NativeTarget = 'nsis' | 'appimage';

interface NativeUpdateDriver {
  target: NativeTarget;
  check(): Promise<{
    available: boolean;
    version: string;
    tag: unknown;
    files: readonly { url: string; sha512: string }[];
  } | null>;
  download(sha512: string, report: (progress: UpdateProgress) => void): Promise<void>;
  install(): Promise<void>;
}

function appImageIsWritable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!lstatSync(path).isFile()) return false;
    accessSync(path, constants.R_OK | constants.X_OK);
    accessSync(dirname(path), constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function replaceAppImage(image: string, downloaded: string, sha512: string): Promise<void> {
  if (!appImageIsWritable(image)) throw new Error('The current AppImage is no longer writable');
  const permissions = lstatSync(image).mode & 0o777;
  const staging = await mkdtemp(join(dirname(image), '.jira-dag-update-'));
  const replacement = join(staging, 'replacement.AppImage');
  try {
    await copyFile(downloaded, replacement, constants.COPYFILE_EXCL);
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(replacement)) hash.update(chunk);
    if (hash.digest('base64') !== sha512) throw new Error('The downloaded AppImage checksum changed');
    await chmod(replacement, permissions);
    await rename(replacement, image);
  } finally {
    await unlink(replacement).catch(() => {});
    await rmdir(staging).catch(() => {});
  }
}

export function createNativeUpdateDriver(
  isPackaged: boolean, restartAppImage: (image: string) => void,
): NativeUpdateDriver | undefined {
  if (!isPackaged || process.arch !== 'x64') return undefined;

  const { APPIMAGE: image, SNAP: snap } = process.env;
  const config = { provider: 'github', ...updateRepository, private: false } as const;
  let target: NativeTarget;
  let updater: BaseUpdater;
  if (process.platform === 'win32') {
    target = 'nsis';
    updater = new electronUpdater.NsisUpdater(config);
  } else if (process.platform === 'linux' && !snap && image && appImageIsWritable(image)) {
    target = 'appimage';
    updater = new electronUpdater.AppImageUpdater(config);
  } else {
    return undefined;
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  let downloaded: { file: string; sha512: string } | undefined;

  return {
    target,
    async check() {
      const result = await updater.checkForUpdates();
      if (!result) return null;
      return {
        available: result.isUpdateAvailable,
        version: result.updateInfo.version,
        tag: 'tag' in result.updateInfo ? result.updateInfo.tag : undefined,
        files: result.updateInfo.files,
      };
    },
    async download(sha512, report) {
      const progress = ({ percent }: UpdateProgress) => report({ percent });
      updater.on('download-progress', progress);
      try {
        const [file] = await updater.downloadUpdate();
        if (!file) throw new Error('No installer was downloaded');
        downloaded = { file, sha512 };
      } finally {
        updater.removeListener('download-progress', progress);
      }
    },
    async install() {
      if (target === 'appimage') {
        if (!image || !downloaded) throw new Error('No AppImage update was downloaded');
        // electron-updater removes the original before moving the replacement.
        await replaceAppImage(image, downloaded.file, downloaded.sha512);
        restartAppImage(image);
        return;
      }
      let failure: Error | undefined;
      const onError = (error: Error) => { failure = error; };
      updater.on('error', onError);
      try {
        updater.quitAndInstall();
        if (failure) throw failure;
      } finally {
        updater.removeListener('error', onError);
      }
    },
  };
}

function expectedInstallerChecksum(
  target: NativeTarget, version: string, files: readonly { url: string; sha512: string }[],
): string | undefined {
  if (!Array.isArray(files) || files.some(file => typeof file?.url !== 'string' || !file.url || /[^\w.-]/.test(file.url))) return;
  const extension = target === 'nsis' ? '.exe' : '.appimage';
  const filename = target === 'nsis'
    ? `jira-dag-${version}-x64-setup.exe`
    : `jira-dag-${version}-x86_64.AppImage`;
  const installers = files.filter(file => typeof file?.url === 'string' && file.url.toLowerCase().endsWith(extension));
  if (installers.length !== 1 || installers[0].url !== filename) return;
  const { sha512 } = installers[0];
  if (typeof sha512 === 'string' && sha512.length === 88 && /^[A-Za-z0-9+/]{86}==$/.test(sha512)) return sha512;
}

export function createDesktopUpdateController({
  currentVersion, native, openExternal, reportProgress, lookupRelease = checkRelease,
}: {
  currentVersion: string;
  native?: NativeUpdateDriver;
  openExternal: (url: string) => Promise<void>;
  reportProgress: (progress: UpdateProgress) => void;
  lookupRelease?: typeof checkRelease;
}) {
  let candidate: AvailableUpdate | undefined;
  let candidateSha512: string | undefined;
  let checking: Promise<UpdateCheckResult> | undefined;
  let downloading: Promise<UpdateDownloadResult> | undefined;
  let installing = false;

  async function findUpdate(): Promise<UpdateCheckResult> {
    if (native) {
      try {
        const result = await native.check();
        if (result) {
          const order = compareStableVersions(result.version, currentVersion);
          if (order !== undefined && order <= 0) return { status: 'current', currentVersion };
          if (order !== 1 || result.tag !== `v${result.version}`) return lookupRelease(currentVersion);
          const sha512 = expectedInstallerChecksum(native.target, result.version, result.files);
          if (!sha512) return lookupRelease(currentVersion);
          if (!result.available) return { status: 'unavailable', currentVersion };
          candidateSha512 = sha512;
          return {
            status: 'available', currentVersion, version: result.version, mode: 'install',
            releaseUrl: updateReleaseUrl(result.version),
          };
        }
      } catch {
        // Older releases can be published without updater metadata.
      }
    }
    return lookupRelease(currentVersion);
  }

  async function openUpdateRelease(version: string): Promise<UpdateDownloadResult> {
    try {
      await openExternal(updateReleaseUrl(version));
      return { status: 'opened' };
    } catch {
      return { status: 'error' };
    }
  }

  async function download(candidate: AvailableUpdate): Promise<UpdateDownloadResult> {
    try {
      if (!native || !candidateSha512) return { status: 'not-available' };
      await native.download(candidateSha512, ({ percent }) => {
        if (Number.isFinite(percent)) reportProgress({ percent: Math.max(0, Math.min(100, percent)) });
      });
      candidate.downloaded = true;
      return { status: 'ready' };
    } catch {
      return { status: 'error' };
    }
  }

  return {
    async checkForUpdate(): Promise<UpdateCheckResult> {
      if (candidate && (candidate.downloaded || downloading)) return candidate;
      if (checking) return checking;
      candidate = undefined;
      candidateSha512 = undefined;
      checking = findUpdate().then(result => {
        if (result.status === 'available') candidate = result;
        return result;
      }).catch((): UpdateCheckResult => ({ status: 'error', currentVersion })).finally(() => { checking = undefined; });
      return checking;
    },
    async downloadUpdate(): Promise<UpdateDownloadResult> {
      if (downloading) return downloading;
      if (!candidate || installing) return { status: 'not-available' };
      if (candidate.downloaded) return { status: 'ready' };
      const request = candidate.mode === 'release' ? openUpdateRelease(candidate.version) : download(candidate);
      downloading = request.finally(() => { downloading = undefined; });
      return downloading;
    },
    async installUpdate(): Promise<UpdateInstallResult> {
      if (!native || !candidate?.downloaded || installing) return { status: 'not-available' };
      installing = true;
      try {
        await native.install();
        return { status: 'installing' };
      } catch {
        installing = false;
        return { status: 'error' };
      }
    },
  };
}
