import type { JiraGraph } from '../shared/contracts';

export const demoGraph: JiraGraph = {
  issues: [
    { key: 'MIG-21', summary: 'Развернуть совместимую схему', status: 'Готово', statusCategory: 'done', storyPoints: 3 },
    { key: 'MIG-22', summary: 'Добавить метрики использования v1', status: 'Готово', statusCategory: 'done', storyPoints: 5 },
    { key: 'MIG-23', summary: 'Выполнить backfill данных', status: 'В работе', statusCategory: 'indeterminate', storyPoints: 8 },
    { key: 'MIG-24', summary: 'Переключить чтение на v2', status: 'К выполнению', storyPoints: 3 },
    { key: 'MIG-25', summary: 'Перевести пакетные задачи на v2', status: 'К выполнению', storyPoints: 5 },
    { key: 'MIG-26', summary: 'Подтвердить завершение окна отката', status: 'К выполнению', storyPoints: 2 },
    { key: 'MIG-27', summary: 'Удалить старую колонку', status: 'К выполнению', storyPoints: 3 },
    { key: 'MIG-28', summary: 'Проверить отсутствие обращений к v1', status: 'В работе', statusCategory: 'indeterminate', storyPoints: 2 },
  ].map((issue) => ({ ...issue, project: 'MIG', issueType: 'Task', url: '' })),
  edges: [
    [21, 23], [22, 28], [23, 24], [23, 25], [24, 27], [25, 27], [26, 27], [28, 27],
  ].map(([source, target]) => ({
    id: `demo-${source}-${target}`, source: `MIG-${source}`, target: `MIG-${target}`,
    label: 'blocks', kind: 'link', typeId: '10000',
  })),
  linkTypes: [{ id: '10000', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }],
  storyPointsFields: [],
  warnings: [],
};
