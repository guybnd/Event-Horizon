export interface Task {
  id: string;
  status: string;
  assignee?: string;
  tags?: string[];
  title?: string;
  body?: string;
}

export interface Config {
  columns: string[];
  hiddenStatuses: string[];
}
