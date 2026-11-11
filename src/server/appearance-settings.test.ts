import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultAppearance, fontStack, paletteTheme, palettes, readAppearance } from '../renderer/appearance.js';
import { fontOptions } from '../renderer/font-catalog.js';

test('appearance migrates the original light and dark choices', () => {
  assert.deepEqual(readAppearance(null, 'light'), { ...defaultAppearance, palette: 'light' });
  assert.deepEqual(readAppearance(null, 'dark'), defaultAppearance);
  assert.deepEqual(readAppearance(null, null), defaultAppearance);
});

test('appearance restores all palettes and independent graph fonts after serialization', () => {
  for (const { id, theme } of palettes) {
    const saved = { palette: id, font: 'roboto', graphFont: 'pt-serif' };
    assert.deepEqual(readAppearance(JSON.stringify(saved), 'dark'), saved);
    assert.equal(paletteTheme(id), theme);
  }
  for (const { id, stack } of fontOptions) {
    assert.equal(fontStack(id), stack);
    const linked = { palette: 'dark', font: id, graphFont: 'inherit' };
    assert.deepEqual(readAppearance(JSON.stringify(linked), null), linked);
  }
});

test('appearance recovers valid settings from missing or unknown fields', () => {
  const raw = JSON.stringify({ palette: 'custom', font: 'ibm-plex-mono', graphFont: ['invalid'] });
  assert.deepEqual(readAppearance(raw, 'light'), { palette: 'light', font: 'ibm-plex-mono', graphFont: 'inherit' });
  assert.deepEqual(readAppearance('null', null), defaultAppearance);
  assert.deepEqual(readAppearance('{bad JSON}', null), defaultAppearance);
});
