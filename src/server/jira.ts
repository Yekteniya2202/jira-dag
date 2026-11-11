import type {
  ApiMethods,
  GraphQuery,
  JiraConnection,
  JiraCreateField,
  JiraCreateOptions,
  JiraCredentials,
  JiraEdge,
  JiraEdition,
  JiraGraph,
  JiraIssue,
  JiraIssueInput,
  JiraLinkInput,
  JiraLinkType,
  JiraOption,
} from '../shared/contracts.js';

type JsonObject = Record<string, unknown>;
type IssueRef = { key: string; fields?: JsonObject };
type RawLink = {
  id: string;
  type: JiraLinkType;
  inwardIssue?: IssueRef;
  outwardIssue?: IssueRef;
};

const SEARCH_PAGE_SIZE = 100;
const MAX_GRAPH_ISSUES = 1_500;
const MAX_SEARCH_ISSUES = 1_000;
const MAX_NEIGHBORS = 400;
const TIMEOUT_MS = 15_000;
const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'issuetype', 'assignee', 'project', 'issuelinks', 'parent', 'subtasks',
];
const RESERVED_FIELDS = new Set(['key', 'id', 'project', 'issuetype', 'summary', 'description', 'issuelinks']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class JiraError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'JiraError';
  }
}

export async function connectJira(
  credentials: JiraCredentials,
  validateSite: (url: URL, edition: JiraEdition) => void,
): Promise<{ connection: JiraConnection; client: JiraClient }> {
  const site = parseSite(credentials.url);
  const { edition } = credentials;
  validateSite(site, edition);
  const email = credentials.email.trim();
  const token = credentials.token.trim();
  if (!token || (edition === 'cloud' && (!email || email.includes(':')))) {
    throw new JiraError('Укажи API-токен и, для Jira Cloud, email учётной записи Atlassian.', 400);
  }

  const apiSite = edition === 'cloud' && credentials.scopedToken ? await scopedCloudSite(site) : site;
  const authorization = edition === 'cloud'
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  const client = new JiraClient(site, apiSite, edition, authorization, token);
  const profile = await client.profile();
  const displayName = string(profile.displayName) ?? string(profile.name) ?? credentials.username.trim();
  return { connection: { url: site.href.replace(/\/$/, ''), displayName }, client };
}

function parseSite(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new JiraError('Укажи полный адрес Jira.', 400);
  }
  const localHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new JiraError('Укажи HTTPS-адрес Jira без учётных данных, параметров и фрагмента.', 400);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

async function scopedCloudSite(site: URL): Promise<URL> {
  if (!/^[a-z0-9-]+\.atlassian\.net$/.test(site.hostname) || site.port || site.pathname !== '/') {
    throw new JiraError('Для Cloud-токена с правами доступа укажи исходный адрес https://<site>.atlassian.net.', 400);
  }
  const result = record(await request(new URL('/_edge/tenant_info', site), 'GET'));
  const cloudId = string(result.cloudId);
  if (!cloudId || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(cloudId)) {
    throw new JiraError('Jira не вернула корректный Cloud ID сайта.');
  }
  return new URL(`https://api.atlassian.com/ex/jira/${cloudId}`);
}

export class JiraClient {
  private readonly apiBase: string;
  private readonly knownStoryFields = new Set<string>();
  private readonly adfFieldIds = new Set(['environment']);

  constructor(
    private readonly site: URL,
    apiSite: URL,
    private readonly edition: JiraEdition,
    private readonly authorization: string,
    private readonly token: string,
  ) {
    this.apiBase = `${apiSite.href.replace(/\/$/, '')}/rest/api/${edition === 'cloud' ? 3 : 2}`;
  }

  async profile(): Promise<JsonObject> {
    const profile = record(await this.call('GET', '/myself'));
    if (!string(profile.accountId) && !string(profile.key) && !string(profile.name) && !string(profile.displayName)) {
      throw new JiraError('Jira не вернула профиль пользователя. Проверь адрес и токен.', 401);
    }
    return profile;
  }

  getIssueUrl(key: string): string {
    return `${this.site.href.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}`;
  }

  async loadGraph(query: GraphQuery): Promise<JiraGraph> {
    const jql = query.jql.trim();
    if (!jql || !Number.isInteger(query.depth) || query.depth < 0 || query.depth > 3) {
      throw new JiraError('Введи JQL и выбери глубину связей от 0 до 3.', 400);
    }

    const warnings = new Set<string>();
    const [fieldCatalog, configuredLinkTypes] = await Promise.all([
      this.optional('GET', '/field', 'Настройки полей Jira недоступны.', warnings),
      this.optional('GET', '/issueLinkType', 'Настройки типов связей Jira недоступны.', warnings),
    ]);
    const fields = list(fieldCatalog).map(record);
    const storyPointsFields = fields.filter(isStoryPointsField).flatMap(fieldOption);
    const selectedStoryPoints = query.storyPointsField?.trim();
    if (selectedStoryPoints && !/^customfield_\d+$/.test(selectedStoryPoints)) {
      throw new JiraError('Выбери корректное поле Story Points.', 400);
    }
    const storyFields = selectedStoryPoints ? [selectedStoryPoints] : storyPointsFields.map((field) => field.id);
    for (const field of storyFields) this.knownStoryFields.add(field);
    const hierarchyFields = fields.filter(isHierarchyField).flatMap(fieldOption).map((field) => field.id);
    const requestedFields = [...new Set([...ISSUE_FIELDS, ...storyFields, ...hierarchyFields])];
    const initial = await this.search(jql, requestedFields, MAX_SEARCH_ISSUES);
    if (initial.truncated) warnings.add(`Показаны первые ${MAX_SEARCH_ISSUES} задач. Уточни JQL для полной выборки.`);

    const roots = new Set(initial.issues.map((issue) => issue.key));
    const visited = new Set(roots);
    const hydrated = new Set(roots);
    const issues = new Map(initial.issues.map((issue) => [issue.key, issue]));
    const edges = new Map<string, JiraEdge>();
    const linkTypes = new Map<string, JiraLinkType>();
    for (const type of list(record(configuredLinkTypes).issueLinkTypes).flatMap(toLinkType)) {
      linkTypes.set(type.id, type);
    }

    let frontier = initial.issues;
    let remainingNeighbors = MAX_NEIGHBORS;
    for (let depth = 0; depth <= query.depth; depth += 1) {
      const neighbors = new Set<string>();
      const remember = (ref: IssueRef) => {
        if (!issues.has(ref.key)) {
          if (issues.size >= MAX_GRAPH_ISSUES) {
            warnings.add(`Граф ограничен ${MAX_GRAPH_ISSUES} задачами.`);
            return false;
          }
          issues.set(ref.key, ref);
        }
        if (!visited.has(ref.key)) neighbors.add(ref.key);
        return true;
      };

      for (const issue of frontier) {
        for (const link of list(issue.fields?.issuelinks).flatMap(toRawLink)) {
          const other = link.outwardIssue ?? link.inwardIssue;
          if (!other || !remember(other)) continue;
          linkTypes.set(link.type.id, link.type);
          edges.set(link.id, toEdge(issue.key, other.key, link));
        }
        for (const parent of [issue.fields?.parent, ...hierarchyFields.map((field) => issue.fields?.[field])].flatMap(toRef)) {
          if (remember(parent)) addParent(edges, parent.key, issue.key);
        }
        for (const child of list(issue.fields?.subtasks).flatMap(toRef)) {
          if (remember(child)) addParent(edges, issue.key, child.key);
        }
      }

      if (depth === query.depth || !neighbors.size) break;
      const keys = [...neighbors].slice(0, remainingNeighbors);
      if (keys.length < neighbors.size) warnings.add(`Догрузка ограничена ${MAX_NEIGHBORS} связанными задачами.`);
      if (!keys.length) break;
      remainingNeighbors -= keys.length;
      keys.forEach((key) => visited.add(key));
      frontier = [];
      for (let index = 0; index < keys.length; index += 50) {
        const batch = keys.slice(index, index + 50);
        const result = await this.search(`key in (${batch.map((key) => JSON.stringify(key)).join(', ')})`, requestedFields, batch.length)
          .catch((error: unknown) => {
            if (error instanceof JiraError && [400, 403, 404].includes(error.status ?? 0)) return { issues: [] };
            throw error;
          });
        for (const issue of result.issues) {
          if (!issues.has(issue.key)) continue;
          issues.set(issue.key, issue);
          hydrated.add(issue.key);
          frontier.push(issue);
        }
      }
      if (frontier.length < keys.length) warnings.add('Часть связанных задач недоступна для этой учётной записи.');
    }

    return {
      issues: [...issues.values()].map((issue) => this.toIssue(issue, storyFields, !roots.has(issue.key), !hydrated.has(issue.key))),
      edges: [...edges.values()],
      linkTypes: [...linkTypes.values()],
      storyPointsFields,
      warnings: [...warnings],
    };
  }

  async getCreateOptions(projectKey: string, issueTypeId?: string): Promise<JiraCreateOptions> {
    if (!projectKey.trim()) throw new JiraError('Укажи ключ проекта Jira.', 400);
    const base = `/issue/createmeta/${encodeURIComponent(projectKey.trim())}/issuetypes`;
    try {
      const types = await this.metadata(base, 'issueTypes');
      const fields = issueTypeId ? await this.metadata(`${base}/${encodeURIComponent(issueTypeId)}`, 'fields') : [];
      for (const field of fields.map(record)) {
        const id = string(field.fieldId) ?? string(field.key);
        if (id && record(field.schema).custom === 'com.atlassian.jira.plugin.system.customfieldtypes:textarea') {
          this.adfFieldIds.add(id);
        }
      }
      return { issueTypes: types.flatMap(option), fields: fields.flatMap(toCreateField) };
    } catch (error) {
      if (this.edition !== 'data-center' || !(error instanceof JiraError) || error.status !== 404) throw error;
      const fallback = await this.legacyCreateOptions(projectKey.trim(), issueTypeId);
      if (!fallback.issueTypes.length) throw error;
      return fallback;
    }
  }

  async createIssue(input: JiraIssueInput): Promise<JiraIssue> {
    const summary = input.summary.trim();
    const project = input.projectKey.trim();
    if (!summary || !project || !input.typeId.trim()) {
      throw new JiraError('Укажи название, ключ проекта и тип задачи.', 400);
    }
    const fields = Object.fromEntries(Object.entries(input.fields ?? {}).filter(([key]) => !RESERVED_FIELDS.has(key)));
    if (this.edition === 'cloud') {
      for (const id of this.adfFieldIds) {
        if (typeof fields[id] === 'string') fields[id] = this.description(fields[id]);
      }
    }
    fields.project = { key: project };
    fields.issuetype = { id: input.typeId };
    fields.summary = summary;
    if (input.description !== undefined) fields.description = this.description(input.description);

    let created: JsonObject;
    try {
      created = record(await this.call('POST', '/issue', { fields }));
    } catch (error) {
      if (error instanceof JiraError && error.status && error.status < 500) throw error;
      throw new JiraError('Jira не подтвердила создание. Проверь, появилась ли задача, прежде чем повторять запрос.');
    }
    const key = string(created.key);
    if (!key) throw new JiraError('Jira не вернула ключ задачи. Проверь, появилась ли она, прежде чем повторять запрос.');
    return this.readIssueOrFallback(key, { key, summary, status: 'Неизвестен', project, description: input.description, url: this.getIssueUrl(key) });
  }

  async updateIssue(input: ApiMethods['updateIssue']['input']): Promise<JiraIssue> {
    const summary = input.summary.trim();
    if (!summary) throw new JiraError('Укажи название задачи.', 400);
    const fields: JsonObject = { summary };
    if (input.description !== undefined) {
      const current = await this.readIssue(input.key, ['description']);
      const previous = current.fields?.description;
      const previousText = typeof previous === 'string' ? previous : (adfText(previous) ?? '');
      if (input.description.replaceAll('\r\n', '\n') !== previousText.replaceAll('\r\n', '\n')) {
        if (this.edition === 'cloud' && previous != null && !isPlainAdf(previous)) {
          throw new JiraError('Описание содержит форматирование. Отредактируй его в Jira, чтобы сохранить разметку и вложения.', 409);
        }
        fields.description = this.description(input.description);
      }
    }
    await this.call('PUT', `/issue/${encodeURIComponent(input.key)}`, { fields });
    return this.readIssueOrFallback(input.key, {
      key: input.key, summary, status: 'Неизвестен', description: input.description, url: this.getIssueUrl(input.key),
    });
  }

  async createLink(input: JiraLinkInput): Promise<JiraEdge | null> {
    if (!input.source || !input.target || !input.typeId || input.source === input.target) {
      throw new JiraError('Выбери две разные задачи и тип связи Jira.', 400);
    }
    await this.call('POST', '/issueLink', {
      type: { id: input.typeId },
      // In the POST payload, Jira calls the source of the outward relation inwardIssue.
      inwardIssue: { key: input.source },
      outwardIssue: { key: input.target },
    });
    try {
      const source = await this.readIssue(input.source, ['issuelinks']);
      const link = list(source.fields?.issuelinks).flatMap(toRawLink).find((candidate) =>
        candidate.type.id === input.typeId && candidate.outwardIssue?.key === input.target);
      return link ? toEdge(input.source, input.target, link) : null;
    } catch {
      return null;
    }
  }

  async deleteLink(id: string): Promise<void> {
    if (!/^\d+$/.test(id)) throw new JiraError('Связь пока без идентификатора Jira. Обнови граф.', 400);
    await this.call('DELETE', `/issueLink/${encodeURIComponent(id)}`);
  }

  private async search(jql: string, fields: string[], limit: number): Promise<{ issues: IssueRef[]; truncated: boolean }> {
    const cloud = this.edition === 'cloud';
    const issues = new Map<string, IssueRef>();
    const tokens = new Set<string>();
    let nextPageToken: string | undefined;
    let startAt = 0;
    let hasMore = true;
    let pageCount = 0;
    while (hasMore && issues.size < limit) {
      if (pageCount++ >= 100) throw new JiraError('Jira вернула слишком много страниц. Уточни JQL.');
      const pagination = cloud ? { nextPageToken } : { startAt };
      const page = record(await this.call('POST', cloud ? '/search/jql' : '/search', {
        jql, fields, maxResults: Math.min(SEARCH_PAGE_SIZE, limit - issues.size), ...pagination,
      }));
      const returned = list(page.issues);
      for (const issue of returned.flatMap(toRef)) {
        if (issues.size >= limit && !issues.has(issue.key)) return { issues: [...issues.values()], truncated: true };
        issues.set(issue.key, issue);
      }

      if (cloud) {
        nextPageToken = string(page.nextPageToken);
        hasMore = page.isLast !== true && Boolean(nextPageToken);
        if (hasMore && nextPageToken) {
          if (tokens.has(nextPageToken)) throw new JiraError('Jira вернула страницу повторно. Уточни JQL.');
          tokens.add(nextPageToken);
        }
      } else {
        startAt += returned.length;
        hasMore = returned.length > 0 && typeof page.total === 'number' && startAt < page.total;
      }
    }
    return { issues: [...issues.values()], truncated: hasMore };
  }

  private async metadata(path: string, cloudKey: string): Promise<unknown[]> {
    const all: unknown[] = [];
    let startAt = 0;
    while (true) {
      const page = record(await this.call('GET', `${path}?startAt=${startAt}&maxResults=50`));
      const values = list(page[cloudKey] ?? page.values);
      all.push(...values);
      startAt += values.length;
      if (!values.length || page.isLast === true || typeof page.total !== 'number' || startAt >= page.total) return all;
    }
  }

  private async legacyCreateOptions(projectKey: string, issueTypeId?: string): Promise<JiraCreateOptions> {
    const query = new URLSearchParams({ projectKeys: projectKey, expand: 'projects.issuetypes.fields' });
    const result = record(await this.call('GET', `/issue/createmeta?${query}`));
    const project = list(result.projects).map(record).find((item) => item.key === projectKey);
    const types = list(project?.issuetypes).map(record);
    const selected = types.find((type) => type.id === issueTypeId);
    const fields = Object.entries(record(selected?.fields)).flatMap(([key, value]) => toCreateField({ ...record(value), key }));
    return { issueTypes: types.flatMap(option), fields };
  }

  private async readIssue(key: string, fields = ISSUE_FIELDS): Promise<IssueRef> {
    const query = new URLSearchParams({ fields: fields.join(',') });
    const issue = toRef(await this.call('GET', `/issue/${encodeURIComponent(key)}?${query}`))[0];
    if (!issue) throw new JiraError('Jira не вернула данные задачи.');
    return issue;
  }

  private async readIssueOrFallback(key: string, fallback: JiraIssue): Promise<JiraIssue> {
    try {
      const storyFields = [...this.knownStoryFields];
      return this.toIssue(await this.readIssue(key, [...ISSUE_FIELDS, ...storyFields]), storyFields);
    } catch {
      return fallback;
    }
  }

  private toIssue(issue: IssueRef, storyFields: string[], external = false, stub = false): JiraIssue {
    const fields = issue.fields ?? {};
    const status = record(fields.status);
    const storyPoints = storyFields.map((field) => fields[field]).find((value) =>
      typeof value === 'number' && Number.isFinite(value));
    return {
      key: issue.key,
      summary: string(fields.summary) ?? issue.key,
      status: string(status.name) ?? (stub ? 'Вне выборки' : 'Неизвестен'),
      statusCategory: string(record(status.statusCategory).key),
      issueType: string(record(fields.issuetype).name),
      assignee: string(record(fields.assignee).displayName),
      project: string(record(fields.project).key) ?? issue.key.replace(/-\d+$/, ''),
      storyPoints: typeof storyPoints === 'number' ? storyPoints : undefined,
      description: typeof fields.description === 'string' ? fields.description : adfText(fields.description),
      url: this.getIssueUrl(issue.key),
      external,
    };
  }

  private description(text: string): JsonObject | string | null {
    if (this.edition === 'data-center') return text;
    if (!text) return null;
    return {
      type: 'doc', version: 1,
      content: text.split(/\r?\n/).map((line) => ({
        type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
      })),
    };
  }

  private async optional(method: string, path: string, warning: string, warnings: Set<string>): Promise<unknown> {
    try {
      return await this.call(method, path);
    } catch (error) {
      if (error instanceof JiraError && error.status === 401) throw error;
      warnings.add(warning);
      return undefined;
    }
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    return request(new URL(`${this.apiBase}${path}`), method, this.authorization, this.token, body);
  }
}

function toRef(value: unknown): IssueRef[] {
  const row = record(value);
  const key = string(row.key) ?? string(value);
  return key && /^[a-z][a-z\d_]*-\d+$/i.test(key) ? [{ key, fields: record(row.fields) }] : [];
}

function toLinkType(value: unknown): JiraLinkType[] {
  const row = record(value);
  const id = string(row.id);
  const name = string(row.name);
  return id && name ? [{ id, name, inward: string(row.inward) ?? name, outward: string(row.outward) ?? name }] : [];
}

function toRawLink(value: unknown): RawLink[] {
  const row = record(value);
  const id = string(row.id);
  const type = toLinkType(row.type)[0];
  return id && type ? [{ id, type, inwardIssue: toRef(row.inwardIssue)[0], outwardIssue: toRef(row.outwardIssue)[0] }] : [];
}

function toEdge(current: string, other: string, link: RawLink): JiraEdge {
  // In an issue's issuelinks, the field names identify the other issue's direction from this issue.
  const [source, target] = link.outwardIssue ? [current, other] : [other, current];
  return { id: link.id, source, target, label: link.type.outward, kind: 'link', typeId: link.type.id };
}

function addParent(edges: Map<string, JiraEdge>, parent: string, child: string) {
  const id = `parent:${parent}:${child}`;
  edges.set(id, { id, source: parent, target: child, label: 'Родительская задача', kind: 'parent' });
}

function isStoryPointsField(field: JsonObject): boolean {
  const schema = record(field.schema);
  const name = string(field.name)?.trim().toLowerCase();
  return schema.custom === 'com.pyxis.greenhopper.jira:gh-story-points' ||
    ((schema.type === 'number' || schema.type === undefined) && (name === 'story points' || name === 'story point estimate'));
}

function isHierarchyField(field: JsonObject): boolean {
  const name = string(field.name)?.trim().toLowerCase();
  const schema = record(field.schema);
  return schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link' || name === 'epic link' || name === 'parent link';
}

function option(value: unknown): JiraOption[] {
  const row = record(value);
  const id = string(row.id) ?? string(row.value) ?? string(value);
  const name = string(row.name) ?? string(row.value) ?? id;
  return id && name ? [{ id, name }] : [];
}

function fieldOption(field: JsonObject): JiraOption[] {
  return /^customfield_\d+$/.test(string(field.id) ?? '') ? option(field) : [];
}

function toCreateField(value: unknown): JiraCreateField[] {
  const row = record(value);
  const id = string(row.fieldId) ?? string(row.key);
  if (!id || id === 'issuelinks') return [];
  const options = list(row.allowedValues).flatMap(option);
  return [{
    id,
    name: string(row.name) ?? id,
    required: row.required === true,
    hasDefaultValue: row.hasDefaultValue === true,
    schemaType: string(record(row.schema).type),
    options: options.length ? options : undefined,
  }];
}

function adfText(value: unknown): string | undefined {
  const doc = record(value);
  if (doc.type !== 'doc') return undefined;
  function textFromNode(node: unknown): string {
    const content = record(node);
    if (content.type === 'hardBreak') return '\n';
    const children = list(content.content).map(textFromNode);
    return string(content.text) ?? children.join(content.type === 'doc' ? '\n' : '');
  }
  return textFromNode(doc);
}

function isPlainAdf(value: unknown): boolean {
  if (typeof value === 'string') return true;
  const doc = record(value);
  return doc.type === 'doc' && list(doc.content).map(record).every((paragraph) =>
    paragraph.type === 'paragraph' && !Object.keys(record(paragraph.attrs)).length &&
    list(paragraph.content).map(record).every((text) => text.type === 'text' && !list(text.marks).length),
  );
}

function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

async function request(url: URL, method: string, authorization?: string, token?: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authorization) headers.Authorization = authorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    throw new JiraError('Не удалось подключиться к Jira. Проверь сеть и адрес сайта.');
  }

  let payload: unknown;
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new JiraError('Jira вернула неожиданный ответ. Проверь адрес сайта.');
    }
  }

  if (!response.ok) {
    const data = record(payload);
    const details = [...list(data.errorMessages), ...Object.values(record(data.errors)), data.message]
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
    let message = `Ответ Jira HTTP ${response.status}${details.length ? `: ${details.join('; ')}` : '.'}`;
    for (const secret of [authorization, authorization?.split(' ')[1], token, token && encodeURIComponent(token)]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    throw new JiraError(message.slice(0, 1_200), response.status);
  }
  return payload;
}
