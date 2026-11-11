import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { UpdateProgress } from '../shared/updates.js';

contextBridge.exposeInMainWorld('jiraDag', {
  invoke: (request: unknown) => ipcRenderer.invoke('jira-dag:invoke', request),
  restoreConnection: () => ipcRenderer.invoke('jira-dag:restore-connection'),
  openIssue: (key: string) => ipcRenderer.invoke('jira-dag:open-issue', key),
  checkForUpdate: () => ipcRenderer.invoke('jira-dag:check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('jira-dag:download-update'),
  installUpdate: () => ipcRenderer.invoke('jira-dag:install-update'),
  onUpdateProgress: (listener: (progress: UpdateProgress) => void) => {
    const receive = (_event: IpcRendererEvent, progress: UpdateProgress) => listener(progress);
    ipcRenderer.on('jira-dag:update-progress', receive);
    return () => { ipcRenderer.removeListener('jira-dag:update-progress', receive); };
  },
});
