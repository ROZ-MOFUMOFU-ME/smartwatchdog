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
  // 自己宛サービスバインディング。scheduledでシートごとに子invocationへファンアウトする
  SELF?: Fetcher;
  // 子invocation1回あたりの監視上限（既定45。subrequest上限50に対する余裕分）
  FANOUT_LIMIT?: string;
}
