import type { ApiRequest, ApiResponse, JiraCredentials, JiraEdition } from '../shared/contracts.js';
import { connectJira, JiraError, MAX_NOTE_LENGTH, type JiraClient } from './jira.js';

type ValidateSite = (url: URL, edition: JiraEdition) => void;

class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RequestError(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new RequestError(`${name} has an invalid value.`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = text(value, name, 128);
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(result)) {
    throw new RequestError(`${name} has an invalid identifier.`);
  }
  return result;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, name, maxLength, true);
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : identifier(value, name);
}

function validateJson(value: unknown, budget: { remaining: number }, depth: number): void {
  if (--budget.remaining < 0 || depth > 8) throw new RequestError('Too many field values.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string') {
    text(value, 'Field value', 65_536, true);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, budget, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(object(value, 'Field value'))) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new RequestError('Invalid field name.');
    }
    validateJson(item, budget, depth + 1);
  }
}

function customFields(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const fields = object(value, 'Additional fields');
  const entries = Object.keys(fields);
  if (entries.length > 100) throw new RequestError('Too many additional fields.');
  for (const key of entries) {
    identifier(key, 'Jira field');
    if (['project', 'issuetype', 'summary', 'description', 'issuelinks'].includes(key)) {
      throw new RequestError('Enter core issue fields separately.');
    }
  }
  validateJson(fields, { remaining: 1_000 }, 0);
  return fields;
}

export function parseJiraCredentials(value: unknown): JiraCredentials {
  const input = object(value, 'Input');
  const { edition, scopedToken } = input;
  if (edition !== 'cloud' && edition !== 'data-center') {
    throw new RequestError('Select Jira Cloud or Data Center.');
  }
  if (scopedToken !== undefined && typeof scopedToken !== 'boolean') {
    throw new RequestError('Invalid token type.');
  }
  const email = text(input.email, 'Email', 254, edition === 'data-center').trim();
  if (edition === 'cloud' && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new RequestError('Enter the email for your Jira Cloud account.');
  }
  return {
    edition,
    url: text(input.url, 'Jira URL', 2_048).trim(),
    username: text(input.username, 'Username', 256, true).trim(),
    email,
    token: text(input.token, 'Token', 8_192).trim(),
    scopedToken,
  };
}

function parseRequest(value: unknown): ApiRequest {
  const { method, input: raw } = object(value, 'Request');
  if (method === 'disconnect' && raw === null) return { method, input: null };
  if (method === 'listProjects' && raw === null) return { method, input: null };
  if (method === 'listSavedFilters' && raw === null) return { method, input: null };
  const input = object(raw, 'Input');
  switch (method) {
    case 'connect': {
      const { remember } = input;
      if (remember !== undefined && typeof remember !== 'boolean') {
        throw new RequestError('Invalid remember connection option.');
      }
      return { method, input: { ...parseJiraCredentials(input), remember } };
    }
    case 'loadGraph': {
      const { depth } = input;
      if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > 3) {
        throw new RequestError('Link depth must be an integer from 0 to 3.');
      }
      return {
        method,
        input: {
          jql: text(input.jql, 'JQL', 8_192).trim(),
          depth,
          storyPointsField: optionalIdentifier(input.storyPointsField, 'Story points field'),
        },
      };
    }
    case 'getCreateOptions':
      return { method, input: {
        projectKey: identifier(input.projectKey, 'Project'),
        issueTypeId: optionalIdentifier(input.issueTypeId, 'Issue type'),
      } };
    case 'createIssue':
      return { method, input: {
        projectKey: identifier(input.projectKey, 'Project'),
        typeId: identifier(input.typeId, 'Issue type'),
        summary: text(input.summary, 'Summary', 255).trim(),
        description: optionalText(input.description, 'Description', 65_536),
        fields: customFields(input.fields),
      } };
    case 'updateIssue':
      return { method, input: {
        key: identifier(input.key, 'Issue key'),
        summary: text(input.summary, 'Summary', 255).trim(),
        description: optionalText(input.description, 'Description', 65_536),
      } };
    case 'createLink': {
      const source = identifier(input.source, 'Source issue');
      const target = identifier(input.target, 'Target issue');
      if (source.toUpperCase() === target.toUpperCase()) {
        throw new RequestError('Select two different issues.');
      }
      return { method, input: { source, target, typeId: identifier(input.typeId, 'Link type') } };
    }
    case 'deleteLink':
      return { method, input: { id: identifier(input.id, 'Link') } };
    case 'getAssigneeAvatar':
    case 'listNotes':
      return { method, input: { key: identifier(input.key, 'Issue key') } };
    case 'createNote':
      return { method, input: {
        key: identifier(input.key, 'Issue key'),
        text: text(input.text, 'Note', MAX_NOTE_LENGTH).trim(),
      } };
    case 'deleteNote':
      return { method, input: {
        key: identifier(input.key, 'Issue key'),
        id: identifier(input.id, 'Note id'),
      } };
    default:
      throw new RequestError('Unknown action.');
  }
}

export function validateJiraSite(url: URL): void {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RequestError('Use a Jira HTTP(S) base URL without credentials, a query or a fragment.');
  }
}

function failure(error: unknown): ApiResponse {
  if (error instanceof RequestError || error instanceof JiraError) {
    return { ok: false, error: error.message, status: error.status };
  }
  return { ok: false, error: 'The Jira request failed.', status: 500 };
}

type JiraOperation = Exclude<ApiRequest, { method: 'connect' | 'disconnect' }>;

async function execute(client: JiraClient, request: JiraOperation): Promise<unknown> {
  switch (request.method) {
    case 'loadGraph': return client.loadGraph(request.input);
    case 'getCreateOptions': return client.getCreateOptions(request.input.projectKey, request.input.issueTypeId);
    case 'createIssue': return client.createIssue(request.input);
    case 'updateIssue': return client.updateIssue(request.input);
    case 'createLink': return client.createLink(request.input);
    case 'listProjects': return client.listProjects();
    case 'getAssigneeAvatar': return client.getAssigneeAvatar(request.input.key);
    case 'listSavedFilters': return client.listSavedFilters();
    case 'listNotes': return client.listNotes(request.input.key);
    case 'createNote': return client.createNote(request.input.key, request.input.text);
    case 'deleteNote':
      await client.deleteNote(request.input.key, request.input.id);
      return null;
    case 'deleteLink':
      await client.deleteLink(request.input.id);
      return null;
  }
}

export function createApiSession(validateSite: ValidateSite = validateJiraSite) {
  let client: JiraClient | undefined;
  let generation = 0;

  function disconnect(): void {
    generation++;
    client = undefined;
  }

  function connectedClient(): JiraClient {
    if (!client) throw new RequestError('Connect to Jira first.', 401);
    return client;
  }

  async function invoke(value: unknown): Promise<ApiResponse> {
    let request: ApiRequest;
    try {
      request = parseRequest(value);
    } catch (error) {
      return failure(error);
    }
    if (request.method === 'disconnect') {
      disconnect();
      return { ok: true, data: null };
    }
    if (request.method === 'connect') disconnect();
    const started = generation;
    try {
      if (request.method === 'connect') {
        const result = await connectJira(request.input, validateSite);
        if (started === generation) {
          client = result.client;
          return { ok: true, data: result.connection };
        }
      } else {
        const data = await execute(connectedClient(), request);
        if (started === generation) return { ok: true, data };
      }
    } catch (error) {
      if (started === generation) return failure(error);
    }
    return { ok: false, error: 'The Jira connection changed. Check the current connection before retrying.', status: 409 };
  }

  return {
    invoke,
    disconnect,
    getIssueUrl: (key: unknown) => connectedClient().getIssueUrl(identifier(key, 'Issue key')),
  };
}
