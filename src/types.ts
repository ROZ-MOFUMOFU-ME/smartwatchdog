// サーバーステータス情報
export interface ServerStatus {
  status: string;
  lastUpdate: string;
  // OKの行が連続で失敗している回数（障害として確定する前の保留中のみ）
  failCount?: number;
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
  // 子invocation1回あたりの監視上限（既定40。subrequest上限50に対し
  // batchGet/書き込み/Discord通知のオーバーヘッド分の余裕を残す。子モードはmetadataを省略）
  FANOUT_LIMIT?: string;
  // HTTPアクセス（手動実行）に必要なトークン。設定すると Authorization: Bearer <token> が必須になる。
  // 未設定なら従来どおり誰でも実行できる。シートごとの子invocationにも同じトークンを付けて呼ぶ
  TRIGGER_TOKEN?: string;
  // 何回連続で失敗したら障害として通知するか（既定2。1にすると1回の失敗ですぐ通知）
  FAIL_THRESHOLD?: string;
}
