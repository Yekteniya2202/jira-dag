import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('jiraDag', {
  invoke: (request: unknown) => ipcRenderer.invoke('jira-dag:invoke', request),
  openIssue: (key: string) => ipcRenderer.invoke('jira-dag:open-issue', key),
});
