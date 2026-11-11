import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, RefreshCw } from 'lucide-react';
import type { ApiResponse } from '../shared/contracts';
import type { UpdateCheckResult } from '../shared/updates';
import { usePreferences } from './i18n';

type Available = Extract<UpdateCheckResult, { status: 'available' }>;
type UpdateState =
  | { phase: 'idle' | 'checking' }
  | { phase: 'checked'; result: UpdateCheckResult }
  | { phase: 'downloading'; release: Available; progress?: number }
  | { phase: 'ready' | 'installing' | 'opened' | 'download-error' | 'install-error'; release: Available };

async function checkWebRelease(): Promise<UpdateCheckResult> {
  const response = await fetch('/api/update', {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  });
  const result = await response.json() as ApiResponse<UpdateCheckResult>;
  if (!result.ok) return { status: 'error', currentVersion: __APP_VERSION__ };
  return result.data;
}

export function useAppUpdate() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const operating = useRef(false);

  useEffect(() => window.jiraDag?.onUpdateProgress?.(({ percent }) => {
    if (!Number.isFinite(percent)) return;
    const progress = Math.max(0, Math.min(100, Math.floor(percent)));
    setState((current) => current.phase === 'downloading' && current.progress !== progress
      ? { ...current, progress } : current);
  }), []);

  async function check() {
    if (operating.current) return;
    operating.current = true;
    setState({ phase: 'checking' });
    try {
      const result = window.jiraDag ? await window.jiraDag.checkForUpdate() : await checkWebRelease();
      setState(result.status === 'available' && result.downloaded
        ? { phase: 'ready', release: result } : { phase: 'checked', result });
    } catch {
      setState({ phase: 'checked', result: { status: 'error', currentVersion: __APP_VERSION__ } });
    } finally {
      operating.current = false;
    }
  }

  async function download(release: Available) {
    if (operating.current || !window.jiraDag) return;
    operating.current = true;
    setState({ phase: 'downloading', release });
    try {
      const { status } = await window.jiraDag.downloadUpdate();
      setState({ phase: status === 'ready' || status === 'opened' ? status : 'download-error', release });
    } catch {
      setState({ phase: 'download-error', release });
    } finally {
      operating.current = false;
    }
  }

  async function install(release: Available) {
    if (operating.current || !window.jiraDag) return;
    operating.current = true;
    setState({ phase: 'installing', release });
    try {
      const { status } = await window.jiraDag.installUpdate();
      if (status !== 'installing') setState({ phase: 'install-error', release });
    } catch {
      setState({ phase: 'install-error', release });
    } finally {
      operating.current = false;
    }
  }

  return { state, check, download, install };
}

export function UpdateSettings({ update, restartBlocked }: { update: ReturnType<typeof useAppUpdate>; restartBlocked: boolean }) {
  const { t } = usePreferences();
  const { state, check, download, install } = update;
  const { phase } = state;
  const desktop = Boolean(window.jiraDag);
  const release = 'release' in state ? state.release
    : state.phase === 'checked' && state.result.status === 'available' ? state.result : undefined;
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const canDownload = phase === 'checked' || phase === 'opened' || phase === 'download-error';
  const canInstall = phase === 'ready' || phase === 'install-error';
  let status: string | undefined;
  if (phase === 'checking') status = t('Проверяю обновления…', 'Checking for updates…');
  if (phase === 'downloading') status = t('Загружается обновление…', 'Downloading update…');
  if (phase === 'ready') status = t('Обновление загружено и проверено.', 'The update has been downloaded and verified.');
  if (phase === 'installing') status = t('Приложение перезапускается…', 'Restarting the application…');
  if (phase === 'opened') status = t('Открыта страница релиза.', 'The release page was opened.');
  if (phase === 'download-error') status = t('Не удалось загрузить обновление. Попробуй ещё раз.', 'Could not download the update. Try again.');
  if (phase === 'install-error') status = t('Не удалось запустить установку.', 'Could not start installation.');
  if (phase === 'checked') {
    if (state.result.status === 'current') status = t('Установлена последняя версия.', 'The latest version is installed.');
    if (state.result.status === 'unavailable') status = t('Для этой сборки проверка обновлений недоступна.', 'Update checks are unavailable for this build.');
    if (state.result.status === 'error') status = t('Не удалось проверить обновления.', 'Could not check for updates.');
  }
  return <fieldset className="settings-section update-settings">
    <legend>{t('Обновления', 'Updates')}</legend>
    <div className="update-settings-bar">
      <span>{t('Текущая версия', 'Current version')} <b>v{__APP_VERSION__}</b></span>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void check()}>
        <RefreshCw size={14} className={phase === 'checking' ? 'spin' : undefined} aria-hidden="true" />
        {t('Проверить обновления', 'Check for updates')}
      </button>
    </div>
    {release && <p>{t(`Доступна версия v${release.version}.`, `Version v${release.version} is available.`)}</p>}
    {status && <p role="status">{status}</p>}
    {state.phase === 'downloading' && <progress max={100} value={state.progress}
      aria-label={t('Загрузка обновления', 'Update download progress')} />}
    {release && canDownload && <div className="update-settings-actions">
      {desktop ? <button type="button" className="button primary" onClick={() => void download(release)}>
        {release.mode === 'install' ? <ArrowDownToLine size={15} /> : <ArrowUpRight size={15} />}
        {release.mode === 'install' ? t('Обновить', 'Update') : t('Открыть релиз', 'Open release')}
      </button> : <a className="button primary" href={release.webArchiveUrl ?? release.releaseUrl} target="_blank" rel="noreferrer">
        <ArrowDownToLine size={15} aria-hidden="true" />
        {release.webArchiveUrl ? t('Скачать веб-архив', 'Download web archive') : t('Открыть релиз', 'Open release')}
      </a>}
      {release.mode === 'release' && <span>{desktop
        ? t('Установи пакет со страницы релиза.', 'Install the package from the release page.')
        : t('Веб-версию обновляет администратор сервера.', 'The server administrator updates the web version.')}</span>}
    </div>}
    {release && canInstall && <div className="update-settings-actions">
      <button type="button" className="button primary" disabled={restartBlocked} onClick={() => void install(release)}>
        {t('Перезапустить и установить', 'Restart and install')}
      </button>
      {restartBlocked && <span>{t('Дождись завершения текущей операции.', 'Wait for the current operation to finish.')}</span>}
    </div>}
  </fieldset>;
}
