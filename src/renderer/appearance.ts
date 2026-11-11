import { defaultFontId, fontOptions, type FontId } from './font-catalog.js';

export const palettes = [
  { id: 'dark', theme: 'dark', title: ['Аметист', 'Amethyst'] },
  { id: 'graphite', theme: 'dark', title: ['Графит', 'Graphite'] },
  { id: 'midnight', theme: 'dark', title: ['Полночь', 'Midnight'] },
  { id: 'forest', theme: 'dark', title: ['Хвойная', 'Pine'] },
  { id: 'espresso', theme: 'dark', title: ['Эспрессо', 'Espresso'] },
  { id: 'aurora', theme: 'dark', title: ['Северное сияние', 'Aurora'] },
  { id: 'light', theme: 'light', title: ['Ирис', 'Iris'] },
  { id: 'paper', theme: 'light', title: ['Бумага', 'Paper'] },
  { id: 'frost', theme: 'light', title: ['Лёд', 'Glacier'] },
  { id: 'mint', theme: 'light', title: ['Мята', 'Mint'] },
  { id: 'rose', theme: 'light', title: ['Пудра', 'Rose'] },
  { id: 'contrast', theme: 'light', title: ['Высокий контраст', 'High contrast'] },
] as const;

export type PaletteId = typeof palettes[number]['id'];
export type Theme = typeof palettes[number]['theme'];
export type GraphFontId = FontId | 'inherit';

export interface Appearance {
  palette: PaletteId;
  font: FontId;
  graphFont: GraphFontId;
}

export const defaultAppearance: Appearance = { palette: 'dark', font: defaultFontId, graphFont: 'inherit' };
export const appearanceKey = 'jira-dag.appearance.v1';

export function findFont(value: unknown) {
  return fontOptions.find(({ id }) => id === value);
}

export function paletteTheme(id: PaletteId): Theme {
  return palettes.find((palette) => palette.id === id)?.theme ?? 'dark';
}

export function fontStack(id: FontId): string {
  return findFont(id)?.stack ?? "Inter, 'Segoe UI', sans-serif";
}

export function readAppearance(raw: string | null, legacyTheme: string | null): Appearance {
  const fallback: Appearance = { ...defaultAppearance, palette: legacyTheme === 'light' ? 'light' : 'dark' };
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return fallback;
    const saved = value as Partial<Record<keyof Appearance, unknown>>;
    return {
      palette: palettes.find(({ id }) => id === saved.palette)?.id ?? fallback.palette,
      font: findFont(saved.font)?.id ?? fallback.font,
      graphFont: findFont(saved.graphFont)?.id ?? 'inherit',
    };
  } catch { return fallback; }
}
