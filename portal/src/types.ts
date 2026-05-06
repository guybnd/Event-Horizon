export interface HistoryEntry {
  type: 'status_change' | 'comment';
  from?: string;
  to?: string;
  user: string;
  date: string;
  comment?: string;
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

export interface Config {
  columns: StatusDef[];
  hiddenStatuses: StatusDef[];
  projects: string[];
  users: UserDef[];
  tags: TagDef[];
  enableBacklogScreen: boolean;
  requireCommentOnStatusChange: boolean;
}
