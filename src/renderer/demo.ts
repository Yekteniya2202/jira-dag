import type { JiraEdge, JiraGraph, JiraIssue } from '../shared/contracts';
import type { Translate } from './i18n';

type DemoStatus = 'todo' | 'active' | 'done';
type DemoDetails = Pick<JiraIssue, 'assignee' | 'labels' | 'priority' | 'dueDate' |
  'isEpic' | 'isSubtask' | 'issueType' | 'parentKey' | 'epicKey'>;

export function makeDemoGraph(t: Translate): JiraGraph {
  const status = {
    todo: { status: t('К выполнению', 'To do'), statusCategory: 'new' },
    active: { status: t('В работе', 'In progress'), statusCategory: 'indeterminate' },
    done: { status: t('Готово', 'Done'), statusCategory: 'done' },
  } satisfies Record<DemoStatus, Pick<JiraIssue, 'status' | 'statusCategory'>>;
  const epicKey = 'MIG-20';
  const task = t('Задача', 'Task');
  const high = t('Высокий', 'High');
  const normal = t('Средний', 'Medium');
  const database = t('Команда данных', 'Data team');
  const platform = t('Команда платформы', 'Platform team');
  const migration = (number: number, summary: string, state: DemoStatus, storyPoints: number, details: DemoDetails = {}): JiraIssue => ({
    key: `MIG-${number}`, summary, ...status[state], storyPoints, url: '', project: 'MIG', issueType: task,
    parentKey: epicKey, epicKey, labels: ['migration'], assignee: platform, priority: normal,
    sprints: [t('Спринт 12', 'Sprint 12')], fixVersions: ['v2.0'],
    originalEstimateSeconds: storyPoints * 3600,
    remainingEstimateSeconds: state === 'done' ? 0 : storyPoints * 3600,
    ...details,
  });
  const issues: JiraIssue[] = [
    migration(20, t('Миграция схемы хранения', 'Storage schema migration'), 'active', 0,
      { isEpic: true, issueType: t('Эпик', 'Epic'), parentKey: undefined }),
    migration(21, t('Развернуть совместимую схему', 'Deploy the compatible schema'), 'done', 3, { labels: ['migration', 'schema'] }),
    migration(22, t('Добавить метрики использования v1', 'Instrument v1 usage'), 'done', 5, { labels: ['migration', 'observability'] }),
    migration(23, t('Выполнить backfill данных', 'Backfill the data'), 'active', 8,
      { assignee: database, priority: high, labels: ['migration', 'data'] }),
    migration(24, t('Переключить чтение на v2', 'Switch reads to v2'), 'todo', 3),
    migration(25, t('Перевести пакетные задачи на v2', 'Migrate batch jobs to v2'), 'todo', 5, { assignee: database }),
    migration(26, t('Подтвердить завершение окна отката', 'Confirm the rollback window has closed'), 'todo', 2),
    migration(27, t('Удалить старую колонку', 'Drop the legacy column'), 'todo', 3,
      { assignee: database, labels: ['migration', 'cleanup'], priority: high, dueDate: '2026-11-24' }),
    migration(28, t('Проверить отсутствие обращений к v1', 'Verify that v1 is unused'), 'active', 2,
      { labels: ['migration', 'observability'] }),
    migration(29, t('Сверить выборку строк', 'Verify a sample of migrated rows'), 'todo', 0,
      { parentKey: 'MIG-23', isSubtask: true, issueType: t('Подзадача', 'Subtask'), assignee: database, labels: ['migration', 'data'] }),
    {
      key: 'OPS-8', summary: t('Согласовать политику хранения', 'Approve the retention policy'), ...status.active,
      project: 'OPS', url: '', issueType: task, labels: ['retention'], assignee: platform, priority: normal, storyPoints: 2,
    },
    {
      key: 'OPS-9', summary: t('Обновить отчёт по хранению', 'Update the retention report'), ...status.todo,
      project: 'OPS', url: '', issueType: task, labels: ['retention'], assignee: database, priority: normal, storyPoints: 1,
    },
  ];
  const blocks = {
    id: '10000', name: t('Блокировки', 'Blocks'), outward: t('блокирует', 'blocks'), inward: t('заблокирована задачей', 'is blocked by'),
  };
  const link = (source: string, target: string): JiraEdge => ({
    id: `demo-${source}-${target}`, source, target, label: blocks.outward, kind: 'link', typeId: blocks.id,
  });
  const edges = [
    ...[[21, 23], [22, 28], [23, 24], [23, 25], [24, 27], [25, 27], [26, 27], [28, 27]]
      .map(([source, target]) => link(`MIG-${source}`, `MIG-${target}`)),
    link('OPS-8', 'OPS-9'),
    ...issues.flatMap(({ key, parentKey }): JiraEdge[] => parentKey ? [{
      id: `parent:${parentKey}:${key}`, source: parentKey, target: key,
      label: t('Родительская задача', 'Parent issue'), kind: 'parent',
    }] : []),
  ];
  return { issues, edges, linkTypes: [blocks], storyPointsFields: [], warnings: [] };
}
