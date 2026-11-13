import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { appearanceKey, defaultAppearance, fontStack, paletteTheme, readAppearance, type Appearance, type Theme } from './appearance';

export type Language = 'ru' | 'en';
export type { Theme } from './appearance';
export type Translate = (ru: string, en: string) => string;

interface Preferences {
  language: Language;
  theme: Theme;
  appearance: Appearance;
  graphFont: string;
  setLanguage(language: Language): void;
  updateAppearance(changes: Partial<Appearance>): void;
  resetAppearance(): void;
  t: Translate;
}

const preferenceContext = createContext<Preferences | null>(null);
const languageKey = 'jira-dag.language';
const themeKey = 'jira-dag.theme';

function getPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => getPreference(languageKey) === 'en' ? 'en' : 'ru');
  const [appearance, setAppearance] = useState(() => readAppearance(getPreference(appearanceKey), getPreference(themeKey)));
  const theme = paletteTheme(appearance.palette);
  const appFont = fontStack(appearance.font);
  const graphFont = appearance.graphFont === 'inherit' ? appFont : fontStack(appearance.graphFont);
  const updateAppearance = useCallback((changes: Partial<Appearance>) => {
    setAppearance((previous) => ({ ...previous, ...changes }));
  }, []);
  const resetAppearance = useCallback(() => setAppearance(defaultAppearance), []);
  const t = useCallback<Translate>((ru, en) => language === 'en' ? en : ru, [language]);
  const value = useMemo(() => ({ language, theme, appearance, graphFont, setLanguage, updateAppearance, resetAppearance, t }),
    [language, theme, appearance, graphFont, updateAppearance, resetAppearance, t]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dataset.theme = theme;
    root.dataset.palette = appearance.palette;
    root.dataset.appFont = appearance.font;
    root.dataset.graphFont = appearance.graphFont;
    root.style.setProperty('--app-font', appFont);
    root.style.setProperty('--graph-font', graphFont);
    try {
      window.localStorage.setItem(languageKey, language);
      window.localStorage.setItem(themeKey, theme);
      window.localStorage.setItem(appearanceKey, JSON.stringify(appearance));
    } catch { /* Preferences remain usable when local storage is unavailable. */ }
  }, [language, theme, appearance, appFont, graphFont]);

  return <preferenceContext.Provider value={value}>{children}</preferenceContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(preferenceContext);
  if (!value) throw new Error('PreferencesProvider is missing.');
  return value;
}

const applicationMessages: [ru: string, en: string][] = [
  ['Сервер Jira DAG недоступен.', 'The Jira DAG server is unavailable.'],
  ['Не удалось выполнить запрос.', 'The request could not be completed.'],
  ['Не удалось восстановить сохранённое подключение Jira.', 'Could not restore the saved Jira connection.'],
  ['Не удалось сохранить рабочую область на этом устройстве.', 'Could not save the workspace locally.'],
  ['Jira отклонила сохранённый вход. Подключись заново.', 'Jira rejected the saved login. Sign in again.'],
  ['Подключено. Не удалось обновить сохранённый вход.', 'Connected. Could not update the saved Jira connection.'],
  ['Не удалось удалить сохранённое подключение Jira.', 'Could not remove the saved Jira connection.'],
  ['Подключись к Jira.', 'Connect to Jira first.'],
  ['Укажи полный адрес Jira.', 'Enter the full Jira URL.'],
  ['Укажи HTTPS-адрес Jira без учётных данных, параметров и фрагмента.', 'Enter a Jira HTTPS URL without credentials, query parameters or a fragment.'],
  ['Укажи API-токен и, для Jira Cloud, email учётной записи Atlassian.', 'Enter an API token and, for Jira Cloud, your Atlassian account email.'],
  ['Для Cloud-токена с правами доступа укажи исходный адрес https://<site>.atlassian.net.', 'For a scoped Cloud token, enter the original https://<site>.atlassian.net URL.'],
  ['Jira не вернула корректный Cloud ID сайта.', 'Jira did not return a valid site Cloud ID.'],
  ['Jira не вернула профиль пользователя. Проверь адрес и токен.', 'Jira did not return a user profile. Check the URL and token.'],
  ['Не удалось подключиться к Jira. Проверь сеть и адрес сайта.', 'Could not connect to Jira. Check your network and the site URL.'],
  ['Jira вернула неожиданный ответ. Проверь адрес сайта.', 'Jira returned an unexpected response. Check the site URL.'],
  ['Этот адрес Jira не разрешён администратором приложения.', 'This Jira URL is not allowed by the application administrator.'],
  ['Запросы с этого адреса приложения не разрешены.', 'This request origin is not allowed.'],
  ['Слишком много активных подключений.', 'Too many active connections.'],
  ['Описание содержит форматирование. Отредактируй его в Jira, чтобы сохранить разметку и вложения.', 'The description contains formatting. Edit it in Jira to preserve formatting and attachments.'],
  ['Укажи ключ проекта Jira.', 'Enter the Jira project key.'],
  ['Укажи корректную доску и спринт Jira.', 'Choose a valid Jira board and sprint.'],
  ['Спринт недоступен на выбранной доске Jira.', 'The sprint is unavailable on the selected Jira board.'],
  ['Сократи JQL для бэклога до 4000 символов.', 'Shorten backlog JQL to 4000 characters.'],
  ['Изменения не совпадают с исходным составом спринта или превышают допустимый размер.', 'The changes do not match the original sprint membership or exceed the allowed size.'],
  ['Другое изменение спринта ещё выполняется.', 'Another sprint change is still in progress.'],
  ['Состав спринта изменился или загружен не полностью. Обнови план перед применением.', 'Sprint membership changed or was only partially loaded. Refresh the draft before applying.'],
  ['Состав закрытого спринта изменить нельзя.', 'Membership of a closed sprint cannot be changed.'],
  ['Задача больше не входит в бэклог выбранной доски.', 'The issue is no longer in the selected board’s backlog.'],
  ['Открытый спринт задачи изменился. Обнови план.', 'The issue’s open sprint changed. Refresh the draft.'],
  ['Подзадача наследует спринт родителя. Измени состав через родительскую задачу.', 'A subtask inherits its parent’s sprint. Move the parent issue instead.'],
  ['Jira ещё не подтвердила новый состав. Обнови план.', 'Jira has not confirmed the new membership. Refresh the draft.'],
  ['Не удалось проверить спринт задачи.', 'The issue sprint could not be verified.'],
  ['Не удалось проверить состав спринта.', 'Sprint membership could not be verified.'],
  ['Jira не подтвердила изменение.', 'Jira did not confirm the change.'],
  ['Jira не подтвердила состояние выбранного спринта.', 'Jira did not confirm the state of the selected sprint.'],
  ['Настройки доски Jira недоступны.', 'Jira board configuration is unavailable.'],
  ['Выбери отдельное числовое поле QA Points.', 'Select a separate numeric QA Points field.'],
  ['Часть внешних блокеров недоступна. Их состояние не подтверждено.', 'Some external blockers are unavailable. Their status could not be confirmed.'],
  ['Для истории выбери конкретное поле Story Points.', 'Select a Story Points field for the sprint history.'],
  ['В Jira не найдена завершающая колонка с сопоставленными статусами.', 'The Jira board has no final column with mapped statuses.'],
  ['История использует текущий фильтр доски, текущую колонку Done и задачи, доступные этой учётной записи.', 'History uses the current board filter and Done column, and issues visible to this account.'],
  ['Выбери корректное поле Story Points.', 'Select a valid story points field.'],
  ['Введи JQL и выбери глубину связей от 0 до 3.', 'Enter JQL and choose a link depth from 0 to 3.'],
  ['Укажи название, ключ проекта и тип задачи.', 'Enter the summary, project key and issue type.'],
  ['Укажи название задачи.', 'Enter the issue summary.'],
  ['Выбери две разные задачи и тип связи Jira.', 'Select two different issues and a Jira link type.'],
  ['Связь пока без идентификатора Jira. Обнови граф.', 'The link has no Jira ID yet. Reload the graph.'],
  ['Укажи корректный ключ задачи Jira.', 'Enter a valid Jira issue key.'],
  ['Настройки полей Jira недоступны.', 'Jira field settings are unavailable.'],
  ['Настройки типов связей Jira недоступны.', 'Jira link type settings are unavailable.'],
  ['Часть связанных задач недоступна для этой учётной записи.', 'Some linked issues are unavailable to this account.'],
  ['Названия части родительских задач недоступны.', 'Some parent issue titles are unavailable.'],
  ['Часть подзадач эпика недоступна.', 'Some epic subtasks are unavailable.'],
  ['Jira вернула слишком много страниц комментариев или некорректную пагинацию.', 'Jira returned too many comment pages or invalid pagination.'],
  ['Jira не подтвердила создание заметки. Обнови заметки перед повторной отправкой.', 'Jira did not confirm creation. Refresh notes before submitting again.'],
  ['Jira не подтвердила изменение заметки. Обнови заметки перед повторной попыткой.', 'Jira did not confirm the edit. Refresh notes before trying again.'],
  ['Не удалось проверить видимость заметки в Jira.', 'Could not verify the note visibility in Jira.'],
  ['Неверный идентификатор заметки.', 'Invalid note ID.'],
  ['Этот комментарий не является заметкой Jira DAG.', 'This comment is not a Jira DAG note.'],
];

const englishMessages = new Map(applicationMessages);
const russianMessages = new Map(applicationMessages.map(([ru, en]) => [en, ru]));

export function localizeMessage(message: string, language: Language): string {
  if (language === 'ru') return russianMessages.get(message) ?? message;
  return englishMessages.get(message) ?? message
    .replace(/^Состав спринта неполный\. Предел выборки — (\d+) задач\.$/u, 'Sprint membership is incomplete. The result is limited to $1 issues.')
    .replace(/^Бэклог ограничен (\d+) задачами\. Уточни запрос или найди задачу по ключу\.$/u, 'The backlog is limited to $1 issues. Refine the query or find an issue by key.')
    .replace(/^Догрузка внешних блокеров ограничена (\d+) задачами\.$/u, 'External blocker expansion is limited to $1 issues.')
    .replace(/^История спринта «(.+)» неполная\. Недоступные статусы и оценки исключены из итогов\.$/u, 'Sprint “$1” has incomplete history. Unavailable statuses and estimates are omitted.')
    .replace(/^Не удалось прочитать историю спринта «(.+)»\.$/u, 'Could not load history for sprint “$1”.')
    .replace(/^У закрытого спринта «(.+)» нет фактической даты завершения\.$/u, 'Closed sprint “$1” has no actual completion date.')
    .replace(/^Показаны первые (\d+) задач\. Уточни JQL для полной выборки\.$/u, 'Showing the first $1 issues. Refine the JQL to load the complete results.')
    .replace(/^Граф ограничен (\d+) задачами\.$/u, 'The graph is limited to $1 issues.')
    .replace(/^Догрузка ограничена (\d+) связанными задачами\.$/u, 'Expansion is limited to $1 linked issues.')
    .replace(/^Введи текст заметки длиной до (\d+) символов\.$/u, 'Enter note text up to $1 characters.');
}
