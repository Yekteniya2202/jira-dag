import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Languages, Moon, Sun } from 'lucide-react';

export type Language = 'ru' | 'en';
export type Theme = 'dark' | 'light';
export type Translate = (ru: string, en: string) => string;

interface Preferences {
  language: Language;
  theme: Theme;
  setLanguage(language: Language): void;
  setTheme(theme: Theme): void;
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
  const [theme, setTheme] = useState<Theme>(() => getPreference(themeKey) === 'light' ? 'light' : 'dark');
  const t = useCallback<Translate>((ru, en) => language === 'en' ? en : ru, [language]);
  const value = useMemo(() => ({ language, theme, setLanguage, setTheme, t }), [language, theme, t]);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(languageKey, language);
      window.localStorage.setItem(themeKey, theme);
    } catch { /* Preferences remain usable when local storage is unavailable. */ }
  }, [language, theme]);

  return <preferenceContext.Provider value={value}>{children}</preferenceContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(preferenceContext);
  if (!value) throw new Error('PreferencesProvider is missing.');
  return value;
}

export function PreferenceControls() {
  const { language, theme, setLanguage, setTheme, t } = usePreferences();
  const themeLabel = theme === 'dark' ? t('Включить светлую тему', 'Switch to light theme') : t('Включить тёмную тему', 'Switch to dark theme');
  return <div className="preference-controls">
    <label className="language-control" title={t('Язык интерфейса', 'Interface language')}>
      <Languages size={15} aria-hidden="true" />
      <select aria-label={t('Язык интерфейса', 'Interface language')} value={language}
        onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'ru')}>
        <option value="ru">RU</option>
        <option value="en">EN</option>
      </select>
    </label>
    <button type="button" className="icon-button outline" aria-label={themeLabel} title={themeLabel}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  </div>;
}

const applicationMessages: [ru: string, en: string][] = [
  ['Сервер Jira DAG недоступен.', 'The Jira DAG server is unavailable.'],
  ['Не удалось выполнить запрос.', 'The request could not be completed.'],
  ['Не удалось восстановить сохранённое подключение Jira.', 'Could not restore the saved Jira connection.'],
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
  ['Jira вернула слишком много страниц комментариев или некорректную пагинацию.', 'Jira returned too many comment pages or invalid pagination.'],
  ['Jira не подтвердила создание заметки. Обнови заметки перед повторной отправкой.', 'Jira did not confirm creation. Refresh notes before submitting again.'],
  ['Неверный идентификатор заметки.', 'Invalid note ID.'],
  ['Этот комментарий не является заметкой Jira DAG.', 'This comment is not a Jira DAG note.'],
];

const englishMessages = new Map(applicationMessages);
const russianMessages = new Map(applicationMessages.map(([ru, en]) => [en, ru]));

export function localizeMessage(message: string, language: Language): string {
  if (language === 'ru') return russianMessages.get(message) ?? message;
  return englishMessages.get(message) ?? message
    .replace(/^Показаны первые (\d+) задач\. Уточни JQL для полной выборки\.$/u, 'Showing the first $1 issues. Refine the JQL to load the complete results.')
    .replace(/^Граф ограничен (\d+) задачами\.$/u, 'The graph is limited to $1 issues.')
    .replace(/^Догрузка ограничена (\d+) связанными задачами\.$/u, 'Expansion is limited to $1 linked issues.')
    .replace(/^Введи текст заметки длиной до (\d+) символов\.$/u, 'Enter note text up to $1 characters.');
}
