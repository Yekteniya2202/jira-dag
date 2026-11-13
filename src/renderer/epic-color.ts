import type { CSSProperties } from 'react';
import type { JiraIssue } from '../shared/contracts';
import { epicColorHex } from '../shared/jira-epic-color';
import './epic-color.css';

export function epicColorStyle(value?: string): CSSProperties | undefined {
  const color = epicColorHex(value);
  if (!color) return;
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return { '--jira-epic-color': color, '--jira-epic-ink': luminance > 0.179 ? '#000000' : '#FFFFFF' } as CSSProperties;
}

export function epicColors(issues: readonly JiraIssue[]): Map<string, string> {
  const colors = new Map<string, string>();
  for (const issue of issues) {
    const key = issue.isEpic ? issue.key : issue.epicKey;
    const color = epicColorHex(issue.epicColor);
    if (key && color && (key === issue.key || !colors.has(key))) colors.set(key, color);
  }
  return colors;
}
