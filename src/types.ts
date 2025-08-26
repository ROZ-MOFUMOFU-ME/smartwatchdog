// サーバーステータス情報
export interface ServerStatus {
  status: string;
  lastUpdate: string;
}

// KV保存用データ
export interface KVStatusData {
  statuses: Record<string, ServerStatus>;
}

// Cloudflare Workers用の環境変数型
export interface Env {
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  SPREADSHEET_ID: string;
  DISCORD_WEBHOOK_URL: string;
  STATUS_KV: KVNamespace;
  DISCORD_MENTION_ROLE_ID?: string;
  RANGE: string;
  HTTP_TIMEOUT_MS?: string; // HTTPフェッチタイムアウト(ms)
  TCP_TIMEOUT_MS?: string; // TCP接続タイムアウト(ms)
  CHECK_CONCURRENCY?: string; // 同時並列数(0以下で無制限)
  PER_REQUEST_DELAY_MS?: string; // 各監視リクエスト間ディレイ(ms)
  HTTP_RETRY_MAX?: string; // HTTPリトライ最大回数
  HTTP_RETRY_BASE_DELAY_MS?: string; // HTTPリトライ基底ディレイ
  HTTP_RETRY_MAX_DELAY_MS?: string; // HTTPリトライ最大ディレイ
  HTTP_RETRY_JITTER_MS?: string; // HTTPリトライジッター(0で無し)
  TCP_RETRY_MAX?: string; // TCPリトライ最大回数
  TCP_RETRY_BASE_DELAY_MS?: string; // TCPリトライ基底ディレイ
  TCP_RETRY_MAX_DELAY_MS?: string; // TCPリトライ最大ディレイ
  TCP_RETRY_JITTER_MS?: string; // TCPリトライジッター
  ALERT_SUPPRESS_THRESHOLD?: string; // 連続失敗何回目以降でDiscord通知抑制
  ALERT_SUPPRESS_INTERVAL_MINUTES?: string; // 抑制後の再通知間隔(分)
}
