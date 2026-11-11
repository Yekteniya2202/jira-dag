import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight, CalendarRange, ChevronDown, CircleAlert, Crosshair, GitBranch, Layers3, Plus, Trash2, Users,
} from 'lucide-react';
import type { JiraGraph, JiraIssue } from '../shared/contracts';
import type { AnalysisSettings } from './analysis-settings';
import { analyzeDependencies, type DependencyAnalysis } from './dependency-analysis';
import { Dialog } from './dialogs';
import { localizeMessage, usePreferences, type Translate } from './i18n';
import { planSprint, sprintRoster, type SprintPlan, type SprintPlanOptions } from './sprint-planner';
import './analysis-panel.css';

type Strategy = NonNullable<SprintPlanOptions['strategy']>;
type TeamMember = AnalysisSettings['people'][number];
type Assignee = Pick<TeamMember, 'id' | 'name'>;
type AnalysisView = 'dependencies' | 'sprint';

type IssueAction = (key: string) => void;
type HighlightAction = (keys: readonly string[]) => void;
type FormatPoints = (value: number) => string;

const strategies: Record<Strategy, [string, string]> = {
  unblock: ['Снять блокировки', 'Unblock more work'],
  priority: ['Высокий приоритет', 'Higher priority first'],
  fit: ['Крупные задачи', 'Largest issues first'],
};

const skipReasons: Record<SprintPlan['skipped'][number]['reason'], [string, string]> = {
  unestimated: ['Без оценки', 'No estimate'],
  'external-blocker': ['Блокер вне выборки', 'Blocker outside query'],
  cycle: ['Зависимость от цикла', 'Cycle dependency'],
  blocked: ['Блокер вне плана', 'Blocker left out of plan'],
  'team-capacity': ['Лимит спринта', 'Sprint capacity'],
  'person-capacity': ['Лимит исполнителя', 'Assignee capacity'],
};

function parseCapacity(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const capacity = Number(value);
  return Number.isFinite(capacity) && capacity >= 0 ? capacity : undefined;
}

function duplicateAssigneeNames(people: readonly { name?: string }[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of people) {
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}

export function AnalysisPanel({ graph, settings, onSettingsChange, onClose, onFocusIssue, onHighlight }: {
  graph: JiraGraph;
  settings: AnalysisSettings;
  onSettingsChange(settings: AnalysisSettings): void;
  onClose(): void;
  onFocusIssue: IssueAction;
  onHighlight?: HighlightAction;
}) {
  const { t, language } = usePreferences();
  const [view, setView] = useState<AnalysisView>('dependencies');
  const analysis = useMemo(() => analyzeDependencies(graph), [graph]);
  const roster = useMemo(() => sprintRoster(graph.issues.filter(({ external }) => !external)), [graph.issues]);
  const points = useMemo<FormatPoints>(() => {
    const format = new Intl.NumberFormat(language, { maximumFractionDigits: 3 });
    return (value) => `${format.format(value)} SP`;
  }, [language]);
  const focus: IssueAction = (key) => {
    onFocusIssue(key);
    onClose();
  };
  const highlight: HighlightAction | undefined = onHighlight && ((keys) => {
    onHighlight(keys);
    onClose();
  });

  return <Dialog title={t('Анализ графа', 'Graph analysis')} onClose={onClose} className="analysis-dialog">
    <div className="analysis-content">
      <nav className="analysis-nav" aria-label={t('Разделы анализа', 'Analysis sections')}>
        <button type="button" className="button secondary" aria-pressed={view === 'dependencies'} onClick={() => setView('dependencies')}>
          <GitBranch size={15} /> {t('Зависимости', 'Dependencies')}
        </button>
        <button type="button" className="button secondary" aria-pressed={view === 'sprint'} onClick={() => setView('sprint')}>
          <CalendarRange size={15} /> {t('План спринта', 'Sprint plan')}
        </button>
      </nav>
      <p className="analysis-caption">{t(
        'Расчёт по загруженной выборке и известным блокирующим связям Jira.',
        'Calculated from the loaded issues and known Jira blocking links.',
      )}</p>
      {graph.warnings.length > 0 && <div className="analysis-warning">
        <CircleAlert size={17} />
        <details>
          <summary>{t('Граф загружен с ограничениями', 'Graph loaded with limitations')}</summary>
          <ul>{graph.warnings.map((warning) => <li key={warning}>{localizeMessage(warning, language)}</li>)}</ul>
        </details>
      </div>}
      {view === 'dependencies' ? <DependenciesView analysis={analysis} graph={graph} points={points} focus={focus} highlight={highlight} t={t} />
        : <SprintView analysis={analysis} roster={roster} settings={settings} onChange={onSettingsChange}
          points={points} focus={focus} highlight={highlight} t={t} />}
    </div>
  </Dialog>;
}

function DependenciesView({ analysis, graph, points, focus, highlight, t }: {
  analysis: DependencyAnalysis; graph: JiraGraph; points: FormatPoints; focus: IssueAction; highlight?: HighlightAction; t: Translate;
}) {
  const { ready, waves, peakParallel, bottlenecks, criticalPath, cycleGroups, blockedByCycle, blockedByExternal, externalBlockers } = analysis;
  const openCount = analysis.scopeIssues.length;
  const knownKeys = new Set(graph.issues.map(({ key }) => key));
  const maximumReadyPreview = 6;
  return <>
    <dl className="analysis-metrics">
      <div><dt>{t('Открыто задач', 'Open issues')}</dt><dd>{openCount}</dd></div>
      <div><dt>{t('Без открытых блокеров', 'No open blockers')}</dt><dd>{ready.length}</dd></div>
      <div><dt>{t('Максимум задач в волне', 'Largest dependency wave')}</dt><dd>{peakParallel}</dd></div>
    </dl>
    {(cycleGroups.length > 0 || blockedByExternal.length > 0) && <div className="analysis-warning">
      <CircleAlert size={17} />
      <div>
        {cycleGroups.length > 0 && <details>
          <summary>{t('Циклы в блокирующих связях', 'Blocking cycles')} <strong>{cycleGroups.length}</strong></summary>
          {cycleGroups.map((cycle) => <div className="analysis-keys" key={cycle[0]}>
            {cycle.map((key) => <IssueKey key={key} issueKey={key} focus={knownKeys.has(key) ? focus : undefined} />)}
          </div>)}
          {blockedByCycle.length > 0 && <p>{t(
            `Задач за пределами цикла, которые от него зависят — ${blockedByCycle.length}.`,
            `Issues outside a cycle that depend on it: ${blockedByCycle.length}.`,
          )}</p>}
        </details>}
        {blockedByExternal.length > 0 && <details>
          <summary>{t('Задачи с блокерами вне выборки', 'Issues with blockers outside the query')} <strong>{blockedByExternal.length}</strong></summary>
          <ul className="analysis-outside-issues">
            {blockedByExternal.map(({ key }) => <li key={key}>
              <IssueKey issueKey={key} focus={focus} />
              <span>{externalBlockers.get(key)?.join(', ')}</span>
            </li>)}
          </ul>
        </details>}
      </div>
    </div>}
    <div className="analysis-columns">
      <section className="analysis-section">
        <header className="analysis-section-heading">
          <h3><Layers3 size={16} /> {t('Параллельная работа', 'Parallel work')}</h3>
          {highlight && ready.length > 0 && <HighlightButton label={t('Подсветить готовые задачи', 'Highlight ready issues')}
            onClick={() => highlight(ready.map(({ key }) => key))} />}
        </header>
        {ready.length ? <>
          <p className="analysis-caption">{t(
            'Эти задачи можно вести одновременно по известным зависимостям. Сверь их с загрузкой исполнителей.',
            'These issues can run in parallel based on the loaded links. Check each assignee’s workload.',
          )}</p>
          <ul className="analysis-list">
            {ready.slice(0, maximumReadyPreview).map((issue) => <IssueRow key={issue.key} issue={issue} focus={focus} />)}
          </ul>
        </> : <p className="analysis-empty">{t('Готовых задач в выборке нет.', 'There are no ready issues in the query.')}</p>}
        {waves.length > 0 && <details className="analysis-details" open={waves.length > 1}>
          <summary>{t('Волны зависимостей', 'Dependency waves')} <b>{waves.length}</b><ChevronDown size={14} /></summary>
          <p className="analysis-caption">{t(
            'В каждой волне собраны задачи, которые можно вести одновременно. Волны идут в порядке зависимостей.',
            'Issues within a wave can run together. Wave numbers show dependency order.',
          )}</p>
          <ol className="analysis-waves">
            {waves.map((wave, index) => <li key={wave[0]?.key ?? index}>
              <span>{t(`Волна ${index + 1}`, `Wave ${index + 1}`)}</span>
              <div className="analysis-keys">{wave.map(({ key, summary }) => <IssueKey key={key} issueKey={key} summary={summary} focus={focus} />)}</div>
            </li>)}
          </ol>
        </details>}
      </section>
      <section className="analysis-section">
        <header className="analysis-section-heading"><h3><GitBranch size={16} /> {t('Критический путь', 'Critical path')}</h3></header>
        {criticalPath ? <>
          <div className="analysis-path">
            <strong>{criticalPath.unit === 'sp' ? points(criticalPath.weight) : t(
              `Длина цепочки — ${criticalPath.weight}`, `Chain length — ${criticalPath.weight}`,
            )}</strong>
            <div className="analysis-keys">
              {criticalPath.issues.map(({ key, summary }, index) => <Fragment key={key}>
                {index > 0 && <ArrowRight size={13} aria-hidden="true" />}
                <IssueKey issueKey={key} summary={summary} focus={focus} />
              </Fragment>)}
            </div>
            <p className="analysis-caption">{criticalPath.unit === 'sp'
              ? t('Самая весомая цепочка по оценкам Story Points.', 'The longest chain weighted by Story Points.')
              : t('Самая длинная цепочка по числу задач. Для расчёта по SP нужны оценки всех задач, попавших в расчёт.',
                'The longest chain by issue count. Weighting by SP requires estimates on all schedulable issues.')}</p>
            {criticalPath.partial && <p className="analysis-caption">{t(
              'Цепочка рассчитана для доступной части графа.', 'The chain covers the schedulable part of the loaded graph.',
            )}</p>}
            {highlight && <HighlightButton label={t('Подсветить критический путь', 'Highlight critical path')}
              onClick={() => highlight(criticalPath.issues.map(({ key }) => key))} />}
          </div>
        </> : <p className="analysis-empty">{t('Доступной цепочки нет.', 'No schedulable chain is available.')}</p>}
        <h4 className="analysis-subheading">{t('Что разблокирует больше работы', 'Highest-impact blockers')}</h4>
        {bottlenecks.length ? <ul className="analysis-list">
          {bottlenecks.slice(0, 8).map(({ issue, direct, downstream }) => <IssueRow key={issue.key} issue={issue} focus={focus}
            detail={t(`Прямо блокирует — ${direct}`, `Directly blocks — ${direct}`)}
            badge={<span title={t('Открытых задач по всей цепочке', 'Open issues downstream')}>{t(`Всего ${downstream}`, `Total ${downstream}`)}</span>} />)}
        </ul> : <p className="analysis-empty">{t('Открытых блокеров в графе нет.', 'There are no open blockers in the graph.')}</p>}
      </section>
    </div>
  </>;
}

function SprintView({ analysis, roster, settings, onChange, points, focus, highlight, t }: {
  analysis: DependencyAnalysis; roster: Assignee[]; settings: AnalysisSettings; onChange(settings: AnalysisSettings): void;
  points: FormatPoints; focus: IssueAction; highlight?: HighlightAction; t: Translate;
}) {
  const capacity = parseCapacity(settings.capacity);
  const invalidCapacity = settings.capacity.trim() !== '' && capacity === undefined;
  const invalidPeople = settings.people.some((person) => person.capacity.trim() !== '' && parseCapacity(person.capacity) === undefined);
  const plan = useMemo(() => capacity !== undefined && !invalidPeople ? planSprint(analysis, {
    capacity,
    people: settings.people.map(({ id, name, capacity: individual }) => ({ id, name, capacity: parseCapacity(individual) })),
    strategy: settings.strategy,
  }) : undefined, [analysis, capacity, invalidPeople, settings.people, settings.strategy]);

  return <div className="analysis-columns sprint-columns">
    <section className="analysis-section">
      <header className="analysis-section-heading"><h3><CalendarRange size={16} /> {t('Условия спринта', 'Sprint constraints')}</h3></header>
      <div className="sprint-plan-fields">
        <label>{t('Лимит спринта, SP', 'Sprint capacity, SP')}
          <input type="number" min="0" step="any" placeholder={t('Например, 30', 'For example, 30')} value={settings.capacity}
            aria-invalid={invalidCapacity || undefined} onChange={(event) => onChange({ ...settings, capacity: event.target.value })} />
        </label>
        <label>{t('Стратегия', 'Strategy')}
          <select value={settings.strategy ?? 'unblock'} onChange={(event) => onChange({ ...settings, strategy: event.target.value as Strategy })}>
            {(Object.keys(strategies) as Strategy[]).map((strategy) => <option key={strategy} value={strategy}>{t(...strategies[strategy])}</option>)}
          </select>
        </label>
      </div>
      {(invalidCapacity || invalidPeople) && <p className="analysis-field-error" role="status">{t(
        'Введи неотрицательные лимиты в Story Points.', 'Enter non-negative capacities in Story Points.',
      )}</p>}
      <TeamSettings roster={roster} people={settings.people} t={t} onChange={(people) => onChange({ ...settings, people })} />
      <p className="analysis-caption">{t(
        'Лимиты используются для примерного плана. SP — оценка объёма работы. Предложения по распределению остаются в приложении.',
        'Capacity is used for a draft plan. SP measure estimated effort. Assignment suggestions stay in the app.',
      )}</p>
    </section>
    <section className="analysis-section">
      <header className="analysis-section-heading">
        <h3><GitBranch size={16} /> {t('Предлагаемый план', 'Suggested plan')}</h3>
        {highlight && plan && plan.planned.length > 0 && <HighlightButton label={t('Подсветить план', 'Highlight plan')}
          onClick={() => highlight(plan.planned.map(({ issue }) => issue.key))} />}
      </header>
      {plan ? <PlanResults plan={plan} points={points} focus={focus} t={t} />
        : <p className="analysis-empty">{t('Задай лимит спринта, чтобы собрать план.', 'Set sprint capacity to calculate a plan.')}</p>}
    </section>
  </div>;
}

function TeamSettings({ roster, people, onChange, t }: {
  roster: Assignee[]; people: TeamMember[]; onChange(people: TeamMember[]): void; t: Translate;
}) {
  const selectId = useId();
  const manualId = useId();
  const [chosen, setChosen] = useState('');
  const [manual, setManual] = useState('');
  const selectedIds = new Set(people.map(({ id }) => id));
  const available = roster.filter(({ id }) => !selectedIds.has(id));
  const selected = available.find(({ id }) => id === chosen);
  const rosterNames = new Set([...roster, ...people].map(({ name }) => name.trim().toLowerCase()));
  const manualName = manual.trim();
  const manualValid = manualName !== '' && !rosterNames.has(manualName.toLowerCase());
  const duplicateNames = duplicateAssigneeNames(roster);
  function addPeople(members: Assignee[]) {
    onChange([...people, ...members.map((person) => ({ ...person, capacity: '' }))]);
  }
  function addManual() {
    if (!manualValid) return;
    addPeople([{ id: `manual:${manualName.toLowerCase()}`, name: manualName }]);
    setManual('');
  }
  function memberName({ id, name }: Assignee) {
    return duplicateNames.has(name) ? `${name} · ${id.slice(-6)}` : name;
  }

  return <div className="analysis-team">
    <h4 className="analysis-subheading"><Users size={15} /> {t('Команда', 'Team')}</h4>
    <p className="analysis-caption">{t(
      'Для задач без исполнителя план предлагает участника команды. Лимит участника можно оставить пустым.',
      'The plan suggests a team member for unassigned issues. Individual capacity can be left blank.',
    )}</p>
    {people.length > 0 && <ul className="analysis-team-list">
      {people.map((person) => <li key={person.id}>
        <span title={memberName(person)}>{memberName(person)}</span>
        <input type="number" min="0" step="any" inputMode="decimal" placeholder="SP" value={person.capacity}
          aria-label={t(`Лимит для ${memberName(person)}, SP`, `Capacity for ${memberName(person)}, SP`)}
          aria-invalid={person.capacity.trim() !== '' && parseCapacity(person.capacity) === undefined}
          onChange={(event) => onChange(people.map((member) => member.id === person.id ? { ...member, capacity: event.target.value } : member))} />
        <button type="button" className="icon-button" aria-label={t(`Убрать ${memberName(person)}`, `Remove ${memberName(person)}`)}
          onClick={() => onChange(people.filter(({ id }) => id !== person.id))}><Trash2 size={15} /></button>
      </li>)}
    </ul>}
    {available.length > 0 && <div className="analysis-team-select">
      <label htmlFor={selectId}>{t('Исполнитель из графа', 'Assignee from graph')}</label>
      <div className="analysis-add-person">
        <select id={selectId} value={selected?.id ?? ''} onChange={(event) => setChosen(event.target.value)}>
          <option value="">{t('Выбрать исполнителя', 'Choose assignee')}</option>
          {available.map((person) => <option key={person.id} value={person.id}>{memberName(person)}</option>)}
        </select>
        <button type="button" className="icon-button outline" aria-label={t('Добавить исполнителя', 'Add assignee')}
          disabled={!selected} onClick={() => { if (selected) addPeople([selected]); setChosen(''); }}><Plus size={16} /></button>
      </div>
      {available.length > 1 && <button type="button" className="text-button" onClick={() => {
        addPeople(available);
        setChosen('');
      }}>{t('Добавить всех исполнителей графа', 'Add all assignees from graph')}</button>}
    </div>}
    <details className="analysis-details analysis-manual-person">
      <summary>{t('Добавить участника вручную', 'Add team member manually')} <ChevronDown size={14} /></summary>
      <label htmlFor={manualId}>{t('Имя участника', 'Team member name')}</label>
      <div className="analysis-add-person">
        <input id={manualId} value={manual} maxLength={120} onChange={(event) => setManual(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addManual(); } }} />
        <button type="button" className="icon-button outline" aria-label={t('Добавить участника', 'Add team member')}
          disabled={!manualValid} onClick={addManual}><Plus size={16} /></button>
      </div>
    </details>
  </div>;
}

function PlanResults({ plan, points, focus, t }: { plan: SprintPlan; points: FormatPoints; focus: IssueAction; t: Translate }) {
  const duplicateNames = duplicateAssigneeNames(plan.loads);
  const assigneeLabel = (name: string, id?: string) => id && duplicateNames.has(name) ? `${name} · ${id.slice(-6)}` : name;
  const byWave = new Map<number, SprintPlan['planned']>();
  for (const entry of plan.planned) {
    const wave = byWave.get(entry.wave) ?? [];
    wave.push(entry);
    byWave.set(entry.wave, wave);
  }
  return <>
    <div className="analysis-capacity">
      <strong>{points(plan.used)} / {points(plan.capacity)}</strong>
      <span>{t('Свободно', 'Available')} {points(plan.remaining)}</span>
      {plan.capacity > 0 && <progress value={plan.used} max={plan.capacity} aria-label={t('Использованный лимит спринта', 'Used sprint capacity')} />}
    </div>
    {plan.loads.length > 0 && <details className="analysis-details" open>
      <summary><Users size={15} /> {t('Загрузка команды', 'Team workload')} <ChevronDown size={14} /></summary>
      <ul className="analysis-loads">
        {plan.loads.map(({ id, name, points: allocated, count, capacity }) => <li key={id ?? 'unassigned'}>
          <span title={name}>{name ? assigneeLabel(name, id) : t('Без исполнителя', 'Unassigned')}</span>
          <small>{t(`Задач — ${count}`, `Issues — ${count}`)}</small>
          <strong>{points(allocated)}{capacity !== undefined && ` / ${points(capacity)}`}</strong>
        </li>)}
      </ul>
    </details>}
    {plan.planned.length ? <details className="analysis-details" open>
      <summary>{t('Порядок работы', 'Work order')} <b>{plan.planned.length}</b><ChevronDown size={14} /></summary>
      <ol className="analysis-plan-waves">
        {[...byWave].sort(([left], [right]) => left - right).map(([wave, entries]) => <li key={wave}>
          <h4>{t(`Волна ${wave}`, `Wave ${wave}`)}</h4>
          <ul className="analysis-list">
            {entries.map(({ issue, points: effort, assignee, assigneeId, suggested }) => {
              const name = assignee ? assigneeLabel(assignee, assigneeId) : t('Без исполнителя', 'Unassigned');
              return <IssueRow key={issue.key} issue={issue} focus={focus}
                detail={suggested ? t(`Предложен исполнитель — ${name}`, `Suggested assignee — ${name}`) : name}
                badge={<span>{points(effort)}</span>} />;
            })}
          </ul>
        </li>)}
      </ol>
    </details> : <p className="analysis-empty">{t('При этих условиях задачи в план не попали.', 'No issues fit the current constraints.')}</p>}
    {plan.skipped.length > 0 && <details className="analysis-details">
      <summary>{t('Вне плана', 'Left out of plan')} <b>{plan.skipped.length}</b><ChevronDown size={14} /></summary>
      <SkippedIssues skipped={plan.skipped} focus={focus} t={t} />
    </details>}
  </>;
}

function SkippedIssues({ skipped, focus, t }: { skipped: SprintPlan['skipped']; focus: IssueAction; t: Translate }) {
  return <div className="analysis-skipped">
    {(Object.keys(skipReasons) as Array<keyof typeof skipReasons>).map((reason) => {
      const rows = skipped.filter((entry) => entry.reason === reason);
      if (!rows.length) return null;
      return <details className="analysis-details" key={reason}>
        <summary>{t(...skipReasons[reason])} <b>{rows.length}</b><ChevronDown size={14} /></summary>
        <ul className="analysis-list">
          {rows.map(({ issue, blockers }) => <IssueRow key={issue.key} issue={issue} focus={focus}
            detail={blockers?.length ? blockers.join(', ') : undefined} />)}
        </ul>
      </details>;
    })}
  </div>;
}

function HighlightButton({ label, onClick }: { label: string; onClick(): void }) {
  return <button type="button" className="text-button analysis-highlight" onClick={onClick}><Crosshair size={14} /> {label}</button>;
}

function IssueKey({ issueKey, summary, focus }: { issueKey: string; summary?: string; focus?: IssueAction }) {
  return focus ? <button type="button" className="analysis-issue-key" title={summary} onClick={() => focus(issueKey)}>{issueKey}</button>
    : <span className="analysis-issue-key">{issueKey}</span>;
}

function IssueRow({ issue, focus, detail = issue.assignee, badge }: { issue: JiraIssue; focus: IssueAction; detail?: string; badge?: ReactNode }) {
  return <li className="analysis-issue-row">
    <button type="button" onClick={() => focus(issue.key)} className="analysis-row-link" title={issue.summary}>
      <strong>{issue.key}</strong> <span>{issue.summary}</span>
      {detail && <small>{detail}</small>}
    </button>
    {badge && <div className="analysis-row-badge">{badge}</div>}
  </li>;
}
