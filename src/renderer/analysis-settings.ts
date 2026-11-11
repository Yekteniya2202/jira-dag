export type AnalysisSettings = {
  capacity: string;
  people: { id: string; name: string; capacity: string }[];
  strategy?: 'unblock' | 'priority' | 'fit';
};

export const defaultAnalysisSettings: AnalysisSettings = { capacity: '', people: [] };
