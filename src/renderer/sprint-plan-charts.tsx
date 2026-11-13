import { useMemo } from 'react';
import { Activity, BarChart3, ChartNoAxesCombined, Layers3, Users } from 'lucide-react';
import type { JiraSprintVelocity } from '../shared/contracts';
import { statusTone } from './graph-model';
import { usePreferences, type Translate } from './i18n';
import type { SprintDraftPlan } from './sprint-draft-planning';
import './sprint-plan-charts.css';

type Format = (value: number) => string;
type Unit = 'SP' | 'QA';
type SeriesRow = { key: string; label: string; amount?: number; partial?: boolean; suggested?: number };
type CapacityRow = { key: string; label: string; planned: number; limit?: number };

function percentage(value: number, max: number): string {
  return `${Math.min(100, Math.max(0, value * 100 / max))}%`;
}

export function SprintPlanCharts({ plan, history, selectedKeys }: {
  plan: SprintDraftPlan;
  history?: JiraSprintVelocity;
  selectedKeys: readonly string[];
}) {
  const { t, language } = usePreferences();
  const format = useMemo(() => new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format, [language]);
  const stats = useMemo(() => {
    const selected = new Set(selectedKeys);
    const waves = new Map<number, { committed: number; suggested: number }>();
    const people = new Map<string, { work: number; qa: number }>();
    const work = { planned: 0, suggested: 0 };
    const qa = { planned: 0, suggested: 0 };
    const states = { ready: 0, blocked: 0, done: 0, unplanned: 0 };
    const scheduled = new Set(plan.items.filter(({ stages }) => stages.some(({ wave }) => wave !== undefined))
      .map(({ issue }) => issue.key));
    for (const { issue, stages, blockers, coveredBy } of plan.items) {
      const chosen = selected.has(issue.key);
      if (chosen) {
        selected.delete(issue.key);
        if (statusTone(issue) === 'done') states.done++;
        else if (blockers.length) states.blocked++;
        else if (scheduled.has(issue.key) || coveredBy && scheduled.has(coveredBy)) states.ready++;
        else states.unplanned++;
      }
      for (const stage of stages) {
        const bucket = stage.kind === 'qa' ? qa : work;
        bucket[chosen ? 'planned' : 'suggested'] += stage.points ?? 0;
        if (stage.wave !== undefined) {
          const wave = waves.get(stage.wave) ?? { committed: 0, suggested: 0 };
          wave[chosen ? 'committed' : 'suggested']++;
          waves.set(stage.wave, wave);
        }
        if (chosen && stage.assigneeId) {
          const row = people.get(stage.assigneeId) ?? { work: 0, qa: 0 };
          row[stage.kind] += stage.points ?? 0;
          people.set(stage.assigneeId, row);
        }
      }
    }
    states.unplanned += selected.size;
    return { work, qa, waves, people, states };
  }, [plan.items, selectedKeys]);
  const historyRows = (unit: Unit): SeriesRow[] => [...(history?.samples ?? [])].slice(0, 3).reverse().map((sample) => ({
    key: sample.sprint.id, label: sample.sprint.name,
    amount: unit === 'SP' ? sample.completedStoryPoints : sample.completedQaPoints,
    partial: !sample.complete || (unit === 'SP' ? sample.storyPointsComplete : sample.qaPointsComplete) === false,
  }));
  const teamRows = (unit: Unit): CapacityRow[] => plan.loads.map((person) => ({
    key: person.id, label: person.name,
    planned: stats.people.get(person.id)?.[unit === 'SP' ? 'work' : 'qa'] ?? 0,
    limit: unit === 'SP' ? person.capacity : person.qaCapacity,
  })).filter(({ planned, limit }) => planned > 0 || limit !== undefined);
  const stateRows = [
    { id: 'ready', label: t('Есть место в плане', 'Scheduled'), value: stats.states.ready },
    { id: 'blocked', label: t('Заблокированы', 'Blocked'), value: stats.states.blocked },
    { id: 'done', label: t('Готово', 'Done'), value: stats.states.done },
    { id: 'unplanned', label: t('Нужны уточнения', 'Needs review'), value: stats.states.unplanned },
  ];
  const total = stateRows.reduce((sum, row) => sum + row.value, 0);
  return <div className="sprint-plan-charts">
    <section className="sprint-chart sprint-chart-capacity" aria-label={t('Ёмкость спринта', 'Sprint capacity')}>
      <h3><Activity size={16} aria-hidden="true" />{t('Ёмкость спринта', 'Sprint capacity')}</h3>
      <CapacityTrack unit="SP" planned={stats.work.planned} suggested={stats.work.suggested} limit={plan.capacity} format={format} t={t} />
      <CapacityTrack unit="QA" planned={stats.qa.planned} suggested={stats.qa.suggested} limit={plan.qaCapacity} format={format} t={t} />
      <p className="sprint-chart-legend">
        <span><i />{t('В черновике', 'In draft')}</span><span><i data-tone="suggested" />{t('Рекомендации', 'Recommendations')}</span>
      </p>
    </section>
    <section className="sprint-chart" aria-label={t('Состояние задач', 'Issue readiness')}>
      <h3><Layers3 size={16} aria-hidden="true" />{t('Состояние задач', 'Issue readiness')}</h3>
      {total ? <>
        <div className="sprint-chart-stack" aria-hidden="true">{stateRows.filter(({ value }) => value > 0)
          .map(({ id, value }) => <i key={id} data-tone={id} style={{ flexGrow: value }} />)}</div>
        <ul className="sprint-chart-readiness">{stateRows.map(({ id, label, value }) =>
          <li key={id}><span><i data-tone={id} />{label}</span><b>{value}</b></li>)}</ul>
      </> : <p className="sprint-chart-empty">{t('Добавь задачи в черновик.', 'Add issues to the draft.')}</p>}
    </section>
    <section className="sprint-chart sprint-chart-waves" aria-label={t('Параллельность по волнам', 'Parallel work by wave')}>
      <h3><BarChart3 size={16} aria-hidden="true" />{t('Параллельность по волнам', 'Parallel work by wave')}</h3>
      {stats.waves.size ? <SeriesBars rows={[...stats.waves].sort(([a], [b]) => a - b).map(([wave, { committed, suggested }]) => ({
        key: String(wave), label: t(`Волна ${wave}`, `Wave ${wave}`), amount: committed + suggested, suggested,
      }))} format={format} t={t} unit={t('этапов', 'stages')} />
        : <p className="sprint-chart-empty">{t('Появится после распределения задач.', 'Available once stages are scheduled.')}</p>}
      <p className="sprint-chart-caption">{t('Каждая полоса показывает число параллельных этапов. Штриховка обозначает рекомендации.', 'Each bar counts parallel stages. Stripes indicate recommendations.')}</p>
    </section>
    <section className="sprint-chart sprint-chart-history" aria-label={t('Динамика по закрытым спринтам', 'Completed sprint trend')}>
      <h3><ChartNoAxesCombined size={16} aria-hidden="true" />{t('Динамика по закрытым спринтам', 'Completed sprint trend')}</h3>
      {history?.samples.length ? <div className="sprint-chart-history-pair">
        {(['SP', 'QA'] as const).map((unit) => <div key={unit} data-unit={unit}><h4>{unit}</h4>
          <SeriesBars rows={historyRows(unit)} format={format} t={t} unit={unit}
            average={unit === 'SP' ? plan.velocity.averagePoints : plan.velocity.averageQaPoints} />
        </div>)}
      </div> : <p className="sprint-chart-empty">{t('История Jira пока недоступна.', 'Jira sprint history is currently unavailable.')}</p>}
    </section>
    <section className="sprint-chart sprint-chart-team" aria-label={t('Загрузка участников', 'Team member workload')}>
      <h3><Users size={16} aria-hidden="true" />{t('Загрузка участников', 'Team member workload')}</h3>
      {plan.loads.length ? <div className="sprint-chart-history-pair">
        {(['SP', 'QA'] as const).map((unit) => <div key={unit} data-unit={unit}><h4>{unit}</h4>
          <WorkloadBars rows={teamRows(unit)} format={format} t={t} unit={unit} />
        </div>)}
      </div> : <p className="sprint-chart-empty">{t('Добавь участников команды.', 'Add team members.')}</p>}
    </section>
  </div>;
}

function CapacityTrack({ unit, planned, suggested, limit, format, t }: {
  unit: Unit; planned: number; suggested: number; limit?: number; format: Format; t: Translate;
}) {
  const max = Math.max(1, planned + suggested, limit ?? 0);
  return <div className="sprint-chart-metric" data-unit={unit}>
    <div><span>{unit}</span><strong>{format(planned)}{limit !== undefined && <small> / {format(limit)}</small>}</strong></div>
    <div className="sprint-chart-track" aria-hidden="true">
      <i data-tone={limit !== undefined && planned > limit ? 'blocked' : undefined} style={{ width: percentage(planned, max) }} />
      <i data-tone="suggested" style={{ width: percentage(suggested, max) }} />
      {limit !== undefined && <i className="sprint-chart-cap" style={{ left: percentage(limit, max) }} />}
    </div>
    <small>{limit === undefined ? t('Лимит не задан', 'Capacity not set')
      : suggested > 0 ? t(`Предложено ещё ${format(suggested)} ${unit}`, `Suggested another ${format(suggested)} ${unit}`) : ' '}</small>
  </div>;
}

function SeriesBars({ rows, format, t, unit, average }: {
  rows: readonly SeriesRow[]; format: Format; t: Translate; unit: string; average?: number;
}) {
  const max = Math.max(1, average ?? 0, ...rows.map(({ amount }) => amount ?? 0));
  const avg = average === undefined ? undefined : percentage(average, max);
  return <>
    {average !== undefined && <p className="sprint-chart-average">{t('Среднее', 'Average')} <b>{format(average)} {unit}</b></p>}
    <ul className="sprint-chart-series">
      {rows.map(({ key, label, amount, partial, suggested = 0 }) => <li key={key}>
        <span title={label}>{label}</span>
        <div className="sprint-chart-track" aria-hidden="true">
          {amount !== undefined && <i data-tone={partial ? 'partial' : undefined} style={{ width: percentage(amount - suggested, max) }} />}
          {suggested > 0 && <i data-tone="suggested" style={{ width: percentage(suggested, max) }} />}
          {avg !== undefined && <i className="sprint-chart-cap" style={{ left: avg }} />}
        </div>
        <strong>{amount === undefined ? '—' : format(amount)}
          {partial && <abbr title={t('Неполные данные', 'Incomplete data')}>*</abbr>}</strong>
      </li>)}
    </ul>
  </>;
}

function WorkloadBars({ rows, unit, format, t }: { rows: CapacityRow[]; unit: Unit; format: Format; t: Translate }) {
  if (!rows.length) return <p className="sprint-chart-empty">{t('Нет оценок нагрузки.', 'No workload estimates.')}</p>;
  const max = Math.max(1, ...rows.map(({ planned, limit }) => Math.max(planned, limit ?? 0)));
  return <ul className="sprint-chart-series" data-unit={unit}>
    {rows.map(({ key, label, planned, limit }) => <li key={key}>
      <span title={label}>{label}</span>
      <div className="sprint-chart-track" aria-hidden="true">
        {limit !== undefined && <i className="sprint-chart-workload-limit" style={{ width: percentage(limit, max) }} />}
        <i className="sprint-chart-workload" data-tone={limit !== undefined && planned > limit ? 'blocked' : undefined}
          style={{ width: percentage(planned, max) }} />
      </div>
      <strong>{format(planned)}{limit !== undefined && <small> / {format(limit)}</small>}</strong>
    </li>)}
  </ul>;
}
