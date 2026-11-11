const sans = (family: string) => `"${family}", "Segoe UI", system-ui, sans-serif`;
const serif = (family: string) => `"${family}", Georgia, serif`;

export const fontOptions = [
  { id: 'inter', label: 'Inter', stack: sans('Inter Variable'), kind: 'sans' },
  { id: 'roboto', label: 'Roboto', stack: sans('Roboto Variable'), kind: 'sans' },
  { id: 'source-sans-3', label: 'Source Sans 3', stack: sans('Source Sans 3 Variable'), kind: 'sans' },
  { id: 'nunito', label: 'Nunito', stack: sans('Nunito Variable'), kind: 'sans' },
  { id: 'mulish', label: 'Mulish', stack: sans('Mulish Variable'), kind: 'sans' },
  { id: 'rubik', label: 'Rubik', stack: sans('Rubik Variable'), kind: 'sans' },
  { id: 'system', label: 'System UI', stack: 'system-ui, "Segoe UI", sans-serif', kind: 'sans' },
  { id: 'pt-serif', label: 'PT Serif', stack: serif('PT Serif'), kind: 'serif' },
  { id: 'playfair-display', label: 'Playfair Display', stack: serif('Playfair Display Variable'), kind: 'serif' },
  { id: 'spectral', label: 'Spectral', stack: serif('Spectral'), kind: 'serif' },
  { id: 'cormorant-garamond', label: 'Cormorant Garamond', stack: serif('Cormorant Garamond Variable'), kind: 'serif' },
  { id: 'stix-two-text', label: 'STIX Two Text', stack: serif('STIX Two Text Variable'), kind: 'serif' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', stack: '"IBM Plex Mono", Consolas, monospace', kind: 'mono' },
] as const;

export type FontId = typeof fontOptions[number]['id'];
export const defaultFontId: FontId = 'inter';
