import type { ApiMethod, ApiMethods, ApiRequest, ApiResponse, JiraIssue } from '../shared/contracts';

declare global {
  interface Window {
    jiraDag?: {
      invoke(request: ApiRequest): Promise<ApiResponse>;
      openIssue(key: string): Promise<void>;
    };
  }
}

export class RequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class IssueCreationUnconfirmed extends Error {}

export async function request<M extends ApiMethod>(
  method: M, input: ApiMethods[M]['input'],
): Promise<ApiMethods[M]['output']> {
  const payload = { method, input } as ApiRequest;
  const response = window.jiraDag
    ? await window.jiraDag.invoke(payload)
    : await fetch('/api/rpc', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (result) => {
        if (!result.headers.get('Content-Type')?.includes('application/json')) {
          throw new RequestError('Сервер Jira DAG недоступен.', result.status);
        }
        return await result.json() as ApiResponse;
      });
  if (!response.ok) throw new RequestError(response.error, response.status);
  return response.data as ApiMethods[M]['output'];
}

export async function openIssue(issue: JiraIssue): Promise<void> {
  if (window.jiraDag) {
    await window.jiraDag.openIssue(issue.key);
    return;
  }
  const url = new URL(issue.url);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос.';
}
