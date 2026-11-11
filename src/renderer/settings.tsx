import { useId, useState } from 'react';
import { Check, Settings } from 'lucide-react';
import { defaultAppearance, findFont, palettes } from './appearance';
import { Dialog } from './dialogs';
import { fontOptions } from './font-catalog';
import { usePreferences } from './i18n';
import { UpdateSettings, useAppUpdate } from './update-settings';
import './themes.css';
import './settings.css';

const fontKinds = [
  ['sans', 'Без засечек', 'Sans serif'],
  ['serif', 'С засечками', 'Serif'],
  ['mono', 'Моноширинные', 'Monospace'],
] as const;

export function SettingsButton({ restartBlocked }: { restartBlocked: boolean }) {
  const [open, setOpen] = useState(false);
  const update = useAppUpdate();
  const { t } = usePreferences();
  const label = t('Настройки', 'Settings');
  return <>
    <button type="button" className="button secondary settings-trigger" aria-label={label} title={label} aria-haspopup="dialog"
      onClick={() => setOpen(true)}><Settings size={16} aria-hidden="true" /><span>{label}</span></button>
    {open && <SettingsDialog update={update} restartBlocked={restartBlocked} onClose={() => setOpen(false)} />}
  </>;
}

function SettingsDialog({ update, restartBlocked, onClose }: {
  update: ReturnType<typeof useAppUpdate>; restartBlocked: boolean; onClose(): void;
}) {
  const { appearance, language, t, setLanguage, updateAppearance, resetAppearance } = usePreferences();
  const name = useId();
  const custom = appearance.palette !== defaultAppearance.palette || appearance.font !== defaultAppearance.font ||
    appearance.graphFont !== defaultAppearance.graphFont;
  const fontGroups = fontKinds.map(([kind, ru, en]) => {
    const options = fontOptions.filter((font) => font.kind === kind);
    return options.length ? <optgroup key={kind} label={t(ru, en)}>
      {options.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
    </optgroup> : null;
  });
  return <Dialog title={t('Настройки', 'Settings')} onClose={onClose} className="settings-dialog">
    <div className="settings-content">
      <UpdateSettings update={update} restartBlocked={restartBlocked} />
      <fieldset className="settings-section">
        <legend>{t('Цветовая тема', 'Color theme')}</legend>
        {(['dark', 'light'] as const).map((theme) => <div className="settings-palette-group" key={theme}>
          <h3>{theme === 'dark' ? t('Тёмные', 'Dark') : t('Светлые', 'Light')}</h3>
          <div className="settings-palette-grid">
            {palettes.filter((palette) => palette.theme === theme).map(({ id, title }) => <label className="settings-palette" key={id}>
              <input type="radio" name={name} value={id} checked={appearance.palette === id}
                onChange={() => updateAppearance({ palette: id })} />
              <span className="settings-palette-preview" data-palette={id} aria-hidden="true">
                <i /><i /><i />
              </span>
              <span className="settings-palette-name">{t(title[0], title[1])}<Check size={14} aria-hidden="true" /></span>
            </label>)}
          </div>
        </div>)}
      </fieldset>
      <fieldset className="settings-section">
        <legend>{t('Шрифты и язык', 'Fonts and language')}</legend>
        <div className="settings-fields">
          <label>{t('Шрифт интерфейса', 'Interface font')}
            <select value={appearance.font} onChange={(event) => {
              const font = findFont(event.target.value);
              if (font) updateAppearance({ font: font.id });
            }}>{fontGroups}</select>
          </label>
          <label>{t('Шрифт графа', 'Graph font')}
            <select value={appearance.graphFont} onChange={(event) => {
              const value = event.target.value;
              if (value === 'inherit') updateAppearance({ graphFont: 'inherit' });
              else {
                const font = findFont(value);
                if (font) updateAppearance({ graphFont: font.id });
              }
            }}>
              <option value="inherit">{t('Как в интерфейсе', 'Same as interface')}</option>
              {fontGroups}
            </select>
          </label>
          <label>{t('Язык интерфейса', 'Interface language')}
            <select value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'ru')}>
              <option value="ru">Русский</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <div className="settings-preview" aria-label={t('Пример оформления графа', 'Graph appearance preview')}>
          <div className="settings-preview-card">
            <span>APP-42</span><strong>{t('Перевести чтение на новую схему', 'Switch reads to the new schema')}</strong>
          </div>
          <div className="settings-preview-link">
            <span>{t('блокирует', 'blocks')}</span>
          </div>
        </div>
      </fieldset>
    </div>
    <footer className="settings-footer">
      <button type="button" className="button secondary" disabled={!custom}
        onClick={resetAppearance}>{t('Сбросить оформление', 'Reset appearance')}</button>
      <button type="button" className="button primary" onClick={onClose}>{t('Готово', 'Done')}</button>
    </footer>
  </Dialog>;
}
