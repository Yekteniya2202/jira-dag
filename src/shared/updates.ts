export type AvailableUpdate = {
  status: 'available';
  currentVersion: string;
  version: string;
  mode: 'install' | 'release';
  releaseUrl: string;
  webArchiveUrl?: string;
  downloaded?: true;
};

export type UpdateCheckResult = AvailableUpdate
  | { status: 'current' | 'unavailable' | 'error'; currentVersion: string };

export type UpdateDownloadResult = { status: 'ready' | 'opened' | 'not-available' | 'error' };
export type UpdateInstallResult = { status: 'installing' | 'not-available' | 'error' };
export type UpdateProgress = { percent: number };

export interface DesktopUpdaterBridge {
  checkForUpdate(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<UpdateDownloadResult>;
  installUpdate(): Promise<UpdateInstallResult>;
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;
}
