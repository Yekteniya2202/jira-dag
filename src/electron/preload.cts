import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jiraDag', {
  invoke: (request: unknown) => ipcRenderer.invoke('jira-dag:invoke', request),
  restoreConnection: () => ipcRenderer.invoke('jira-dag:restore-connection'),
  openIssue: (key: string) => ipcRenderer.invoke('jira-dag:open-issue', key),
});
