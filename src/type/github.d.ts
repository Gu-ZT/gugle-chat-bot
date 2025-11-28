export interface User {
  avatar_url?: string;
  deleted?: boolean;
  email?: string;
  html_url?: string;
  id: number;
  login: string;
  name?: string;
  type?: 'Bot' | 'User' | 'Organization';
}

export interface Label {
  color?: string;
  name?: string;
  description?: string;
}

export interface Issue {
  title: string | number;
  number: number;
  body: string;
  assignee?: User;
  state?: string;
  state_reason?: string;
  milestone?: string | number;
  labels: Label[];
  assignees: User[];
  type: string;
  user: User;
}

export interface Organization {
  id: number;
  login: string;
  description: string;
  avatar_url: string;
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  html_url: string;
}

export interface Milestone {
  closed_at?: string;
  closed_issues: number;
  created_at: string;
  creator?: User;
  description?: string;
  due_on?: string;
  html_url: string;
  labels_url: string;
  node_id: string;
  number: string;
  open_issues: number;
  state: 'open' | 'closed';
  title: string;
  updated_at: string;
  url: string;
}

export interface TypeOfIssue {
  id: number;
  name: string;
  description?: string;
  color?: string;
  created_at?: string;
  updated_at?: string;
  is_enabled?: boolean;
}

export interface IssueEvent {
  issue: Issue;
  organization?: Organization;
  repository: Repository;
  sender: User;
}

export type AssignedIssueEvent = IssueEvent & {
  action: 'assigned';
  assignee?: User;
};

export type ClosedIssueEvent = IssueEvent & {
  action: 'closed';
};

export type DeletedIssueEvent = IssueEvent & {
  action: 'deleted';
};

export type DemilestonedIssueEvent = IssueEvent & {
  action: 'demilestoned';
  milestone: Milestone;
};

export type EditedIssueEvent = IssueEvent & {
  action: 'edited';
  changes: {
    body?: {
      from: string;
    };
    title?: {
      from: string;
    };
  };
};

export type LabeledIssueEvent = IssueEvent & {
  action: 'labeled';
  label: Label;
};

export type LockedIssueEvent = IssueEvent & {
  action: 'locked';
};

export type MilestonedIssueEvent = IssueEvent & {
  action: 'milestoned';
  milestone: Milestone;
};

export type OpenedIssueEvent = IssueEvent & {
  action: 'opened';
  changes?: {
    old_issue: Issue;
    old_repository: Repository;
  };
};

export type PinnedIssueEvent = IssueEvent & {
  action: 'pinned';
};

export type ReopenedIssueEvent = IssueEvent & {
  action: 'reopened';
};

export type TransferredIssueEvent = IssueEvent & {
  action: 'transferred';
  changes: {
    new_issue: Issue;
    new_repository: Repository;
  };
};

export type TypedIssueEvent = IssueEvent & {
  action: 'typed';
  type: TypeOfIssue;
};

export type UnassignedIssueEvent = IssueEvent & {
  action: 'unassigned';
  assignee?: User;
};

export type UnlabeledIssueEvent = IssueEvent & {
  action: 'unlabeled';
  label?: Label;
};

export type UnpinnedIssueEvent = IssueEvent & {
  action: 'unpinned';
};

export type UntypedIssueEvent = IssueEvent & {
  action: 'untyped';
  type: TypeOfIssue;
};

export type AllIssueEvent =
  | AssignedIssueEvent
  | ClosedIssueEvent
  | DeletedIssueEvent
  | DemilestonedIssueEvent
  | EditedIssueEvent
  | LabeledIssueEvent
  | LockedIssueEvent
  | MilestonedIssueEvent
  | OpenedIssueEvent
  | PinnedIssueEvent
  | ReopenedIssueEvent
  | TransferredIssueEvent
  | TypedIssueEvent
  | UnassignedIssueEvent
  | UnlabeledIssueEvent
  | UnpinnedIssueEvent
  | UntypedIssueEvent;
