// https://support.atlassian.com/jira/kb/use-epic-color-for-epics-in-jira-cloud/
const epicPalette = [
  ['dark_gray', '#243859'], ['dark_yellow', '#FA9920'], ['yellow', '#FAC304'], ['dark_blue', '#2A53CC'],
  ['dark_teal', '#2AA3BF'], ['green', '#58D8A4'], ['purple', '#8677D9'], ['dark_purple', '#5244AA'],
  ['orange', '#FA7353'], ['blue', '#3884FF'], ['teal', '#34C7E6'], ['gray', '#6B778C'],
  ['dark_green', '#128759'], ['dark_orange', '#DD350D'],
] as const;

// The legacy Agile API uses GreenHopper's color_N palette, separate from ghx-label-N.
// https://docs.atlassian.com/jira-software/6.6.13/constant-values.html
const legacyPalette = [
  '#FF800D', '#23819C', '#9669FE', '#59955C', '#B9264F', '#B05F3C', '#2966B8', '#9A03FE', '#FF2626', '#FF5353',
  '#C8B400', '#79FC4E', '#8C8CFF', '#C48484', '#4FBDDD', '#FFBE28', '#99C7FF', '#AE70ED', '#FFA8A8', '#DAAF85',
];

const colors = new Map<string, string>([
  ...epicPalette.flatMap(([name, hex], index): Array<[string, string]> => [[name, hex], [`ghx-label-${index + 1}`, hex]]),
  ...legacyPalette.map((hex, index): [string, string] => [`color_${index + 1}`, hex]),
]);

export function epicColorHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${Array.from(color.slice(1), (digit) => digit.repeat(2)).join('').toUpperCase()}`;
  const key = color.toLowerCase();
  return colors.get(key) ?? colors.get(key.replaceAll('grey', 'gray').replace(/[-\s]+/g, '_'));
}
