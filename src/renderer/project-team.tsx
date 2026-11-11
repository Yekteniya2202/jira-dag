import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, Search, Users } from 'lucide-react';
import type { ApiMethods, JiraConnection, JiraIssue, JiraTeamMember } from '../shared/contracts';
import { request } from './api';
import { assigneeInitials } from './graph-model';
import { usePreferences } from './i18n';
import './project-team.css';

type TeamResult = ApiMethods['listProjectTeam']['output'];
type TeamState = { status: 'loading' | 'failed' } | { status: 'ready'; result: TeamResult };
type TeamLookup = { project: string; query: string; value: TeamState };
const noMembers: JiraTeamMember[] = [];
const avatarBatchSize = 24;

export function useProjectTeam(project: string | undefined, enabled: boolean, query = '') {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<TeamLookup>();
  const cached = useRef<TeamLookup & { expiresAt: number }>(undefined);
  useEffect(() => {
    if (!project || !enabled) return;
    const saved = cached.current;
    if (saved?.project === project && saved.query === query && saved.expiresAt > Date.now()) {
      setState(saved);
      return;
    }
    let current = true;
    const update = (value: TeamState) => {
      if (current) setState({ project, query, value });
    };
    update({ status: 'loading' });
    const timer = window.setTimeout(() => {
      void request('listProjectTeam', { project, query: query || undefined }).then((result) => {
        const value = { status: 'ready', result } as const;
        if (current) cached.current = { project, query, value, expiresAt: Date.now() + 60_000 };
        update(value);
      }).catch(() => update({ status: 'failed' }));
    }, query ? 250 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [project, enabled, query, retry]);
  const value = project === state?.project && query === state?.query ? state?.value : undefined;
  return { state: value, reload: () => {
    cached.current = undefined;
    setRetry((previous) => previous + 1);
  } };
}

function avatarIdentity(issue: JiraIssue) {
  return issue.assigneeId ? `user:${issue.assigneeId}` : `issue:${issue.key}:${issue.assignee}`;
}

export function useGraphAvatars(issues: readonly JiraIssue[], enabled: boolean) {
  const [images, setImages] = useState<Record<string, string>>({});
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const candidates = new Map<string, string>();
    for (const issue of issues) {
      if (!issue.assignee) continue;
      const id = avatarIdentity(issue);
      if (!issue.external || !candidates.has(id)) candidates.set(id, issue.key);
    }
    const missing = [...candidates].filter(([id]) => !attempted.current.has(id));
    let current = true;
    async function load() {
      for (let index = 0; index < missing.length && current; index += avatarBatchSize) {
        const batch = missing.slice(index, index + avatarBatchSize);
        try {
          const result = await request('getAvatars', { issueKeys: batch.map(([, key]) => key) });
          if (!current) return;
          for (const [id] of batch) attempted.current.add(id);
          const found = batch.flatMap(([id, key]) => result.issues[key] ? [[id, result.issues[key]]] : []);
          if (found.length) setImages((previous) => ({ ...previous, ...Object.fromEntries(found) }));
        } catch { break; }
      }
    }
    void load();
    return () => { current = false; };
  }, [issues, enabled]);
  return useMemo(() => Object.fromEntries(issues.flatMap((issue) => {
    const image = images[avatarIdentity(issue)];
    return image ? [[issue.key, image]] : [];
  })) as Record<string, string>, [images, issues]);
}

export function useCurrentAvatar(connection?: JiraConnection) {
  const [image, setImage] = useState<{ connection: JiraConnection; src: string }>();
  useEffect(() => {
    if (!connection) return;
    let current = true;
    void request('getAvatars', { includeCurrentUser: true }).then(({ currentUser }) => {
      if (current && currentUser) setImage({ connection, src: currentUser });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [connection]);
  return connection && image?.connection === connection ? image.src : undefined;
}

export function PersonAvatar({ name, src }: { name: string; src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return src && src !== failedSrc
    ? <img className="person-avatar" src={src} alt="" onError={() => setFailedSrc(src)} />
    : <span className="person-avatar" aria-hidden="true">{assigneeInitials(name)}</span>;
}

export function ProjectTeam({ project, state, reload }: { project: string; state?: TeamState; reload(): void }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);
  const [images, setImages] = useState(new Map<string, string>());
  const attempted = useRef(new Set<string>());
  const term = query.trim();
  const search = useProjectTeam(project, open && term.length >= 2, term);
  const roster = state?.status === 'ready' ? state.result.members : noMembers;
  const found = useMemo(() => term.length >= 2 && search.state?.status === 'ready' ? search.state.result.members
    : term ? roster.filter(({ name }) => name.toLocaleLowerCase().includes(term.toLocaleLowerCase())) : roster,
  [roster, search.state, term]);
  const visible = useMemo(() => open ? found.slice(0, visibleCount) : roster.slice(0, 5), [found, open, roster, visibleCount]);
  useEffect(() => {
    const memberIds = visible.map(({ id }) => id).filter((id) => !attempted.current.has(id));
    let current = true;
    async function load() {
      for (let index = 0; index < memberIds.length && current; index += avatarBatchSize) {
        const batch = memberIds.slice(index, index + avatarBatchSize);
        try {
          const result = await request('getAvatars', { project, memberIds: batch });
          if (!current) return;
          for (const id of batch) attempted.current.add(id);
          const foundImages = Object.entries(result.members);
          if (foundImages.length) setImages((previous) => new Map([...previous, ...foundImages]));
        } catch { break; }
      }
    }
    void load();
    return () => { current = false; };
  }, [project, visible]);

  const lookupBusy = open && term.length >= 2 && (!search.state || search.state.status === 'loading');
  return <details className="project-team" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <Users size={15} aria-hidden="true" />
      <span>{t('Команда проекта', 'Project team')}</span>
      {state?.status === 'ready' && <b>{roster.length}</b>}
      {!open && roster.length > 0 && <span className="project-team-preview" aria-hidden="true">
        {roster.slice(0, 5).map(({ id, name }) => <PersonAvatar key={id} name={name} src={images.get(id)} />)}
      </span>}
      <ChevronDown size={13} aria-hidden="true" />
    </summary>
    <div className="project-team-content">
      <p>{t('Пользователи, которым Jira разрешает назначать задачи в этом проекте.', 'People Jira can assign issues to in this project.')}</p>
      {state?.status === 'failed' && <div className="project-team-state">
        {t('Список пользователей проекта недоступен.', 'The project user list is unavailable.')}
        <button type="button" className="text-button" onClick={reload}>{t('Повторить', 'Retry')}</button>
      </div>}
      {(!state || state.status === 'loading') && <p role="status">
        <LoaderCircle size={13} className="spin" /> {t('Загрузка команды…', 'Loading team…')}
      </p>}
      {state?.status === 'ready' && <>
        <label className="project-team-search"><Search size={13} aria-hidden="true" />
          <input type="search" aria-label={t('Найти в команде проекта', 'Find someone in the project team')}
            placeholder={t('Имя пользователя', 'User name')} value={query} maxLength={120}
            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
            onChange={(event) => { setQuery(event.target.value); setVisibleCount(20); }} />
        </label>
        {state.result.limited && <p>{t('Jira ограничивает выдачу. Попробуй поиск по имени.', 'Jira limits these results. Try searching by name.')}</p>}
        {lookupBusy && <p role="status">{t('Поиск в Jira…', 'Searching Jira…')}</p>}
        {search.state?.status === 'failed' && <p>{t('Поиск Jira недоступен. Показаны совпадения в загруженном списке.', 'Jira search is unavailable. Showing matches from the loaded list.')}</p>}
        {visible.length > 0 ? <ul className="project-team-list">
          {visible.map(({ id, name }) => <li key={id}><PersonAvatar name={name} src={images.get(id)} /><span>{name}</span></li>)}
        </ul> : !lookupBusy && <p>{t('Пользователи не найдены.', 'No users found.')}</p>}
        {found.length > visibleCount && <button type="button" className="text-button"
          onClick={() => setVisibleCount((count) => count + 20)}>{t('Показать ещё', 'Show more')}</button>}
      </>}
    </div>
  </details>;
}
