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
  JiraGraphNote,
  JiraIssue,
  JiraIssueInput,
  JiraIssueSuggestion,
  JiraLinkInput,
  JiraLinkType,
  JiraOption,
  JiraProject,
  JiraProjectFilterOptions,
  JiraSavedFilter,
  JiraSprint,
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
export const MAX_GRAPH_ISSUES = 1_500;
const MAX_SEARCH_ISSUES = 1_000;
const MAX_NEIGHBORS = 400;
const TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 128 * 1024;
const AVATAR_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const NOTE_MARKER = 'Jira DAG note v1';
const ISSUE_KEY = /^[a-z][a-z\d_]*-\d+$/i;
export const MAX_NOTE_LENGTH = 8_000;
const ISSUE_FIELDS = [
  'summary', 'description', 'status', 'issuetype', 'assignee', 'project', 'issuelinks', 'parent', 'subtasks',
  'labels', 'priority', 'fixVersions', 'duedate', 'timeoriginalestimate', 'timeestimate',
];
const RESERVED_FIELDS = new Set(['key', 'id', 'project', 'issuetype', 'summary', 'description', 'issuelinks', 'reporter']);
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
  const profileId = edition === 'cloud' ? string(profile.accountId) : string(profile.key) ?? string(profile.name);
  return { connection: { url: site.href.replace(/\/$/, ''), displayName, ...(profileId ? { profileId } : {}) }, client };
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
  private readonly agileBase: string;
  private readonly knownStoryFields = new Set<string>();
  private readonly knownHierarchyFields = new Set<string>();
  private readonly knownEpicFields = new Set<string>();
  private readonly knownSprintFields = new Set<string>();
  private readonly knownSprints = new Map<string, JiraSprint>();
  private readonly adfFieldIds = new Set(['environment']);
  private readonly editableReporter = new Set<string>();
  private currentReporter?: { id: string } | { name: string } | { key: string };

  constructor(
    private readonly site: URL,
    private readonly apiSite: URL,
    private readonly edition: JiraEdition,
    private readonly authorization: string,
    private readonly token: string,
  ) {
    this.apiBase = `${apiSite.href.replace(/\/$/, '')}/rest/api/${edition === 'cloud' ? 3 : 2}`;
    this.agileBase = `${apiSite.href.replace(/\/$/, '')}/rest/agile/1.0`;
  }

  async profile(): Promise<JsonObject> {
    const profile = record(await this.call('GET', '/myself'));
    if (!string(profile.accountId) && !string(profile.key) && !string(profile.name) && !string(profile.displayName)) {
      throw new JiraError('Jira не вернула профиль пользователя. Проверь адрес и токен.', 401);
    }
    const accountId = string(profile.accountId);
    const name = string(profile.name);
    const key = string(profile.key);
    this.currentReporter = this.edition === 'cloud'
      ? (accountId ? { id: accountId } : undefined)
      : (name ? { name } : key ? { key } : undefined);
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
    const epicFields = fields.filter(isEpicLinkField).flatMap(fieldOption).map((field) => field.id);
    const sprintFields = Array.isArray(fieldCatalog)
      ? fields.filter(isSprintField).flatMap(fieldOption).map((field) => field.id)
      : [...this.knownSprintFields];
    for (const field of hierarchyFields) this.knownHierarchyFields.add(field);
    for (const field of epicFields) this.knownEpicFields.add(field);
    for (const field of sprintFields) this.knownSprintFields.add(field);
    const requestedFields = [...new Set([...ISSUE_FIELDS, ...storyFields, ...hierarchyFields, ...sprintFields])];
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
          if (depth === query.depth) return false;
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

    const graphEdges = [...edges.values()];
    const graphIssues = [...issues.values()].map((issue) =>
      this.toIssue(issue, storyFields, !roots.has(issue.key), !hydrated.has(issue.key)));
    addIssueHierarchy(graphIssues, graphEdges);
    return {
      issues: graphIssues,
      edges: graphEdges,
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
      return this.rememberCreateOptions(projectKey, issueTypeId, { issueTypes: types.flatMap(option), fields: fields.flatMap(toCreateField) });
    } catch (error) {
      if (this.edition !== 'data-center' || !(error instanceof JiraError) || error.status !== 404) throw error;
      const fallback = await this.legacyCreateOptions(projectKey.trim(), issueTypeId);
      if (!fallback.issueTypes.length) throw error;
      return this.rememberCreateOptions(projectKey, issueTypeId, fallback);
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
    if (this.currentReporter && this.editableReporter.has(createOptionsKey(project, input.typeId)) &&
        await this.canModifyReporter(project)) {
      fields.reporter = this.currentReporter;
    }

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

  async listProjects(): Promise<JiraProject[]> {
    if (this.edition === 'data-center') {
      const result = await this.call('GET', '/project');
      if (!Array.isArray(result)) throw new JiraError('Jira вернула некорректный список проектов.');
      return result.flatMap(toProject);
    }

    const projects = new Map<string, JiraProject>();
    let startAt = 0;
    for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
      const page = record(await this.call('GET', `/project/search?startAt=${startAt}&maxResults=${SEARCH_PAGE_SIZE}`));
      const { values } = page;
      if (!Array.isArray(values) || (page.startAt !== undefined && page.startAt !== startAt)) break;
      for (const project of values.flatMap(toProject)) projects.set(project.id, project);
      startAt += values.length;
      const total = integer(page.total);
      if (!values.length || page.isLast === true || (page.isLast !== false && total !== undefined && startAt >= total)) {
        return [...projects.values()];
      }
    }
    throw new JiraError('Jira вернула слишком много страниц проектов или некорректную пагинацию.');
  }

  async suggestIssues(query: string): Promise<JiraIssueSuggestion[]> {
    const value = query.trim();
    if (value.length < 2) return [];
    const parameters = new URLSearchParams({ query: value, currentJQL: 'ORDER BY updated DESC', showSubTasks: 'true' });
    const response = record(await this.call('GET', `/issue/picker?${parameters}`));
    const suggestions = new Map<string, JiraIssueSuggestion>();
    for (const section of list(response.sections).map(record)) {
      for (const row of list(section.issues).map(record)) {
        const key = string(row.key);
        if (!key || !ISSUE_KEY.test(key) || suggestions.has(key)) continue;
        suggestions.set(key, { key, summary: string(row.summaryText)?.trim() || key });
        if (suggestions.size === 20) return [...suggestions.values()];
      }
    }
    return [...suggestions.values()];
  }

  async getProjectFilterOptions(project: string): Promise<JiraProjectFilterOptions> {
    const path = `/project/${encodeURIComponent(project)}`;
    const [workflows, versions, sprints] = await Promise.allSettled([
      this.call('GET', `${path}/statuses`),
      this.call('GET', `${path}/versions`),
      this.getProjectSprints(project),
    ]);
    if (workflows.status === 'rejected' && versions.status === 'rejected' && sprints.status === 'rejected') {
      throw workflows.reason;
    }

    const unavailable: NonNullable<JiraProjectFilterOptions['unavailable']> = [];
    const issueTypes = workflows.status === 'fulfilled' && Array.isArray(workflows.value) ? workflows.value : undefined;
    const releases = versions.status === 'fulfilled' && Array.isArray(versions.value) ? versions.value : undefined;
    if (!issueTypes) unavailable.push('statuses', 'issueTypes');
    if (!releases) unavailable.push('versions');
    if (sprints.status === 'rejected' || sprints.value.incomplete) unavailable.push('sprints');
    return {
      statuses: uniqueProjectOptions((issueTypes ?? []).flatMap((type) => list(record(type).statuses))),
      issueTypes: uniqueProjectOptions(issueTypes ?? []),
      versions: uniqueProjectOptions(releases ?? []),
      sprints: sprints.status === 'fulfilled' ? sprints.value.values : [],
      ...(unavailable.length ? { unavailable } : {}),
    };
  }

  private async getProjectSprints(project: string): Promise<{ values: JiraSprint[]; incomplete: boolean }> {
    const boards = await this.agileCollection('/board', { projectKeyOrId: project });
    const boardIds = [...new Set(boards.map(record).filter((board) => board.type !== 'kanban')
      .map((board) => numericId(board.id)).filter(isPresent))];
    const sprints = new Map<string, JiraSprint>();
    let incomplete = false;
    for (let index = 0; index < boardIds.length; index += 5) {
      const batch = boardIds.slice(index, index + 5);
      const responses = await Promise.allSettled(batch.map((id) => this.agileCollection(`/board/${id}/sprint`)));
      for (const response of responses) {
        if (response.status === 'rejected') {
          incomplete = true;
          continue;
        }
        for (const { sprint } of response.value.flatMap(toSprint)) {
          if (!sprint) continue;
          sprints.set(sprint.id, mergeSprint(sprint, sprints.get(sprint.id)));
        }
      }
    }
    for (const [id, sprint] of sprints) this.knownSprints.set(id, sprint);
    return { values: [...sprints.values()], incomplete };
  }

  private async agileCollection(path: string, parameters: Record<string, string> = {}): Promise<unknown[]> {
    const url = new URL(`${this.agileBase}${path}`);
    const query = new URLSearchParams({ ...parameters, maxResults: '50' });
    const all: unknown[] = [];
    let startAt = 0;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      query.set('startAt', String(startAt));
      url.search = query.toString();
      const page = record(await request(url, 'GET', this.authorization, this.token));
      const { values } = page;
      if (!Array.isArray(values) || (page.startAt !== undefined && page.startAt !== startAt)) break;
      all.push(...values);
      startAt += values.length;
      const total = integer(page.total);
      if (!values.length || page.isLast === true || (page.isLast !== false && total !== undefined && startAt >= total)) return all;
    }
    throw new JiraError('Jira вернула некорректный список досок или спринтов.');
  }

  async getAssigneeAvatar(key: string): Promise<string | null> {
    const issue = await this.readIssue(key, ['assignee']);
    const urls = record(record(issue.fields?.assignee).avatarUrls);
    const source = string(urls['48x48']) ?? string(urls['32x32']) ?? string(urls['24x24']) ?? string(urls['16x16']);
    if (!source) return null;

    const base = `${this.site.href.replace(/\/$/, '')}/`;
    const url = URL.parse(source, base);
    if (!url || url.username || url.password || url.hash) return null;
    if (url.origin === this.site.origin && url.pathname === new URL('secure/useravatar', base).pathname) {
      const authorization = this.apiSite.origin === this.site.origin ? this.authorization : undefined;
      return fetchAvatar(url, authorization);
    }
    if (this.edition === 'cloud' && url.protocol === 'https:' && !url.port &&
        /^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/.test(url.hostname)) {
      return fetchAvatar(url);
    }
    return null;
  }

  async listSavedFilters(): Promise<JiraSavedFilter[]> {
    return list(await this.call('GET', '/filter/favourite')).flatMap((value) => {
      const filter = record(value);
      const id = numericId(filter.id);
      const name = string(filter.name)?.trim();
      const jql = string(filter.jql)?.trim();
      return id && name ? [{ id, name, jql: jql || undefined }] : [];
    });
  }

  async listGraphNotes(keys: string[]): Promise<Record<string, JiraGraphNote[]>> {
    if (keys.length > MAX_GRAPH_ISSUES || keys.some((key) => !ISSUE_KEY.test(key))) {
      throw new JiraError('Укажи корректные ключи задач Jira для заметок.', 400);
    }
    const uniqueKeys = [...new Set(keys.map((key) => key.toUpperCase()))];
    const matching = new Set<string>();
    for (let index = 0; index < uniqueKeys.length; index += 50) {
      const batch = uniqueKeys.slice(index, index + 50);
      const jql = `key in (${batch.map((key) => JSON.stringify(key)).join(', ')}) AND comment ~ ${JSON.stringify(`"${NOTE_MARKER}"`)}`;
      const { issues } = await this.search(jql, ['summary'], batch.length);
      for (const { key } of issues) if (batch.includes(key)) matching.add(key);
    }
    const notes: Array<[string, JiraGraphNote[]]> = [];
    const issueKeys = [...matching];
    for (let index = 0; index < issueKeys.length; index += 6) {
      const batch = issueKeys.slice(index, index + 6);
      const results = await Promise.all(batch.map(async (key): Promise<[string, JiraGraphNote[]]> => {
        try {
          return [key, await this.listNotes(key)];
        } catch (error) {
          if (error instanceof JiraError && [403, 404].includes(error.status ?? 0)) return [key, []];
          throw error;
        }
      }));
      notes.push(...results.filter(([, result]) => result.length));
    }
    return Object.fromEntries(notes);
  }

  async listNotes(key: string): Promise<JiraGraphNote[]> {
    const path = issueCommentPath(key);
    const notes = new Map<string, JiraGraphNote>();
    let startAt = 0;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = record(await this.call('GET', `${path}?startAt=${startAt}&maxResults=100`));
      const comments = list(page.comments);
      for (const value of comments) {
        const note = toGraphNote(value);
        if (note) notes.set(note.id, note);
      }
      const nextAt = (integer(page.startAt) ?? startAt) + comments.length;
      if (!comments.length || (typeof page.total === 'number' ? nextAt >= page.total : comments.length < 100)) {
        return [...notes.values()];
      }
      if (nextAt <= startAt) break;
      startAt = nextAt;
    }
    throw new JiraError('Jira вернула слишком много страниц комментариев или некорректную пагинацию.');
  }

  async createNote(key: string, text: string): Promise<JiraGraphNote> {
    const body = this.description(`${NOTE_MARKER}\n${normalizeNoteContent(text)}`);
    return this.writeGraphNote('POST', issueCommentPath(key), { body },
      'Jira не подтвердила создание заметки. Обнови заметки перед повторной отправкой.');
  }

  async updateNote(key: string, id: string, text: string): Promise<JiraGraphNote> {
    const content = normalizeNoteContent(text);
    const { path, comment, note } = await this.readGraphNote(key, id);
    if (note.text === content) return note;
    const body = this.description(`${NOTE_MARKER}\n${content}`);
    const visibility = noteVisibility(comment.visibility, this.edition);
    return this.writeGraphNote('PUT', path, { body, ...(visibility ? { visibility } : {}) },
      'Jira не подтвердила изменение заметки. Обнови заметки перед повторной попыткой.', id);
  }

  async deleteNote(key: string, id: string): Promise<void> {
    const { path } = await this.readGraphNote(key, id);
    await this.call('DELETE', path);
  }

  private async readGraphNote(key: string, id: string): Promise<{ path: string; comment: JsonObject; note: JiraGraphNote }> {
    if (!/^\d+$/.test(id)) throw new JiraError('Неверный идентификатор заметки.', 400);
    const path = `${issueCommentPath(key)}/${encodeURIComponent(id)}`;
    const comment = record(await this.call('GET', path));
    const note = toGraphNote(comment);
    if (note?.id !== id) {
      throw new JiraError('Этот комментарий не является заметкой Jira DAG.', 409);
    }
    return { path, comment, note };
  }

  private async writeGraphNote(method: 'POST' | 'PUT', path: string, payload: JsonObject, unconfirmed: string, id?: string): Promise<JiraGraphNote> {
    let comment: unknown;
    try {
      comment = await this.call(method, path, payload);
    } catch (error) {
      if (error instanceof JiraError && error.status && error.status < 500 && error.status !== 408) throw error;
      throw new JiraError(unconfirmed);
    }
    const note = toGraphNote(comment);
    if (!note || (id !== undefined && note.id !== id)) throw new JiraError(unconfirmed);
    return note;
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

  private rememberCreateOptions(projectKey: string, issueTypeId: string | undefined, options: JiraCreateOptions): JiraCreateOptions {
    if (issueTypeId) {
      const key = createOptionsKey(projectKey, issueTypeId);
      if (options.fields.some((field) => field.id === 'reporter')) this.editableReporter.add(key);
      else this.editableReporter.delete(key);
    }
    return options;
  }

  private async canModifyReporter(project: string): Promise<boolean> {
    const query = new URLSearchParams({ projectKey: project });
    if (this.edition === 'cloud') query.set('permissions', 'MODIFY_REPORTER');
    const response = await this.call('GET', `/mypermissions?${query}`).catch(() => undefined);
    return record(record(record(response).permissions).MODIFY_REPORTER).havePermission === true;
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
      const fields = [...new Set([...ISSUE_FIELDS, ...storyFields, ...this.knownHierarchyFields, ...this.knownSprintFields])];
      return this.toIssue(await this.readIssue(key, fields), storyFields);
    } catch {
      return fallback;
    }
  }

  private toIssue(issue: IssueRef, storyFields: string[], external = false, stub = false): JiraIssue {
    const fields = issue.fields ?? {};
    const status = record(fields.status);
    const issueType = record(fields.issuetype);
    const epic = issueType.hierarchyLevel === 1 || ['epic', 'эпик'].includes(string(issueType.name)?.toLowerCase() ?? '');
    const parent = toRef(fields.parent)[0] ??
      [...this.knownHierarchyFields].flatMap((field) => toRef(fields[field]))[0];
    const directEpic = [...this.knownEpicFields].flatMap((field) => toRef(fields[field]))[0];
    const sprintValues = [...new Set([...this.knownSprintFields, 'sprint', 'closedSprints'])].flatMap((field) => {
      const value = fields[field];
      return (Array.isArray(value) ? value : [value]).flatMap(toSprint);
    });
    const sprintDetails = new Map<string, JiraSprint>();
    for (const { sprint } of sprintValues) {
      if (!sprint) continue;
      sprintDetails.set(sprint.id, mergeSprint(sprint, sprintDetails.get(sprint.id) ?? this.knownSprints.get(sprint.id)));
    }
    const storyPoints = storyFields.map((field) => fields[field]).find((value) =>
      typeof value === 'number' && Number.isFinite(value));
    const description = fields.description;
    const richDescription = this.edition === 'cloud' && description != null && !isPlainAdf(description);
    return {
      key: issue.key,
      summary: string(fields.summary) ?? issue.key,
      status: string(status.name) ?? (stub ? 'Вне выборки' : 'Неизвестен'),
      statusCategory: string(record(status.statusCategory).key),
      issueType: string(issueType.name),
      assignee: string(record(fields.assignee).displayName),
      project: string(record(fields.project).key) ?? issue.key.replace(/-\d+$/, ''),
      storyPoints: typeof storyPoints === 'number' ? storyPoints : undefined,
      description: typeof description === 'string' ? description : adfText(description),
      descriptionMarkdown: richDescription ? adfMarkdown(description) : undefined,
      descriptionReadOnly: richDescription ? true : undefined,
      url: this.getIssueUrl(issue.key),
      external,
      labels: [...new Set(list(fields.labels).map(string).filter(isPresent))],
      parentKey: parent?.key,
      epicKey: epic ? issue.key : directEpic?.key,
      isEpic: epic,
      isSubtask: issueType.subtask === true || issueType.hierarchyLevel === -1,
      priority: string(record(fields.priority).name),
      sprints: [...new Set(sprintValues.map(({ name, sprint }) => (sprint && sprintDetails.get(sprint.id)?.name) || name))],
      sprintDetails: sprintDetails.size ? [...sprintDetails.values()] : undefined,
      fixVersions: [...new Set(list(fields.fixVersions).map((version) => string(record(version).name)).filter(isPresent))],
      dueDate: string(fields.duedate),
      originalEstimateSeconds: integer(fields.timeoriginalestimate),
      remainingEstimateSeconds: integer(fields.timeestimate),
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
  return key && ISSUE_KEY.test(key) ? [{ key, fields: record(row.fields) }] : [];
}

function createOptionsKey(project: string, type: string): string {
  return `${project.trim().toUpperCase()}/${type}`;
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

function addIssueHierarchy(issues: JiraIssue[], edges: JiraEdge[]): void {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  for (const edge of edges) {
    if (edge.kind !== 'parent') continue;
    const child = byKey.get(edge.target);
    if (child) child.parentKey ??= edge.source;
  }

  for (const issue of issues) {
    if (!issue.epicKey) continue;
    const epic = byKey.get(issue.epicKey);
    if (epic) {
      epic.isEpic = true;
      epic.epicKey = epic.key;
    }
  }

  const ancestors = new Map<string, string | undefined>();
  for (const issue of issues) {
    if (ancestors.has(issue.key)) {
      issue.epicKey = ancestors.get(issue.key);
      continue;
    }
    const path = new Set<string>();
    let current: JiraIssue | undefined = issue;
    while (current && !current.epicKey && !ancestors.has(current.key) && !path.has(current.key)) {
      path.add(current.key);
      current = current.parentKey ? byKey.get(current.parentKey) : undefined;
    }
    const epicKey = current?.epicKey ?? (current ? ancestors.get(current.key) : undefined);
    for (const key of path) ancestors.set(key, epicKey);
    issue.epicKey = epicKey;
  }
}

function isStoryPointsField(field: JsonObject): boolean {
  const schema = record(field.schema);
  const name = string(field.name)?.trim().toLowerCase();
  return schema.custom === 'com.pyxis.greenhopper.jira:gh-story-points' ||
    ((schema.type === 'number' || schema.type === undefined) && (name === 'story points' || name === 'story point estimate'));
}

function isHierarchyField(field: JsonObject): boolean {
  return isEpicLinkField(field) || string(field.name)?.trim().toLowerCase() === 'parent link';
}

function isEpicLinkField(field: JsonObject): boolean {
  const name = string(field.name)?.trim().toLowerCase();
  const schema = record(field.schema);
  return schema.custom === 'com.pyxis.greenhopper.jira:gh-epic-link' || name === 'epic link';
}

function isSprintField(field: JsonObject): boolean {
  const name = string(field.name)?.trim().toLowerCase();
  const schema = record(field.schema);
  return string(schema.custom)?.endsWith(':gh-sprint') === true || name === 'sprint' || name === 'спринт' ||
    list(field.clauseNames).some((clause) => string(clause)?.toLowerCase() === 'sprint');
}

function toSprint(value: unknown): Array<{ name: string; sprint?: JiraSprint }> {
  const row = record(value);
  let id = numericId(row.id ?? value);
  let name = string(row.name) ?? string(value);
  let state = string(row.state)?.toLowerCase();
  let startDate = string(row.startDate);
  if (typeof value === 'string' && /(?:^|\.)Sprint@[^[]+\[/.test(value)) {
    id = /(?:\[|,)id=(\d+)(?=,|\])/.exec(value)?.[1];
    name = /(?:\[|,)name=(.*?)(?=,(?:goal|startDate|endDate|completeDate|activatedDate|sequence|sprintVersion|autoStartStop|rapidViewId|state|id)=|\]$)/.exec(value)?.[1];
    state = /(?:\[|,)state=(\w+)(?=,|\])/.exec(value)?.[1]?.toLowerCase();
    startDate = /(?:\[|,)startDate=([^,\]]+)/.exec(value)?.[1];
  }
  const label = name?.trim() || id;
  if (!label) return [];
  const status = state === 'future' || state === 'active' || state === 'closed' ? state : undefined;
  const dated = startDate && Number.isFinite(Date.parse(startDate)) ? { startDate } : {};
  return [{ name: label, sprint: id ? { id, name: label, state: status, ...dated } : undefined }];
}

function mergeSprint(sprint: JiraSprint, known?: JiraSprint): JiraSprint {
  const startDate = sprint.startDate ?? known?.startDate;
  return {
    id: sprint.id,
    name: known && sprint.name === sprint.id ? known.name : sprint.name,
    state: sprint.state ?? known?.state,
    ...(startDate ? { startDate } : {}),
  };
}

function issueCommentPath(key: string): string {
  if (!ISSUE_KEY.test(key)) throw new JiraError('Укажи корректный ключ задачи Jira.', 400);
  return `/issue/${encodeURIComponent(key)}/comment`;
}

function normalizeNoteContent(text: string): string {
  const content = text.replaceAll('\r\n', '\n').trim();
  if (!content || content.length > MAX_NOTE_LENGTH) {
    throw new JiraError(`Введи текст заметки длиной до ${MAX_NOTE_LENGTH} символов.`, 400);
  }
  return content;
}

function noteVisibility(value: unknown, edition: JiraEdition): JsonObject | undefined {
  if (value == null) return undefined;
  const row = record(value);
  const type = row.type;
  const restriction = string(row.value);
  const identifier = edition === 'cloud' ? string(row.identifier) : undefined;
  if ((type !== 'group' && type !== 'role') || (!restriction && !identifier)) {
    throw new JiraError('Не удалось проверить видимость заметки в Jira.', 409);
  }
  return { type, ...(restriction ? { value: restriction } : {}), ...(identifier ? { identifier } : {}) };
}

function noteText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const body = value.replace(/\r\n?/g, '\n');
    const breakIndex = body.indexOf('\n');
    if (breakIndex === -1 || body.slice(0, breakIndex) !== NOTE_MARKER) return undefined;
    return body.slice(breakIndex + 1).trim() || undefined;
  }

  const doc = record(value);
  const [first, ...content] = list(doc.content);
  const marker = record(first);
  const textNodes = list(marker.content).map(record);
  if (doc.type !== 'doc' || marker.type !== 'paragraph' ||
      textNodes.length !== 1 || textNodes[0]?.type !== 'text' || textNodes[0]?.text !== NOTE_MARKER) {
    return undefined;
  }
  return adfText({ ...doc, content })?.trim() || undefined;
}

function toGraphNote(value: unknown): JiraGraphNote | undefined {
  const comment = record(value);
  const id = numericId(comment.id);
  const text = noteText(comment.body);
  if (!id || !text) return undefined;
  const author = record(comment.author);
  return {
    id,
    text,
    author: string(author.displayName) ?? string(author.name) ?? 'Jira',
    createdAt: string(comment.created) ?? '',
  };
}

function option(value: unknown): JiraOption[] {
  const row = record(value);
  const id = string(row.id) ?? string(row.value) ?? string(value);
  const name = string(row.name) ?? string(row.value) ?? id;
  return id && name ? [{ id, name }] : [];
}

function uniqueProjectOptions(rows: unknown[]): JiraOption[] {
  const options = new Map<string, JiraOption>();
  for (const value of rows) {
    const row = record(value);
    const id = numericId(row.id);
    const name = string(row.name)?.trim();
    if (id && name) options.set(id, { id, name });
  }
  return [...options.values()];
}

function fieldOption(field: JsonObject): JiraOption[] {
  return /^customfield_\d+$/.test(string(field.id) ?? '') ? option(field) : [];
}

function toCreateField(value: unknown): JiraCreateField[] {
  const row = record(value);
  const id = string(row.fieldId) ?? string(row.key);
  if (!id || id === 'issuelinks') return [];
  const options = id === 'reporter' ? [] : list(row.allowedValues).flatMap(option);
  return [{
    id,
    name: string(row.name) ?? id,
    required: row.required === true,
    hasDefaultValue: id === 'reporter' || row.hasDefaultValue === true,
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

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+.!|<>~=-]/g, '\\$&');
}

function markdownLink(label: string, value: unknown): string {
  const href = string(value);
  const url = href ? URL.parse(href) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return label;
  return `[${label}](<${url.href}>)`;
}

function backtickFence(value: string, minimum: number): string {
  const longest = (value.match(/`+/g) ?? []).reduce((max, ticks) => Math.max(max, ticks.length), 0);
  return '`'.repeat(Math.max(minimum, longest + 1));
}

function adfMarkdown(value: unknown): string | undefined {
  const doc = record(value);
  if (doc.type !== 'doc') return undefined;

  function inline(value: unknown): string {
    const node = record(value);
    const attrs = record(node.attrs);
    switch (node.type) {
      case 'hardBreak': return '  \n';
      case 'mention':
      case 'emoji':
      case 'status': return escapeMarkdown(string(attrs.text) ?? string(attrs.shortName) ?? '');
      case 'inlineCard': return markdownLink(escapeMarkdown(string(attrs.url) ?? ''), attrs.url);
      case 'text': {
        const text = string(node.text) ?? '';
        const marks = list(node.marks).map(record);
        let result = escapeMarkdown(text);
        if (marks.some((mark) => mark.type === 'code')) {
          const fence = backtickFence(text, 1);
          const pad = /^`|`$|^\s.*\s$/s.test(text) ? ' ' : '';
          result = `${fence}${pad}${text}${pad}${fence}`;
        }
        for (const mark of marks) {
          if (mark.type === 'strong') result = `**${result}**`;
          if (mark.type === 'em') result = `_${result}_`;
          if (mark.type === 'strike') result = `~~${result}~~`;
          if (mark.type === 'link') result = markdownLink(result, record(mark.attrs).href);
        }
        return result;
      }
      default: return list(node.content).map(inline).join('');
    }
  }

  function block(value: unknown): string {
    const node = record(value);
    const content = list(node.content);
    const attrs = record(node.attrs);
    switch (node.type) {
      case 'paragraph': return content.map(inline).join('');
      case 'heading': return `${'#'.repeat(Math.min(integer(attrs.level) || 1, 6))} ${content.map(inline).join('')}`;
      case 'rule': return '---';
      case 'blockquote': return content.map(block).join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
      case 'bulletList':
      case 'orderedList': {
        const start = integer(attrs.order) || 1;
        return content.map((item, index) => {
          const prefix = node.type === 'orderedList' ? `${start + index}. ` : '- ';
          const [first = '', ...rest] = block(item).split('\n');
          return [prefix + first, ...rest.map((line) => ' '.repeat(prefix.length) + line)].join('\n');
        }).join('\n');
      }
      case 'codeBlock': {
        const text = content.map((item) => string(record(item).text) ?? '').join('');
        const language = string(attrs.language) ?? '';
        const fence = backtickFence(text, 3);
        return `${fence}${/^[a-z\d_+-]+$/i.test(language) ? language : ''}\n${text}\n${fence}`;
      }
      case 'table': {
        const rows = content.map((row) => list(record(row).content).map((cell) => block(cell).replace(/\s*\n\s*/g, ' ')));
        const columns = rows[0]?.length ?? 0;
        if (!columns) return '';
        const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
        return [line(rows[0]!), line(Array.from({ length: columns }, () => '---')), ...rows.slice(1).map(line)].join('\n');
      }
      default: return content.map(block).filter(Boolean).join('\n\n');
    }
  }

  return block(doc).trim() || undefined;
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

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function numericId(value: unknown): string | undefined {
  if (typeof value === 'string') return /^\d+$/.test(value) ? value : undefined;
  const id = integer(value);
  return id === undefined ? undefined : String(id);
}

function toProject(value: unknown): JiraProject[] {
  const project = record(value);
  const id = numericId(project.id);
  const key = string(project.key);
  const name = string(project.name)?.trim();
  return id && key && /^[A-Z][A-Z0-9_]{0,127}$/.test(key) && name ? [{ id, key, name }] : [];
}

async function fetchAvatar(url: URL, authorization?: string): Promise<string | null> {
  const headers = new Headers({ Accept: [...AVATAR_MEDIA_TYPES].join(', ') });
  if (authorization) headers.set('Authorization', authorization);
  try {
    const response = await fetch(url, {
      method: 'GET', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!response.ok || !mime || !AVATAR_MEDIA_TYPES.has(mime) ||
        Number(response.headers.get('Content-Length')) > MAX_AVATAR_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AVATAR_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const image = Buffer.concat(chunks, size);
    return hasAvatarSignature(image, mime) ? `data:${mime};base64,${image.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function hasAvatarSignature(image: Buffer, mime: string): boolean {
  switch (mime) {
    case 'image/png': return image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    case 'image/jpeg': return image.subarray(0, 3).toString('hex') === 'ffd8ff';
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('latin1'));
    case 'image/webp': return image.subarray(0, 4).toString('latin1') === 'RIFF' &&
      image.subarray(8, 12).toString('latin1') === 'WEBP';
    default: return false;
  }
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
