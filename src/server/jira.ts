import type {
  ApiMethods,
  GraphQuery,
  JiraAvatarQuery,
  JiraAvatars,
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
  JiraProjectTeam,
  JiraSavedFilter,
  JiraScrumBoard,
  JiraSprint,
  JiraSprintEstimateFields,
  JiraSprintMembershipInput,
  JiraSprintMembershipResult,
  JiraSprintPlan,
  JiraSprintPlanQuery,
  JiraSprintScope,
  JiraSprintVelocity,
  JiraSprintVelocitySample,
  JiraTeamMember,
} from '../shared/contracts.js';
import { isBlockingType } from '../shared/jira-links.js';

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
const MAX_HIERARCHY_LEVELS = 8;
const MAX_SPRINT_ISSUES = 500;
const MAX_BACKLOG_ISSUES = 400;
const MAX_SPRINT_BLOCKERS = 200;
const MAX_SPRINT_CHANGES = 100;
const SPRINT_CHANGE_BATCH = 25;
const VELOCITY_SPRINT_COUNT = 3;
const VELOCITY_ISSUES_PER_SPRINT = 100;
const VELOCITY_HISTORY_LIMIT = 300;
const TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 128 * 1024;
export const MAX_AVATAR_BATCH = 40;
const TEAM_PAGE_SIZE = 100;
const CLOUD_TEAM_SCAN_LIMIT = 1_000;
const AVATAR_SOURCE_LIMIT = MAX_GRAPH_ISSUES * 4;
const MAX_PROJECT_AVATAR_SOURCES = 24;
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
  const profileId = userIdentity(profile, edition);
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
  private readonly softwareBase: string;
  private readonly knownStoryFields = new Set<string>();
  private readonly knownQaFields = new Set<string>();
  private readonly knownHierarchyFields = new Set<string>();
  private readonly knownEpicFields = new Set<string>();
  private readonly knownSprintFields = new Set<string>();
  private readonly knownSprints = new Map<string, JiraSprint>();
  private readonly adfFieldIds = new Set(['environment']);
  private readonly editableReporter = new Set<string>();
  private currentReporter?: { id: string } | { name: string } | { key: string };
  private currentProfileId?: string;
  private profileAvatarSource?: string;
  private readonly issueAvatarSources = new Map<string, string>();
  private readonly projectAvatarSources = new Map<string, Map<string, string>>();
  private readonly pendingAvatars = new Map<string, Promise<string | null>>();
  private applyingSprintMembership = false;

  constructor(
    private readonly site: URL,
    private readonly apiSite: URL,
    private readonly edition: JiraEdition,
    private readonly authorization: string,
    private readonly token: string,
  ) {
    this.apiBase = `${apiSite.href.replace(/\/$/, '')}/rest/api/${edition === 'cloud' ? 3 : 2}`;
    this.agileBase = `${apiSite.href.replace(/\/$/, '')}/rest/agile/1.0`;
    this.softwareBase = `${apiSite.href.replace(/\/$/, '')}/rest/software/1.0`;
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
    this.currentProfileId = userIdentity(profile, this.edition);
    this.profileAvatarSource = avatarSource(profile);
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
    if (query.epicKey && !ISSUE_KEY.test(query.epicKey)) {
      throw new JiraError('Укажи корректный ключ задачи Jira.', 400);
    }

    const warnings = new Set<string>();
    const settings = await this.graphSettings(query, warnings);
    const initial = await this.searchGraphRoots(jql, settings.requestedFields, query.epicKey, settings.epicFields[0]);
    if (query.epicKey) await this.expandEpicSubtasks(initial, settings.requestedFields, warnings);
    if (initial.truncated) warnings.add(`Показаны первые ${MAX_SEARCH_ISSUES} задач. Уточни JQL для полной выборки.`);
    return this.buildGraph(initial.issues, query.depth, settings, warnings);
  }

  private async graphSettings(query: JiraSprintEstimateFields, warnings: Set<string>, board?: JsonObject) {
    const [fieldCatalog, configuredLinkTypes] = await Promise.all([
      this.optional('GET', '/field', 'Настройки полей Jira недоступны.', warnings),
      this.optional('GET', '/issueLinkType', 'Настройки типов связей Jira недоступны.', warnings),
    ]);
    const fields = list(fieldCatalog).map(record);
    const { storyFields, qaFields, storyPointsFields, qaPointsFields } = estimateFields(fields, boardEstimateFields(query, board, fields));
    for (const field of storyFields) this.knownStoryFields.add(field);
    for (const field of qaFields) this.knownQaFields.add(field);
    const hierarchyFields = Array.isArray(fieldCatalog)
      ? fields.filter(isHierarchyField).flatMap(fieldOption).map((field) => field.id)
      : [...this.knownHierarchyFields];
    const epicFields = fields.filter(isEpicLinkField).flatMap(fieldOption).map((field) => field.id);
    const sprintFields = Array.isArray(fieldCatalog)
      ? fields.filter(isSprintField).flatMap(fieldOption).map((field) => field.id)
      : [...this.knownSprintFields];
    for (const field of hierarchyFields) this.knownHierarchyFields.add(field);
    for (const field of epicFields) this.knownEpicFields.add(field);
    for (const field of sprintFields) this.knownSprintFields.add(field);
    const requestedFields = [...new Set([...ISSUE_FIELDS, ...storyFields, ...qaFields, ...hierarchyFields, ...sprintFields])];
    const configuredTypes = list(record(configuredLinkTypes).issueLinkTypes).flatMap(toLinkType);
    return { requestedFields, epicFields, hierarchyFields, storyFields, qaFields, storyPointsFields, qaPointsFields, configuredTypes };
  }

  private async buildGraph(
    initial: IssueRef[], depthLimit: number, settings: Awaited<ReturnType<JiraClient['graphSettings']>>, warnings: Set<string>,
    externalBlockers: IssueRef[] = [],
  ): Promise<JiraGraph> {
    const { requestedFields, hierarchyFields, storyFields, qaFields, storyPointsFields, qaPointsFields, configuredTypes } = settings;
    const roots = new Set(initial.map((issue) => issue.key));
    const issues = new Map([...initial, ...externalBlockers].map((issue) => [issue.key, issue]));
    const visited = new Set(issues.keys());
    const hydrated = new Set(issues.keys());
    const edges = new Map<string, JiraEdge>();
    const linkTypes = new Map(configuredTypes.map((type) => [type.id, type]));
    const unloadedBlockers = new Map<string, Set<string>>();

    let frontier = initial;
    let remainingNeighbors = MAX_NEIGHBORS;
    for (let depth = 0; depth <= depthLimit; depth += 1) {
      const neighbors = new Set<string>();
      const remember = (ref: IssueRef) => {
        if (!issues.has(ref.key)) {
          if (depth === depthLimit) return false;
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
          if (!other) continue;
          if (!remember(other)) {
            const category = record(record(other.fields?.status).statusCategory);
            if (!link.outwardIssue && isBlockingType(link.type) && category.key !== 'done') {
              const keys = unloadedBlockers.get(issue.key) ?? new Set<string>();
              keys.add(other.key);
              unloadedBlockers.set(issue.key, keys);
            }
            continue;
          }
          linkTypes.set(link.type.id, link.type);
          edges.set(link.id, toEdge(issue.key, other.key, link));
        }
        for (const parent of [issue.fields?.parent, ...hierarchyFields.map((field) => issue.fields?.[field])].flatMap(toHierarchyRef)) {
          if (remember(parent)) addParent(edges, parent.key, issue.key);
        }
        for (const child of list(issue.fields?.subtasks).flatMap(toRef)) {
          if (remember(child)) addParent(edges, issue.key, child.key);
        }
      }

      if (depth === depthLimit || !neighbors.size) break;
      const keys = [...neighbors].slice(0, remainingNeighbors);
      if (keys.length < neighbors.size) warnings.add(`Догрузка ограничена ${MAX_NEIGHBORS} связанными задачами.`);
      if (!keys.length) break;
      remainingNeighbors -= keys.length;
      keys.forEach((key) => visited.add(key));
      frontier = [];
      for (let index = 0; index < keys.length; index += 50) {
        const batch = keys.slice(index, index + 50);
        const result = await this.search(issueKeysJql(batch), requestedFields, batch.length)
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

    const hierarchy = await this.loadHierarchyRefs(issues, hydrated, hierarchyFields, warnings);
    const graphEdges = [...edges.values()];
    const graphIssues = [...issues.values()].map((issue) => {
      const data = this.toIssue(hierarchy.get(issue.key) ?? issue, storyFields, !roots.has(issue.key), !hydrated.has(issue.key), qaFields);
      const keys = unloadedBlockers.get(issue.key);
      return keys ? { ...data, unloadedBlockerKeys: [...keys] } : data;
    });
    const outsideHierarchy = [...hierarchy.values()].filter(({ key }) => !issues.has(key)).map((ref) => this.toIssue(ref, []));
    addIssueHierarchy(graphIssues, graphEdges, outsideHierarchy);
    return {
      issues: graphIssues,
      edges: graphEdges,
      linkTypes: [...linkTypes.values()],
      storyPointsFields,
      qaPointsFields,
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

  async listScrumBoards({ project }: { project: string }): Promise<JiraScrumBoard[]> {
    const projectKeyOrId = project.trim().toUpperCase();
    if (!/^(?:[A-Z][A-Z\d_]{0,127}|\d{1,20})$/.test(projectKeyOrId)) {
      throw new JiraError('Укажи ключ проекта Jira.', 400);
    }
    const boards = await this.agileCollection('/board', { projectKeyOrId, type: 'scrum' });
    return uniqueProjectOptions(boards.filter((board) => record(board).type === 'scrum'));
  }

  async listBoardSprints({ boardId }: { boardId: string }): Promise<JiraSprint[]> {
    const id = requireAgileId(boardId);
    return this.boardSprints(id, 'active,future,closed');
  }

  private async boardSprints(boardId: string, state: string): Promise<JiraSprint[]> {
    const rows = await this.agileCollection(`/board/${boardId}/sprint`, { state });
    const sprints = new Map<string, JiraSprint>();
    for (const { sprint } of rows.flatMap(toSprint)) {
      if (!sprint?.state) continue;
      this.knownSprints.set(sprint.id, mergeSprint(sprint, this.knownSprints.get(sprint.id)));
      sprints.set(sprint.id, sprint);
    }
    return [...sprints.values()];
  }

  private async readBoardSprint({ boardId, sprintId }: JiraSprintScope, state = 'active,future,closed'): Promise<JiraSprint> {
    const visible = (await this.boardSprints(boardId, state)).find((sprint) => sprint.id === sprintId);
    if (!visible) throw new JiraError('Спринт недоступен на выбранной доске Jira.', 404);
    return visible;
  }

  async loadSprintPlan(query: JiraSprintPlanQuery): Promise<JiraSprintPlan> {
    const scope = sprintScope(query);
    const backlogJql = query.backlogJql?.trim();
    if (backlogJql && backlogJql.length > 4_000) throw new JiraError('Сократи JQL для бэклога до 4000 символов.', 400);
    const warnings = new Set<string>();
    const [sprint, board] = await Promise.all([this.readBoardSprint(scope), this.boardConfiguration(scope.boardId, warnings)]);
    const settings = await this.graphSettings(query, warnings, board);
    const fields = [...settings.requestedFields, 'sprint', 'closedSprints'];
    const [members, backlog] = await Promise.all([
      this.agileIssues(`/sprint/${scope.sprintId}/issue`, fields, MAX_SPRINT_ISSUES),
      this.agileIssues(`/board/${scope.boardId}/backlog`, fields, MAX_BACKLOG_ISSUES, backlogJql),
    ]);
    if (!members.complete) warnings.add(`Состав спринта неполный. Предел выборки — ${MAX_SPRINT_ISSUES} задач.`);
    if (!backlog.complete) warnings.add(`Бэклог ограничен ${MAX_BACKLOG_ISSUES} задачами. Уточни запрос или найди задачу по ключу.`);
    const membersByKey = new Set(members.issues.map((issue) => issue.key));
    const candidates = backlog.issues.filter((issue) => !membersByKey.has(issue.key));
    const roots = [...members.issues, ...candidates];
    const blockers = await this.loadSprintBlockers(roots, settings.requestedFields, warnings);
    const graph = await this.buildGraph(roots, 0, settings, warnings, blockers);
    return {
      sprint, graph,
      sprintIssueKeys: [...membersByKey], backlogIssueKeys: candidates.map((issue) => issue.key),
      membershipComplete: members.complete, backlogComplete: backlog.complete,
      ...(settings.storyFields.length === 1 ? { storyPointsField: settings.storyFields[0] } : {}),
      ...(settings.qaFields.length === 1 ? { qaPointsField: settings.qaFields[0] } : {}),
    };
  }

  private async loadSprintBlockers(roots: IssueRef[], fields: string[], warnings: Set<string>): Promise<IssueRef[]> {
    const rootKeys = new Set(roots.map((issue) => issue.key));
    const blockerKeys = new Set<string>();
    for (const issue of roots) {
      for (const link of list(issue.fields?.issuelinks).flatMap(toRawLink)) {
        const blocker = link.inwardIssue;
        const status = record(record(blocker?.fields?.status).statusCategory).key;
        if (blocker && !rootKeys.has(blocker.key) && isBlockingType(link.type) && status !== 'done') blockerKeys.add(blocker.key);
      }
    }
    const keys = [...blockerKeys].slice(0, MAX_SPRINT_BLOCKERS);
    if (keys.length < blockerKeys.size) warnings.add(`Догрузка внешних блокеров ограничена ${MAX_SPRINT_BLOCKERS} задачами.`);
    const warning = 'Часть внешних блокеров недоступна. Их состояние не подтверждено.';
    return this.searchIssueBatches(keys, fields, warning, warnings);
  }

  async applySprintMembership(input: JiraSprintMembershipInput): Promise<JiraSprintMembershipResult> {
    const scope = sprintScope(input);
    const expected = membershipKeys(input.expectedIssueKeys, MAX_SPRINT_ISSUES);
    const add = membershipKeys(input.addIssueKeys, MAX_SPRINT_CHANGES);
    const remove = membershipKeys(input.removeIssueKeys, MAX_SPRINT_CHANGES);
    if (add.length + remove.length > MAX_SPRINT_CHANGES || add.some((key) => expected.includes(key)) ||
      remove.some((key) => !expected.includes(key))) {
      throw new JiraError('Изменения не совпадают с исходным составом спринта или превышают допустимый размер.', 400);
    }
    if (this.applyingSprintMembership) throw new JiraError('Другое изменение спринта ещё выполняется.', 409);
    const result: JiraSprintMembershipResult = { added: [], removed: [], failed: [] };
    if (!add.length && !remove.length) return result;

    this.applyingSprintMembership = true;
    try {
      const sprint = await this.readBoardSprint(scope, 'active,future');
      requireWritableSprint(sprint);
      const members = await this.agileIssues(`/sprint/${scope.sprintId}/issue`, ['summary'], MAX_SPRINT_ISSUES);
      const actual = new Set(members.issues.map((issue) => issue.key));
      if (!members.complete || expected.length !== actual.size || expected.some((key) => !actual.has(key))) {
        throw new JiraError('Состав спринта изменился или загружен не полностью. Обнови план перед применением.', 409);
      }

      for (const [operation, keys] of [['add', add], ['remove', remove]] as const) {
        for (let index = 0; index < keys.length; index += SPRINT_CHANGE_BATCH) {
          const batch = keys.slice(index, index + SPRINT_CHANGE_BATCH);
          await this.applySprintBatch(scope, operation, batch, result);
        }
      }
    } finally {
      this.applyingSprintMembership = false;
    }
    return result;
  }

  private async applySprintBatch(
    scope: JiraSprintScope, operation: 'add' | 'remove', batch: string[], result: JiraSprintMembershipResult,
  ): Promise<void> {
    const fail = (key: string, reason: string) => result.failed.push({ key, operation, reason });
    const adding = operation === 'add';
    const verified: string[] = [];
    try {
      const { sprintId, boardId } = scope;
      const { sprint } = toSprint(await this.agileCall('GET', `/sprint/${sprintId}`))[0] ?? {};
      if (!sprint || sprint.id !== sprintId) throw new JiraError('Jira не подтвердила состояние выбранного спринта.');
      requireWritableSprint(sprint);
      const eligible = adding
        ? await this.agileIssues(`/board/${boardId}/backlog`, ['summary'], batch.length, issueKeysJql(batch))
        : undefined;
      const eligibleKeys = eligible?.complete ? new Set(eligible.issues.map((issue) => issue.key)) : new Set<string>();
      const checks = await Promise.all(batch.map(async (key) => {
        if (adding && !eligibleKeys.has(key)) {
          return 'Задача больше не входит в бэклог выбранной доски.';
        }
        try {
          const openSprints = await this.issueOpenSprints(key);
          if (adding ? openSprints.length !== 0 : openSprints.length !== 1 || openSprints[0] !== sprintId) {
            return 'Открытый спринт задачи изменился. Обнови план.';
          }
          return undefined;
        } catch (error) {
          return jiraFailure(error, 'Не удалось проверить спринт задачи.');
        }
      }));
      batch.forEach((key, index) => {
        const reason = checks[index];
        if (reason) fail(key, reason);
        else verified.push(key);
      });
    } catch (error) {
      for (const key of batch) fail(key, jiraFailure(error, 'Не удалось проверить состав спринта.'));
      return;
    }
    if (!verified.length) return;

    const path = adding ? `/sprint/${scope.sprintId}/issue` : '/backlog/issue';
    let writeError: string | undefined;
    try {
      await this.agileCall('POST', path, { issues: verified });
    } catch (error) {
      writeError = jiraFailure(error, 'Jira не подтвердила изменение.');
    }

    const outcomes = await Promise.all(verified.map(async (key) => {
      try {
        const openSprints = await this.issueOpenSprints(key);
        const matches = adding ? openSprints.length === 1 && openSprints[0] === scope.sprintId : openSprints.length === 0;
        return matches ? undefined : writeError ?? 'Jira ещё не подтвердила новый состав. Обнови план.';
      } catch (error) {
        return writeError ?? jiraFailure(error, 'Jira не подтвердила новый состав. Обнови план.');
      }
    }));
    verified.forEach((key, index) => {
      const reason = outcomes[index];
      if (reason) fail(key, reason);
      else (adding ? result.added : result.removed).push(key);
    });
  }

  private async issueOpenSprints(key: string): Promise<string[]> {
    const fields = new URLSearchParams({ fields: ['sprint', 'closedSprints', 'issuetype', ...this.knownSprintFields].join(',') });
    const response = await this.agileCall('GET', `/issue/${key}?${fields}`);
    const issue = toRef(response)[0];
    if (!issue || issue.key !== key || !issue.fields) throw new JiraError('Jira не подтвердила данные задачи.');
    const type = record(issue.fields.issuetype);
    if (!type.id && !type.name) throw new JiraError('Jira не подтвердила тип задачи.');
    if (isSubtaskType(type)) throw new JiraError('Подзадача наследует спринт родителя. Измени состав через родительскую задачу.', 409);
    const sprintFields = [...new Set(['sprint', ...this.knownSprintFields])].filter((field) => Object.hasOwn(issue.fields!, field));
    if (!sprintFields.length) throw new JiraError('Jira не подтвердила значение поля Sprint.');
    const open = new Set<string>();
    for (const field of sprintFields) {
      const value = issue.fields[field];
      if (value == null) continue;
      for (const row of Array.isArray(value) ? value : [value]) {
        const { sprint } = toSprint(row)[0] ?? {};
        if (!sprint?.state) throw new JiraError('Jira не подтвердила состояние одного из спринтов задачи.');
        if (sprint.state !== 'closed') open.add(sprint.id);
      }
    }
    return [...open];
  }

  async loadSprintVelocity(query: { boardId: string } & JiraSprintEstimateFields): Promise<JiraSprintVelocity> {
    const boardId = requireAgileId(query.boardId);
    const warnings = new Set<string>();
    const [sprints, catalog, configuration] = await Promise.all([
      this.boardSprints(boardId, 'closed'),
      this.optional('GET', '/field', 'Настройки полей Jira недоступны.', warnings),
      this.boardConfiguration(boardId, warnings),
    ]);
    const fields = list(catalog).map(record);
    const board = record(configuration);
    const columns = list(record(board.columnConfig).columns).map((column) => list(record(column).statuses)
      .map((status) => numericId(record(status).id)).filter(isPresent)).filter((statuses) => statuses.length > 0);
    const done = new Set(columns.at(-1));
    const mapped = new Set(columns.flat());
    const estimates = estimateFields(fields, boardEstimateFields(query, board, fields));
    const story = estimates.storyFields.length === 1 ? estimates.storyFields[0] : undefined;
    const qa = estimates.qaFields[0];
    if (!story) warnings.add('Для истории выбери конкретное поле Story Points.');
    if (!done.size) warnings.add('В Jira не найдена завершающая колонка с сопоставленными статусами.');
    const sprintOrder = (sprint: JiraSprint) => Date.parse(sprint.completeDate ?? sprint.endDate ?? sprint.startDate ?? '') || 0;
    const recent = [...sprints].reverse().sort((a, b) => sprintOrder(b) - sprintOrder(a)).slice(0, VELOCITY_SPRINT_COUNT);
    if (recent.length) warnings.add('История использует текущий фильтр доски, текущую колонку Done и задачи, доступные этой учётной записи.');
    const samples: JiraSprintVelocitySample[] = [];
    for (const sprint of recent) {
      if (!sprint.completeDate) {
        warnings.add(`У закрытого спринта «${sprint.name}» нет фактической даты завершения.`);
        samples.push(unavailableVelocitySample(sprint));
        continue;
      }
      try {
        const snapshot = await this.agileIssues(`/board/${boardId}/sprint/${sprint.id}/issue`,
          ['status', 'assignee', 'issuetype', 'created', 'updated', ...[story, qa].filter(isPresent)], VELOCITY_ISSUES_PER_SPRINT);
        const issues = snapshot.issues.filter((issue) => !isSubtaskType(record(issue.fields?.issuetype)));
        const sample = await this.velocitySample(sprint, issues, snapshot.complete, snapshot.total - (snapshot.issues.length - issues.length),
          mapped, done, story, qa, fields);
        if (!sample.complete || sample.storyPointsComplete === false || sample.qaPointsComplete === false || sample.peopleComplete === false) {
          warnings.add(`История спринта «${sprint.name}» неполная. Итоги учитывают только подтверждённые данные.`);
        }
        samples.push(sample);
      } catch (error) {
        if (error instanceof JiraError && error.status === 401) throw error;
        warnings.add(`Не удалось прочитать историю спринта «${sprint.name}».`);
        samples.push(unavailableVelocitySample(sprint));
      }
    }
    return { samples, warnings: [...warnings] };
  }

  private async boardConfiguration(boardId: string, warnings: Set<string>): Promise<JsonObject | undefined> {
    try {
      return record(await this.agileCall('GET', `/board/${boardId}/configuration`));
    } catch (error) {
      if (error instanceof JiraError && error.status === 401) throw error;
      warnings.add('Настройки доски Jira недоступны.');
      return undefined;
    }
  }

  private async velocitySample(
    sprint: JiraSprint, issues: IssueRef[], membershipComplete: boolean, totalIssues: number,
    mapped: Set<string>, done: Set<string>, story: string | undefined, qa: string | undefined, fields: JsonObject[],
  ): Promise<JiraSprintVelocitySample> {
    const cutoff = Date.parse(sprint.completeDate!);
    const people = new Map<string, NonNullable<JiraSprintVelocitySample['people']>[number]>();
    let completedStoryPoints = 0;
    let completedQaPoints = 0;
    let completedIssues = 0;
    let evaluatedIssues = 0;
    let storyCoverage = true;
    let qaCoverage = true;
    let personCoverage = true;
    for (let index = 0; index < issues.length && done.size > 0; index += 5) {
      const states = await Promise.all(issues.slice(index, index + 5).map(async (issue) => {
        const current = issue.fields ?? {};
        const created = Date.parse(string(current.created) ?? '');
        if (!Number.isFinite(created) || created > cutoff || !record(current.issuetype).id) return undefined;
        const updated = Date.parse(string(current.updated) ?? '');
        const histories = updated <= cutoff ? [] : await this.issueHistory(issue.key);
        if (!histories) return undefined;
        return historicalIssue(current, histories, cutoff, story, qa, fields, this.edition);
      }));
      for (const state of states) {
        if (!state?.status || !mapped.has(state.status)) continue;
        evaluatedIssues += 1;
        if (!done.has(state.status)) continue;
        completedIssues += 1;
        if (state.story === undefined) storyCoverage = false;
        if (state.qa === undefined) qaCoverage = false;
        completedStoryPoints += state.story ?? 0;
        completedQaPoints += state.qa ?? 0;
        if (!state.person) {
          if (state.person === undefined) personCoverage = false;
          continue;
        }
        if (state.story === undefined) continue;
        const person = people.get(state.person.id) ?? { ...state.person, storyPoints: 0, completedIssues: 0 };
        person.completedIssues += 1;
        person.storyPoints += state.story;
        people.set(person.id, person);
      }
    }
    const hasEvidence = evaluatedIssues > 0 || (membershipComplete && issues.length === 0 && done.size > 0);
    const complete = membershipComplete && done.size > 0 && evaluatedIssues === totalIssues;
    return {
      sprint, completedIssues, evaluatedIssues, totalIssues,
      ...(story && hasEvidence ? { completedStoryPoints } : {}),
      ...(qa && hasEvidence ? { completedQaPoints } : {}),
      ...(people.size ? { people: [...people.values()] } : {}),
      complete,
      ...(story ? { storyPointsComplete: complete && storyCoverage, peopleComplete: complete && storyCoverage && personCoverage } : {}),
      ...(qa ? { qaPointsComplete: complete && qaCoverage } : {}),
    };
  }

  private async issueHistory(key: string): Promise<unknown[] | undefined> {
    const path = `/issue/${encodeURIComponent(key)}`;
    try {
      if (this.edition === 'data-center') {
        const payload = record(await this.call('GET', `${path}?fields=status&expand=changelog`));
        const changelog = record(payload.changelog);
        return Array.isArray(changelog.histories) && changelog.startAt === 0 &&
          changelog.total === changelog.histories.length && changelog.histories.length <= VELOCITY_HISTORY_LIMIT
          ? changelog.histories : undefined;
      }
      const histories: unknown[] = [];
      for (let pageIndex = 0; pageIndex < 20 && histories.length < VELOCITY_HISTORY_LIMIT; pageIndex += 1) {
        const query = new URLSearchParams({ startAt: String(histories.length), maxResults: '100' });
        const page = record(await this.call('GET', `${path}/changelog?${query}`));
        if (page.startAt !== histories.length || !Array.isArray(page.values)) return undefined;
        histories.push(...page.values);
        const total = integer(page.total);
        if (histories.length > VELOCITY_HISTORY_LIMIT) return undefined;
        if (total !== undefined && histories.length === total && page.isLast !== false) return histories;
        if (!page.values.length || page.isLast === true) return undefined;
      }
      return undefined;
    } catch (error) {
      if (error instanceof JiraError && error.status === 401) throw error;
      return undefined;
    }
  }

  private async agileIssues(path: string, fields: string[], limit: number, jql?: string) {
    const cloud = this.edition === 'cloud';
    const issues = new Map<string, IssueRef>();
    const tokens = new Set<string>();
    let startAt = 0;
    let total = 0;
    let nextPageToken: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const query = new URLSearchParams({ fields: fields.join(','), maxResults: String(Math.min(50, limit - issues.size)) });
      if (jql) query.set('jql', jql);
      if (nextPageToken) query.set('nextPageToken', nextPageToken);
      if (!cloud) query.set('startAt', String(startAt));
      const page = record(await this.agileCall('GET', `${path}?${query}`, undefined, cloud));
      if (!Array.isArray(page.issues) || (!cloud && page.startAt !== undefined && page.startAt !== startAt)) {
        throw new JiraError('Jira вернула некорректную страницу задач спринта или бэклога.');
      }
      for (const row of page.issues) {
        const issue = toRef(row)[0];
        if (!issue || issues.has(issue.key)) throw new JiraError('Состав выборки Jira изменился во время чтения. Обнови план.', 409);
        if (issues.size === limit) return { issues: [...issues.values()], complete: false, total: Math.max(total, limit + 1) };
        issues.set(issue.key, issue);
      }
      startAt += page.issues.length;
      total = integer(page.total) ?? startAt;
      nextPageToken = string(page.nextPageToken);
      const more = cloud ? Boolean(nextPageToken) : startAt < total || page.isLast === false;
      if (!more) return { issues: [...issues.values()], complete: true, total };
      if (issues.size === limit || !page.issues.length) break;
      if (nextPageToken) {
        if (tokens.has(nextPageToken)) throw new JiraError('Jira вернула страницу задач повторно.');
        tokens.add(nextPageToken);
      }
    }
    return { issues: [...issues.values()], complete: false, total: Math.max(total, issues.size + 1) };
  }

  private agileCall(method: string, path: string, body?: unknown, enhanced = false): Promise<unknown> {
    const base = enhanced ? this.softwareBase : this.agileBase;
    return request(new URL(`${base}${path}`), method, this.authorization, this.token, body);
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
    return this.loadAvatar(avatarSource(record(issue.fields?.assignee)));
  }

  async listProjectTeam(project: string, query = ''): Promise<JiraProjectTeam> {
    const projectId = project.trim().toUpperCase();
    const projectKey = /^\d+$/.test(projectId)
      ? toProject(await this.call('GET', `/project/${projectId}`))[0]?.key : projectId;
    if (!projectKey || !/^[A-Z][A-Z0-9_]{0,127}$/.test(projectKey)) {
      throw new JiraError('Укажи ключ проекта Jira.', 400);
    }
    const term = query.trim();
    const cloud = this.edition === 'cloud';
    const path = cloud ? '/user/assignable/multiProjectSearch' : '/user/assignable/search';
    const parameters = new URLSearchParams(cloud
      ? { projectKeys: projectKey, maxResults: String(TEAM_PAGE_SIZE), ...(term ? { query: term } : {}) }
      : { project: projectKey, maxResults: String(TEAM_PAGE_SIZE), username: term });
    const byId = new Map<string, { member: JiraTeamMember; avatar?: string }>();
    const collect = (rows: unknown[], exactId?: string) => {
      for (const row of rows) {
        const user = record(row);
        const id = userIdentity(user, this.edition);
        const name = string(user.displayName)?.trim();
        if (!id || id.length > 320 || !name || user.active === false || user.deleted === true || user.accountType === 'app' ||
            (exactId !== undefined && id !== exactId)) continue;
        byId.set(id, { member: { id, name }, avatar: avatarSource(user) });
      }
    };
    const read = async (params: URLSearchParams) => {
      const response = await this.call('GET', `${path}?${params}`);
      if (!Array.isArray(response)) throw new JiraError('Jira вернула некорректный список исполнителей.');
      return response.slice(0, TEAM_PAGE_SIZE);
    };
    if (cloud) parameters.set('startAt', '0');
    const firstPage = await read(parameters);
    collect(firstPage);
    if (cloud) {
      // Jira paginates the directory before filtering on project, so a page can be empty in the middle of the scan.
      const offsets = Array.from({ length: CLOUD_TEAM_SCAN_LIMIT / TEAM_PAGE_SIZE - 1 }, (_, index) => (index + 1) * TEAM_PAGE_SIZE);
      for (let index = 0; index < offsets.length; index += 3) {
        const pages = await Promise.allSettled(offsets.slice(index, index + 3).map((startAt) => {
          const next = new URLSearchParams(parameters);
          next.set('startAt', String(startAt));
          return read(next);
        }));
        for (const page of pages) if (page.status === 'fulfilled') collect(page.value);
        if (pages.some((page) => page.status === 'rejected')) break;
      }
    }
    const reporter = this.currentReporter;
    const currentId = this.currentProfileId;
    if (!term && currentId && reporter && !byId.has(currentId)) {
      const exact = new URLSearchParams(parameters);
      if ('id' in reporter) exact.set('accountId', reporter.id);
      else if ('name' in reporter) exact.set('username', reporter.name);
      if (exact.toString() !== parameters.toString()) {
        await read(exact).then((rows) => collect(rows, currentId)).catch(() => undefined);
      }
    }
    const sources = this.projectAvatarSources.get(projectId) ?? new Map<string, string>();
    for (const [id, { avatar }] of byId) {
      sources.delete(id);
      if (avatar) sources.set(id, avatar);
    }
    trimMap(sources, CLOUD_TEAM_SCAN_LIMIT + TEAM_PAGE_SIZE);
    this.projectAvatarSources.delete(projectId);
    this.projectAvatarSources.set(projectId, sources);
    trimMap(this.projectAvatarSources, MAX_PROJECT_AVATAR_SOURCES);
    const members = [...byId.values()].map(({ member }) => member)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { members, ...(cloud || firstPage.length >= TEAM_PAGE_SIZE ? { limited: true } : {}) };
  }

  async getAvatars({ issueKeys = [], project, memberIds = [], includeCurrentUser }: JiraAvatarQuery): Promise<JiraAvatars> {
    if (issueKeys.length + memberIds.length > MAX_AVATAR_BATCH || issueKeys.some((key) => !ISSUE_KEY.test(key))) {
      throw new JiraError('Неверный список аватаров Jira.', 400);
    }
    const teamSources = project ? this.projectAvatarSources.get(project.trim().toUpperCase()) : undefined;
    const tasks = [
      ...[...new Set(issueKeys)].map((id) => ({ kind: 'issues' as const, id, source: this.issueAvatarSources.get(id.toUpperCase()) })),
      ...[...new Set(memberIds)].map((id) => ({ kind: 'members' as const, id, source: teamSources?.get(id) })),
    ];
    const issues = new Map<string, string>();
    const members = new Map<string, string>();
    const loaded = new Map<string, Promise<string | null>>();
    const load = (source?: string) => {
      if (!source) return Promise.resolve(null);
      const result = loaded.get(source) ?? this.loadAvatar(source);
      loaded.set(source, result);
      return result;
    };
    const current = includeCurrentUser ? load(this.profileAvatarSource) : undefined;
    for (let index = 0; index < tasks.length; index += 8) {
      await Promise.all(tasks.slice(index, index + 8).map(async ({ kind, id, source }) => {
        const avatar = await load(source);
        if (avatar) (kind === 'issues' ? issues : members).set(id, avatar);
      }));
    }
    const currentUser = await current;
    return { issues: Object.fromEntries(issues), members: Object.fromEntries(members), ...(currentUser ? { currentUser } : {}) };
  }

  private loadAvatar(source?: string): Promise<string | null> {
    if (!source) return Promise.resolve(null);
    const base = `${this.site.href.replace(/\/$/, '')}/`;
    const url = URL.parse(source, base);
    if (!url || url.username || url.password || url.hash) return Promise.resolve(null);
    const local = url.origin === this.site.origin && url.pathname === new URL('secure/useravatar', base).pathname;
    const cloudCdn = this.edition === 'cloud' && url.protocol === 'https:' && !url.port &&
      /^avatar-management--avatars\.[a-z0-9-]+\.prod\.public\.atl-paas\.net$/.test(url.hostname);
    if (!local && !cloudCdn) return Promise.resolve(null);
    const pending = this.pendingAvatars.get(url.href);
    if (pending) return pending;
    const authorization = local && this.apiSite.origin === this.site.origin ? this.authorization : undefined;
    const result = fetchAvatar(url, authorization).finally(() => this.pendingAvatars.delete(url.href));
    this.pendingAvatars.set(url.href, result);
    return result;
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

  private async searchGraphRoots(jql: string, fields: string[], epicKey?: string, epicField?: string) {
    try {
      return await this.search(jql, fields, MAX_SEARCH_ISSUES);
    } catch (error) {
      if (this.edition !== 'data-center' || !(error instanceof JiraError) || error.status !== 400 || !epicKey || !epicField) {
        throw error;
      }
      const key = JSON.stringify(epicKey);
      if (jql !== `key = ${key} OR "Epic Link" = ${key}`) throw error;
      return this.search(`key = ${key} OR cf[${epicField.slice('customfield_'.length)}] = ${key}`, fields, MAX_SEARCH_ISSUES);
    }
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

  private async searchIssueBatches(keys: string[], fields: string[], warning: string, warnings: Set<string>): Promise<IssueRef[]> {
    const batches: string[][] = [];
    for (let index = 0; index < keys.length; index += 50) batches.push(keys.slice(index, index + 50));
    const issues: IssueRef[] = [];
    for (let index = 0; index < batches.length; index += 4) {
      const results = await Promise.all(batches.slice(index, index + 4).map(async (batch) => {
        try {
          const expected = new Set(batch);
          const result = await this.search(issueKeysJql(batch), fields, batch.length);
          return result.issues.filter(({ key }) => expected.has(key));
        } catch (error) {
          if (!(error instanceof JiraError) || error.status === 401) throw error;
          return [];
        }
      }));
      issues.push(...results.flat());
    }
    if (issues.length < keys.length) warnings.add(warning);
    return issues;
  }

  private async expandEpicSubtasks(
    result: { issues: IssueRef[]; truncated: boolean }, fields: string[], warnings: Set<string>,
  ): Promise<void> {
    const seen = new Set(result.issues.map(({ key }) => key));
    let frontier = result.issues;
    for (let depth = 0; frontier.length && depth < MAX_HIERARCHY_LEVELS; depth++) {
      const keys = [...new Set(frontier.flatMap(({ fields: data }) =>
        list(data?.subtasks).flatMap(toRef).map(({ key }) => key)).filter((key) => !seen.has(key)))];
      const available = MAX_SEARCH_ISSUES - result.issues.length;
      if (keys.length > available) result.truncated = true;
      const batch = keys.slice(0, available);
      if (!batch.length) return;
      for (const key of batch) seen.add(key);
      frontier = await this.searchIssueBatches(batch, fields, 'Часть подзадач эпика недоступна.', warnings);
      result.issues.push(...frontier);
    }
    if (frontier.length) warnings.add('Часть подзадач эпика недоступна.');
  }

  private hierarchyLinks(fields: JsonObject): { parent?: IssueRef; epic?: IssueRef } {
    const directEpic = [...this.knownEpicFields].flatMap((field) => toHierarchyRef(fields[field]))[0];
    const parent = toHierarchyRef(fields.parent)[0] ??
      [...this.knownHierarchyFields].filter((field) => !this.knownEpicFields.has(field))
        .flatMap((field) => toHierarchyRef(fields[field]))[0] ?? directEpic;
    const epic = directEpic ?? (parent && isEpicType(parent.fields?.issuetype) ? parent : undefined);
    return { parent, epic };
  }

  private async loadHierarchyRefs(
    issues: ReadonlyMap<string, IssueRef>, hydrated: ReadonlySet<string>, hierarchyFields: string[], warnings: Set<string>,
  ): Promise<Map<string, IssueRef>> {
    const warning = 'Названия части родительских задач недоступны.';
    const fields = ['summary', 'issuetype', 'parent', ...hierarchyFields];
    const refs = new Map(issues);
    const searched = new Set(hydrated);
    const scanned = new Set<string>();
    let frontier = [...issues.keys()];
    let remaining = MAX_GRAPH_ISSUES;
    for (let depth = 0; frontier.length && depth < MAX_HIERARCHY_LEVELS; depth++) {
      const next = new Set<string>();
      const missing = new Set<string>();
      for (const key of frontier) {
        scanned.add(key);
        const { parent, epic } = this.hierarchyLinks(refs.get(key)?.fields ?? {});
        for (const ref of [parent, epic]) {
          if (!ref || ref.key === key) continue;
          const current = refs.get(ref.key);
          if (!searched.has(ref.key)) {
            const merged = { key: ref.key, fields: { ...ref.fields, ...current?.fields } };
            refs.set(ref.key, merged);
            if (!string(merged.fields.summary) || (!epic && !isEpicType(merged.fields.issuetype))) missing.add(ref.key);
          }
          next.add(ref.key);
        }
      }
      const keys = [...missing].slice(0, remaining);
      if (keys.length < missing.size) warnings.add(warning);
      remaining -= keys.length;
      for (const key of keys) searched.add(key);
      for (const ref of await this.searchIssueBatches(keys, fields, warning, warnings)) {
        const metadata = Object.fromEntries(fields.flatMap((field) =>
          ref.fields && Object.hasOwn(ref.fields, field) ? [[field, ref.fields[field]]] : []));
        refs.set(ref.key, { key: ref.key, fields: { ...refs.get(ref.key)?.fields, ...metadata } });
        scanned.delete(ref.key);
      }
      frontier = [...next].filter((key) => !scanned.has(key));
    }
    return refs;
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
      const qaFields = [...this.knownQaFields];
      const fields = [...new Set([...ISSUE_FIELDS, ...storyFields, ...qaFields, ...this.knownHierarchyFields, ...this.knownSprintFields])];
      return this.toIssue(await this.readIssue(key, fields), storyFields, false, false, qaFields);
    } catch {
      return fallback;
    }
  }

  private toIssue(issue: IssueRef, storyFields: string[], external = false, stub = false, qaFields: string[] = []): JiraIssue {
    const fields = issue.fields ?? {};
    const status = record(fields.status);
    const issueType = record(fields.issuetype);
    const assignee = record(fields.assignee);
    const assigneeId = userIdentity(assignee, this.edition);
    if (!stub) {
      const key = issue.key.toUpperCase();
      const source = avatarSource(assignee);
      this.issueAvatarSources.delete(key);
      if (source) this.issueAvatarSources.set(key, source);
      trimMap(this.issueAvatarSources, AVATAR_SOURCE_LIMIT);
    }
    const epic = isEpicType(issueType);
    const { parent, epic: directEpic } = this.hierarchyLinks(fields);
    const sprintValues = [...new Set([...this.knownSprintFields, 'sprint', 'closedSprints'])].flatMap((field) => {
      const value = fields[field];
      return (Array.isArray(value) ? value : [value]).flatMap(toSprint);
    });
    const sprintDetails = new Map<string, JiraSprint>();
    for (const { sprint } of sprintValues) {
      if (!sprint) continue;
      sprintDetails.set(sprint.id, mergeSprint(sprint, sprintDetails.get(sprint.id) ?? this.knownSprints.get(sprint.id)));
    }
    const storyPoints = fieldNumber(fields, storyFields);
    const qaPoints = fieldNumber(fields, qaFields);
    const description = fields.description;
    const richDescription = this.edition === 'cloud' && description != null && !isPlainAdf(description);
    return {
      key: issue.key,
      summary: string(fields.summary) ?? issue.key,
      status: string(status.name) ?? (stub ? 'Вне выборки' : 'Неизвестен'),
      statusCategory: string(record(status.statusCategory).key),
      issueType: string(issueType.name),
      assignee: string(assignee.displayName),
      ...(assigneeId ? { assigneeId } : {}),
      project: string(record(fields.project).key) ?? issue.key.replace(/-\d+$/, ''),
      storyPoints,
      ...(qaPoints !== undefined ? { qaPoints } : {}),
      description: typeof description === 'string' ? description : adfText(description),
      descriptionMarkdown: richDescription ? adfMarkdown(description) : undefined,
      descriptionReadOnly: richDescription ? true : undefined,
      url: this.getIssueUrl(issue.key),
      external,
      labels: [...new Set(list(fields.labels).map(string).filter(isPresent))],
      parentKey: parent?.key,
      ...(string(parent?.fields?.summary) ? { parentSummary: string(parent?.fields?.summary) } : {}),
      epicKey: epic ? issue.key : directEpic?.key,
      ...(string(directEpic?.fields?.summary) ? { epicSummary: string(directEpic?.fields?.summary) } : {}),
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

function unavailableVelocitySample(sprint: JiraSprint): JiraSprintVelocitySample {
  return { sprint, completedIssues: 0, evaluatedIssues: 0, totalIssues: 0, complete: false };
}

function requireAgileId(value: string): string {
  if (!/^[1-9]\d{0,19}$/.test(value)) throw new JiraError('Укажи корректную доску и спринт Jira.', 400);
  return value;
}

function sprintScope(input: JiraSprintScope): JiraSprintScope {
  return { boardId: requireAgileId(input.boardId), sprintId: requireAgileId(input.sprintId) };
}

function membershipKeys(values: string[], limit: number): string[] {
  if (!Array.isArray(values) || values.length > limit || values.some((key) => typeof key !== 'string' || !ISSUE_KEY.test(key))) {
    throw new JiraError('Некорректный список задач для изменения спринта.', 400);
  }
  const keys = values.map((key) => key.toUpperCase());
  if (new Set(keys).size !== keys.length) throw new JiraError('Убери повторяющиеся ключи задач.', 400);
  return keys;
}

function requireWritableSprint(sprint: JiraSprint): void {
  if (sprint.state !== 'active' && sprint.state !== 'future') {
    throw new JiraError('Состав закрытого спринта изменить нельзя.', 409);
  }
}

function jiraFailure(error: unknown, fallback: string): string {
  return error instanceof JiraError ? error.message : fallback;
}

function toHierarchyRef(value: unknown): IssueRef[] {
  const row = record(value);
  const data = record(row.data);
  const ref = toRef(value)[0] ?? toRef(data)[0];
  if (!ref) return [];
  const summary = string(ref.fields?.summary) ?? string(row.summary) ?? string(data.summary);
  return [{ ...ref, fields: { ...ref.fields, ...(summary ? { summary } : {}) } }];
}

function issueKeysJql(keys: string[]): string {
  return `key in (${keys.map((key) => JSON.stringify(key)).join(', ')})`;
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

function addIssueHierarchy(issues: JiraIssue[], edges: JiraEdge[], outsideHierarchy: JiraIssue[]): void {
  const hierarchy = [...issues, ...outsideHierarchy];
  const byKey = new Map(hierarchy.map((issue) => [issue.key, issue]));
  for (const edge of edges) {
    if (edge.kind !== 'parent') continue;
    const child = byKey.get(edge.target);
    if (child) child.parentKey ??= edge.source;
  }

  for (const issue of hierarchy) {
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

  for (const issue of issues) {
    const parent = issue.parentKey ? byKey.get(issue.parentKey) : undefined;
    const epic = issue.epicKey ? byKey.get(issue.epicKey) : undefined;
    if (parent && parent.summary !== parent.key) issue.parentSummary = parent.summary;
    if (epic && epic.summary !== epic.key) issue.epicSummary = epic.summary;
  }
}

function isEpicType(value: unknown): boolean {
  const type = record(value);
  return type.hierarchyLevel === 1 || ['epic', 'эпик'].includes(string(type.name)?.toLowerCase() ?? '');
}

function isSubtaskType(type: JsonObject): boolean {
  return type.subtask === true || type.hierarchyLevel === -1;
}

function isStoryPointsField(field: JsonObject): boolean {
  const schema = record(field.schema);
  const name = string(field.name)?.trim().toLowerCase();
  return schema.custom === 'com.pyxis.greenhopper.jira:gh-story-points' ||
    ((schema.type === 'number' || schema.type === undefined) && (name === 'story points' || name === 'story point estimate'));
}

function isNumericField(field: JsonObject): boolean {
  return record(field.schema).type === 'number' || isStoryPointsField(field);
}

function isNamedQaField(field: JiraOption): boolean {
  return /\b(?:qa|testing)\b|тестирован/i.test(field.name) && /\b(?:points?|estimate)\b|оценк|балл/i.test(field.name);
}

function boardEstimateFields(query: JiraSprintEstimateFields, board: JsonObject | undefined, catalog: JsonObject[]): JiraSprintEstimateFields {
  if (query.storyPointsField?.trim()) return query;
  const boardField = string(record(record(board?.estimation).field).fieldId);
  if (!boardField || boardField === query.qaPointsField || !catalog.some((field) => field.id === boardField && isNumericField(field))) {
    return query;
  }
  return { ...query, storyPointsField: boardField };
}

function estimateFields(fields: JsonObject[], query: JiraSprintEstimateFields) {
  const selectedStory = query.storyPointsField?.trim();
  const selectedQa = query.qaPointsField?.trim();
  const isCustomId = (id: string) => /^customfield_\d+$/.test(id);
  if (selectedStory && !isCustomId(selectedStory)) throw new JiraError('Выбери корректное поле Story Points.', 400);
  if (selectedQa && (!isCustomId(selectedQa) || selectedStory === selectedQa)) {
    throw new JiraError('Выбери отдельное числовое поле QA Points.', 400);
  }
  const storyPointsFields = fields.filter((field) => isStoryPointsField(field) || (field.id === selectedStory && isNumericField(field)))
    .flatMap(fieldOption);
  const qaPointsFields = fields.filter((field) => isNumericField(field) && !isStoryPointsField(field) && field.id !== selectedStory)
    .flatMap(fieldOption).sort((left, right) => Number(isNamedQaField(right)) - Number(isNamedQaField(left)) ||
      left.name.localeCompare(right.name));
  const qaCatalogEntry = fields.find((field) => field.id === selectedQa);
  if (selectedQa && qaCatalogEntry && (!isNumericField(qaCatalogEntry) || isStoryPointsField(qaCatalogEntry))) {
    throw new JiraError('Выбери отдельное числовое поле QA Points.', 400);
  }
  const storyFields = selectedStory ? [selectedStory] : storyPointsFields.map((field) => field.id);
  const namedQaFields = qaPointsFields.filter(isNamedQaField);
  const qaFields = selectedQa ? [selectedQa] : namedQaFields.length === 1 ? [namedQaFields[0]!.id] : [];
  return { storyFields, qaFields, storyPointsFields, qaPointsFields };
}

function fieldNumber(fields: JsonObject, ids: string[]): number | undefined {
  return ids.map((id) => fields[id]).find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function historicalIssue(
  fields: JsonObject, histories: unknown[], cutoff: number, story: string | undefined, qa: string | undefined,
  catalog: JsonObject[], edition: JiraEdition,
) {
  const estimate = (field: string | undefined) => field && Object.hasOwn(fields, field)
    ? fields[field] === null ? 0 : fieldNumber(fields, [field]) : undefined;
  const hasName = (change: JsonObject, fieldId: string | undefined) => {
    if (!fieldId) return false;
    if (change.fieldId !== undefined) return change.fieldId === fieldId;
    const name = string(change.field)?.toLowerCase();
    if (!name) return false;
    const matching = catalog.filter((field) => string(field.name)?.toLowerCase() === name);
    return matching.length === 1 && matching[0]?.id === fieldId;
  };
  const previousNumber = (change: JsonObject) => {
    const previous = change.fromString ?? change.from;
    if (previous == null) return Object.hasOwn(change, 'from') || Object.hasOwn(change, 'fromString') ? 0 : undefined;
    if ((typeof previous === 'number' || (typeof previous === 'string' && previous.trim())) && Number.isFinite(Number(previous))) {
      return Number(previous);
    }
    return undefined;
  };
  const assignee = record(fields.assignee);
  const id = userIdentity(assignee, edition);
  const state = {
    status: numericId(record(fields.status).id),
    story: estimate(story),
    qa: estimate(qa),
    person: id ? { id, name: string(assignee.displayName) ?? id } : fields.assignee === null ? null : undefined,
  };
  const entries = histories.map(record).map((history) => ({
    items: history.items, date: Date.parse(string(history.created) ?? ''), id: numericId(history.id),
  }));
  if (entries.some((entry) => !Number.isFinite(entry.date) || !Array.isArray(entry.items))) return undefined;
  entries.sort((a, b) => b.date - a.date || (b.id ?? '').localeCompare(a.id ?? '', 'en', { numeric: true }));
  for (const { date, items } of entries) {
    if (date <= cutoff) break;
    for (const change of list(items).map(record)) {
      const field = string(change.field)?.toLowerCase();
      if (change.fieldId === 'status' || (!change.fieldId && field === 'status')) state.status = numericId(change.from);
      else if (change.fieldId === 'assignee' || (!change.fieldId && field === 'assignee')) {
        const previousId = string(change.from);
        state.person = previousId ? { id: previousId, name: string(change.fromString) ?? previousId }
          : change.from === null && change.fromString == null ? null : undefined;
      } else if (hasName(change, story)) state.story = previousNumber(change);
      else if (hasName(change, qa)) state.qa = previousNumber(change);
    }
  }
  return state;
}

function isHierarchyField(field: JsonObject): boolean {
  return isEpicLinkField(field) || record(field.schema).custom === 'com.atlassian.jpo:jpo-custom-field-parent' ||
    string(field.name)?.trim().toLowerCase() === 'parent link';
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
  let endDate = string(row.endDate);
  let completeDate = string(row.completeDate);
  const originBoardId = numericId(row.originBoardId);
  const goal = string(row.goal);
  if (typeof value === 'string' && /(?:^|\.)Sprint@[^[]+\[/.test(value)) {
    id = /(?:\[|,)id=(\d+)(?=,|\])/.exec(value)?.[1];
    name = /(?:\[|,)name=(.*?)(?=,(?:goal|startDate|endDate|completeDate|activatedDate|sequence|sprintVersion|autoStartStop|rapidViewId|state|id)=|\]$)/.exec(value)?.[1];
    state = /(?:\[|,)state=(\w+)(?=,|\])/.exec(value)?.[1]?.toLowerCase();
    startDate = /(?:\[|,)startDate=([^,\]]+)/.exec(value)?.[1];
    endDate = /(?:\[|,)endDate=([^,\]]+)/.exec(value)?.[1];
    completeDate = /(?:\[|,)completeDate=([^,\]]+)/.exec(value)?.[1];
  }
  const label = name?.trim() || id;
  if (!label) return [];
  const status = state === 'future' || state === 'active' || state === 'closed' ? state : undefined;
  return [{ name: label, sprint: id ? {
    id, name: label, state: status,
    ...(startDate && Number.isFinite(Date.parse(startDate)) ? { startDate } : {}),
    ...(endDate && Number.isFinite(Date.parse(endDate)) ? { endDate } : {}),
    ...(completeDate && Number.isFinite(Date.parse(completeDate)) ? { completeDate } : {}),
    ...(goal ? { goal } : {}),
    ...(originBoardId ? { originBoardId } : {}),
  } : undefined }];
}

function mergeSprint(sprint: JiraSprint, known?: JiraSprint): JiraSprint {
  return {
    ...known,
    ...sprint,
    name: known && sprint.name === sprint.id ? known.name : sprint.name,
    state: sprint.state ?? known?.state,
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

function userIdentity(user: JsonObject, edition: JiraEdition): string | undefined {
  return edition === 'cloud' ? string(user.accountId) : string(user.key) ?? string(user.name);
}

function avatarSource(user: JsonObject): string | undefined {
  const urls = record(user.avatarUrls);
  return ['48x48', '32x32', '24x24', '16x16'].map((size) => string(urls[size]))
    .find((url) => url && url.length <= 4_096);
}

function trimMap<Key, Value>(map: Map<Key, Value>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
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
