export type JiraEdition = 'cloud' | 'data-center';

export interface JiraCredentials {
  edition: JiraEdition;
  url: string;
  username: string;
  email: string;
  token: string;
  scopedToken?: boolean;
}

export interface JiraConnection {
  url: string;
  displayName: string;
  rememberFailed?: true;
}

export type JiraLogin = JiraCredentials & { remember?: boolean };

export interface RestoredJiraConnection {
  connection: JiraConnection;
  edition: JiraEdition;
}

export interface GraphQuery {
  jql: string;
  depth: number;
  storyPointsField?: string;
}

export interface JiraSprint {
  id: string;
  name: string;
  state?: 'future' | 'active' | 'closed';
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType?: string;
  assignee?: string;
  project?: string;
  storyPoints?: number;
  description?: string;
  descriptionMarkdown?: string;
  descriptionReadOnly?: true;
  url: string;
  external?: boolean;
  labels?: string[];
  parentKey?: string;
  epicKey?: string;
  isEpic?: boolean;
  isSubtask?: boolean;
  priority?: string;
  sprints?: string[];
  sprintDetails?: JiraSprint[];
  fixVersions?: string[];
  dueDate?: string;
  originalEstimateSeconds?: number;
  remainingEstimateSeconds?: number;
}

export interface JiraSavedFilter {
  id: string;
  name: string;
  jql?: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueSuggestion {
  key: string;
  summary: string;
}

export interface JiraGraphNote {
  id: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface JiraLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface JiraEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: 'link' | 'parent';
  typeId?: string;
}

export interface JiraOption {
  id: string;
  name: string;
}

export interface JiraGraph {
  issues: JiraIssue[];
  edges: JiraEdge[];
  linkTypes: JiraLinkType[];
  storyPointsFields: JiraOption[];
  warnings: string[];
}

export interface JiraCreateField {
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
  schemaType?: string;
  options?: JiraOption[];
}

export interface JiraCreateOptions {
  issueTypes: JiraOption[];
  fields: JiraCreateField[];
}

export interface JiraIssueInput {
  projectKey: string;
  typeId: string;
  summary: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface JiraLinkInput {
  source: string;
  target: string;
  typeId: string;
}

export interface ApiMethods {
  connect: { input: JiraLogin; output: JiraConnection };
  disconnect: { input: null; output: null };
  loadGraph: { input: GraphQuery; output: JiraGraph };
  getCreateOptions: { input: { projectKey: string; issueTypeId?: string }; output: JiraCreateOptions };
  createIssue: { input: JiraIssueInput; output: JiraIssue };
  updateIssue: {
    input: { key: string; summary: string; description?: string };
    output: JiraIssue;
  };
  createLink: { input: JiraLinkInput; output: JiraEdge | null };
  deleteLink: { input: { id: string }; output: null };
  listProjects: { input: null; output: JiraProject[] };
  suggestIssues: { input: { query: string }; output: JiraIssueSuggestion[] };
  getAssigneeAvatar: { input: { key: string }; output: string | null };
  listSavedFilters: { input: null; output: JiraSavedFilter[] };
  listGraphNotes: { input: { keys: string[] }; output: Record<string, JiraGraphNote[]> };
  listNotes: { input: { key: string }; output: JiraGraphNote[] };
  createNote: { input: { key: string; text: string }; output: JiraGraphNote };
  deleteNote: { input: { key: string; id: string }; output: null };
}

export type ApiMethod = keyof ApiMethods;
export type ApiRequest = {
  [Method in ApiMethod]: { method: Method; input: ApiMethods[Method]['input'] };
}[ApiMethod];
export type ApiResponse<Result = unknown> =
  | { ok: true; data: Result }
  | { ok: false; error: string; status?: number };
