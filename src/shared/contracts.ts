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
  profileId?: string;
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
  qaPointsField?: string;
  epicKey?: string;
}

export interface JiraSprint {
  id: string;
  name: string;
  state?: 'future' | 'active' | 'closed';
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
  originBoardId?: string;
}

export interface JiraScrumBoard {
  id: string;
  name: string;
}

export interface JiraSprintScope {
  boardId: string;
  sprintId: string;
}

export interface JiraSprintEstimateFields {
  storyPointsField?: string;
  qaPointsField?: string;
}

export interface JiraSprintPlanQuery extends JiraSprintScope, JiraSprintEstimateFields {
  backlogJql?: string;
}

export interface JiraSprintPlan {
  sprint: JiraSprint;
  graph: JiraGraph;
  sprintIssueKeys: string[];
  backlogIssueKeys: string[];
  membershipComplete: boolean;
  backlogComplete: boolean;
  storyPointsField?: string;
  qaPointsField?: string;
}

export interface JiraSprintVelocitySample {
  sprint: JiraSprint;
  completedStoryPoints?: number;
  completedQaPoints?: number;
  completedIssues: number;
  evaluatedIssues: number;
  totalIssues: number;
  complete: boolean;
  storyPointsComplete?: boolean;
  qaPointsComplete?: boolean;
  peopleComplete?: boolean;
  people?: { id: string; name: string; storyPoints: number; qaPoints?: number; completedIssues: number }[];
}

export interface JiraSprintVelocity {
  samples: JiraSprintVelocitySample[];
  warnings: string[];
}

export interface JiraSprintMembershipInput extends JiraSprintScope {
  expectedIssueKeys: string[];
  addIssueKeys: string[];
  removeIssueKeys: string[];
}

export interface JiraSprintMembershipResult {
  added: string[];
  removed: string[];
  failed: { key: string; operation: 'add' | 'remove'; reason: string }[];
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory?: string;
  issueType?: string;
  assignee?: string;
  assigneeId?: string;
  project?: string;
  storyPoints?: number;
  qaPoints?: number;
  description?: string;
  descriptionMarkdown?: string;
  descriptionReadOnly?: true;
  url: string;
  external?: boolean;
  unloadedBlockerKeys?: string[];
  labels?: string[];
  parentKey?: string;
  parentSummary?: string;
  epicKey?: string;
  epicSummary?: string;
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

export interface JiraTeamMember {
  id: string;
  name: string;
}

export interface JiraProjectTeam {
  members: JiraTeamMember[];
  limited?: true;
}

export interface JiraAvatarQuery {
  issueKeys?: string[];
  project?: string;
  memberIds?: string[];
  includeCurrentUser?: boolean;
}

export interface JiraAvatars {
  issues: Record<string, string>;
  members: Record<string, string>;
  currentUser?: string;
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

export interface JiraProjectFilterOptions {
  statuses: JiraOption[];
  issueTypes: JiraOption[];
  versions: JiraOption[];
  sprints: JiraSprint[];
  unavailable?: Array<'statuses' | 'issueTypes' | 'versions' | 'sprints'>;
}

export interface JiraGraph {
  issues: JiraIssue[];
  edges: JiraEdge[];
  linkTypes: JiraLinkType[];
  storyPointsFields: JiraOption[];
  qaPointsFields?: JiraOption[];
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
  getConnection: { input: null; output: RestoredJiraConnection | null };
  disconnect: { input: null; output: null };
  loadGraph: { input: GraphQuery; output: JiraGraph };
  listScrumBoards: { input: { project: string }; output: JiraScrumBoard[] };
  listBoardSprints: { input: { boardId: string }; output: JiraSprint[] };
  loadSprintPlan: { input: JiraSprintPlanQuery; output: JiraSprintPlan };
  loadSprintVelocity: { input: { boardId: string } & JiraSprintEstimateFields; output: JiraSprintVelocity };
  applySprintMembership: { input: JiraSprintMembershipInput; output: JiraSprintMembershipResult };
  getCreateOptions: { input: { projectKey: string; issueTypeId?: string }; output: JiraCreateOptions };
  createIssue: { input: JiraIssueInput; output: JiraIssue };
  updateIssue: {
    input: { key: string; summary: string; description?: string };
    output: JiraIssue;
  };
  createLink: { input: JiraLinkInput; output: JiraEdge | null };
  deleteLink: { input: { id: string }; output: null };
  listProjects: { input: null; output: JiraProject[] };
  listProjectTeam: { input: { project: string; query?: string }; output: JiraProjectTeam };
  getProjectFilterOptions: { input: { project: string }; output: JiraProjectFilterOptions };
  suggestIssues: { input: { query: string }; output: JiraIssueSuggestion[] };
  getAssigneeAvatar: { input: { key: string }; output: string | null };
  getAvatars: { input: JiraAvatarQuery; output: JiraAvatars };
  listSavedFilters: { input: null; output: JiraSavedFilter[] };
  listGraphNotes: { input: { keys: string[] }; output: Record<string, JiraGraphNote[]> };
  listNotes: { input: { key: string }; output: JiraGraphNote[] };
  createNote: { input: { key: string; text: string }; output: JiraGraphNote };
  updateNote: { input: { key: string; id: string; text: string }; output: JiraGraphNote };
  deleteNote: { input: { key: string; id: string }; output: null };
}

export type ApiMethod = keyof ApiMethods;
export type ApiRequest = {
  [Method in ApiMethod]: { method: Method; input: ApiMethods[Method]['input'] };
}[ApiMethod];
export type ApiResponse<Result = unknown> =
  | { ok: true; data: Result }
  | { ok: false; error: string; status?: number };
