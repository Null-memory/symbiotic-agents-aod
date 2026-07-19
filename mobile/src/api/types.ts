export type MobileConnection = {
  baseUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
};

export type MobileState = {
  workspace?: string;
  activeWorkspaceId?: string;
  mode?: string;
  maxConcurrency?: number;
  runtime?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  runs: any[];
  tasks: any[];
  groups: any[];
  groupSessions: any[];
  approvals: any[];
  reviews: any[];
  events: any[];
};

export type StreamEvent = {
  id?: number;
  type: string;
  data: any;
};
