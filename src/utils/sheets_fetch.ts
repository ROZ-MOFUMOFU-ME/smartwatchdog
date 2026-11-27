import { getGoogleAccessToken } from './google_jwt';

// 全シートのIDとタイトルを取得
export async function fetchAllSheets(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
  kv?: KVNamespace
): Promise<{ sheetId: number; title: string }[]> {
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope,
    kv
  );
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('Google Sheets API error (get metadata):', text);
    throw new Error('Failed to fetch sheet metadata: ' + text);
  }
  const data = (await resp.json()) as {
    sheets: { properties: { sheetId: number; title: string } }[];
  };
  if (!data.sheets || data.sheets.length === 0) {
    throw new Error('No sheets found in spreadsheet');
  }
  return data.sheets.map((s) => ({
    sheetId: s.properties.sheetId,
    title: s.properties.title,
  }));
}

// 複数レンジの行を1回のvalues:batchGetでまとめて取得（サブリクエスト削減）
// 戻り値はrangesと同じ順序の二次元配列の配列。値が無いレンジは空配列。
export async function fetchSheetsRows(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
  ranges: string[],
  kv?: KVNamespace
): Promise<string[][][]> {
  if (ranges.length === 0) return [];
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope,
    kv
  );
  const query = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Failed to fetch sheet rows (batch): ' + text);
  }
  const data = (await resp.json()) as {
    valueRanges?: { values?: string[][] }[];
  };
  return ranges.map((_, i) => data.valueRanges?.[i]?.values || []);
}

// Discord Webhook への送信に失敗したときのエラー。
// retryable は、次の監視で送り直せば届く見込みがあるか（回数制限・Discord側の障害・通信エラー）
export class DiscordWebhookError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'DiscordWebhookError';
    this.retryable = retryable;
  }
}

// Discord Webhook通知ユーティリティ。2xx 以外は失敗として DiscordWebhookError を投げる
export async function sendDiscordWebhook(
  webhookUrl: string,
  content: string,
  embed?: Record<string, unknown>
) {
  const body: Record<string, unknown> = { content };
  if (embed) body.embeds = [embed];
  let resp: Response;
  try {
    resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DiscordWebhookError(
      `Discord webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }
  if (resp.ok) {
    // レスポンスbodyを読まないと接続が開いたままになり、同時実行が上限に達して
    // "stalled HTTP response was canceled" を誘発する。使わないのでcancelする。
    await resp.body?.cancel();
    return;
  }
  const text = await resp.text().catch(() => '');
  throw new DiscordWebhookError(
    `Discord webhook returned HTTP ${resp.status}: ${text}`,
    resp.status === 429 || resp.status >= 500
  );
}
