export interface HistoryEntry {
  type: 'status_change' | 'comment' | 'activity';
  from?: string;
  to?: string;
  user: string;
  date: string;
  comment?: string;
  id?: string;
  replyTo?: string;
}

export interface Task {
  id: string;
  status: string;
  assignee?: string;
  tags?: string[];
  title?: string;
  body?: string;
  history?: HistoryEntry[];
  createdBy?: string;
  updatedBy?: string;
  order?: number;
  priority?: string;
  effort?: string;
  implementationLink?: string;
  subtasks?: string[];
}

export interface TaskLiveEvent {
  kind: 'created' | 'moved' | 'updated';
  sequence: number;
  at: number;
  fromStatus?: string;
  toStatus?: string;
}

export interface ColumnLiveEvent {
  kind: 'created' | 'received';
  sequence: number;
  at: number;
  taskId: string;
}

export interface TagDef {
  name: string;
  color: string;
  originalName?: string;
}

export interface StatusDef {
  name: string;
  color?: string;
  originalName?: string;
}

export interface UserDef {
  name: string;
  avatar?: string;
  originalName?: string;
}

export interface PriorityDef {
  name: string;
  color: string;
  icon?: string;
  originalName?: string;
}

export type BoardCardOpenMode = 'popup' | 'full';

export type DocsEditPermissions = 'all' | 'specified';

export interface Doc {
  path: string;
  title: string;
  body: string;
  slug: string;
  directory: string;
  order?: number;
}

export interface Config {
  columns: StatusDef[];
  hiddenStatuses: StatusDef[];
  users: UserDef[];
  tags: TagDef[];
  priorities: PriorityDef[];
  projects: string[];
  enableBacklogScreen: boolean;
  requireCommentOnStatusChange: boolean;
  boardCardOpenMode?: BoardCardOpenMode;
  requireInputStatus?: string;
  readyForMergeStatus?: string;
  docsEditPermissions?: DocsEditPermissions;
  docsAllowedUsers?: string[];
}
