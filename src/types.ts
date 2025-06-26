// Server status information
export interface ServerStatus {
  status: string;
  lastUpdate: string;
}

// S3保存用データ
export interface S3StatusData {
  sheetUrl: string;
  statuses: Record<string, ServerStatus>;
}

// Slack通知用データ
export interface SlackStatusData {
  serverName?: string;
  serverUrl?: string;
  status: string;
  lastUpdate?: string;
  sheetUrl?: string;
}

// Slack通知タイプ
export type SlackNotificationType = 'error' | 'recovery';

// シート更新結果
export interface SheetUpdateResult {
  index: number;
  serverName?: string;
  serverUrl?: string;
  status?: string;
  color?: 'white' | 'red';
  lastUpdate?: string;
  deleteColumns?: boolean;
  needsUpdate?: boolean;
}
