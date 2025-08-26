import type { Env, ServerStatus } from './types';
import { getGoogleAccessToken } from './utils/google_jwt';
import {
  fetchAllSheets,
  fetchSheetRows,
  sendDiscordWebhook,
} from './utils/sheets_fetch';
import { generateCurrentStatuses } from './utils/status';

function buildSheetUrlWithRange(
  spreadsheetId: string,
  sheetId: number,
  rowIndex: number
) {
  // rowIndex: 0始まりなので+2（1行目はヘッダ、2行目がrowIndex=0）
  const sheetRow = rowIndex + 2;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=${sheetRow}:${sheetRow}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const {
        GOOGLE_CLIENT_EMAIL,
        GOOGLE_PRIVATE_KEY,
        SPREADSHEET_ID,
        RANGE,
        DISCORD_WEBHOOK_URL,
        DISCORD_MENTION_ROLE_ID,
        STATUS_KV,
        HTTP_TIMEOUT_MS,
        TCP_TIMEOUT_MS,
        CHECK_CONCURRENCY,
        PER_REQUEST_DELAY_MS,
        HTTP_RETRY_MAX,
        HTTP_RETRY_BASE_DELAY_MS,
        HTTP_RETRY_MAX_DELAY_MS,
        HTTP_RETRY_JITTER_MS,
      } = env;

      // 必須環境変数のチェック
      if (
        !GOOGLE_CLIENT_EMAIL ||
        !GOOGLE_PRIVATE_KEY ||
        !SPREADSHEET_ID ||
        !DISCORD_WEBHOOK_URL
      ) {
        throw new Error('Missing required environment variables');
      }

      // 秘密鍵の改行を正しく処理
      const fixedPrivateKey = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

      const sheets = await fetchAllSheets(
        GOOGLE_CLIENT_EMAIL,
        fixedPrivateKey,
        SPREADSHEET_ID
      );

      // クエリパラメータでoffset/limitを指定可能に
      const url = new URL(request.url);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);

      let allChangedRows: {
        row: string[];
        rowIndex: number;
        statusObj: ServerStatus;
      }[] = [];

      // 環境変数からタイムアウト設定（無効値は無視）
      const httpTimeoutMs = (() => {
        const v = parseInt(HTTP_TIMEOUT_MS || '', 10);
        return Number.isFinite(v) && v > 0 ? v : undefined;
      })();
      const tcpTimeoutMs = (() => {
        const v = parseInt(TCP_TIMEOUT_MS || '', 10);
        return Number.isFinite(v) && v > 0 ? v : undefined;
      })();
      const checkConcurrency = (() => {
        const v = parseInt(CHECK_CONCURRENCY || '', 10);
        return Number.isFinite(v) && v > 0 ? v : undefined;
      })();
      const perRequestDelayMs = (() => {
        const v = parseInt(PER_REQUEST_DELAY_MS || '', 10);
        return Number.isFinite(v) && v >= 0 ? v : undefined;
      })();
      const retryMax = (() => {
        const v = parseInt(HTTP_RETRY_MAX || '', 10);
        return Number.isFinite(v) && v >= 0 ? v : undefined;
      })();
      const retryBaseDelay = (() => {
        const v = parseInt(HTTP_RETRY_BASE_DELAY_MS || '', 10);
        return Number.isFinite(v) && v >= 0 ? v : undefined;
      })();
      const retryMaxDelay = (() => {
        const v = parseInt(HTTP_RETRY_MAX_DELAY_MS || '', 10);
        return Number.isFinite(v) && v >= 0 ? v : undefined;
      })();
      const retryJitter = (() => {
        const v = parseInt(HTTP_RETRY_JITTER_MS || '', 10);
        return Number.isFinite(v) && v >= 0 ? v : undefined;
      })();
      // 連続失敗通知抑制関連（設定はオプション）
      const suppressThreshold = (() => {
        const v = parseInt(env.ALERT_SUPPRESS_THRESHOLD || '', 10);
        return Number.isFinite(v) && v > 0 ? v : undefined;
      })();
      const suppressIntervalMinutes = (() => {
        const v = parseInt(env.ALERT_SUPPRESS_INTERVAL_MINUTES || '', 10);
        return Number.isFinite(v) && v > 0 ? v : 30; // デフォルト30分
      })();

      for (const sheet of sheets) {
        const kvKey = `${SPREADSHEET_ID}-${sheet.sheetId}`;

        // 1. シートごとに全行取得
        const rows = await fetchSheetRows(
          GOOGLE_CLIENT_EMAIL,
          fixedPrivateKey,
          SPREADSHEET_ID,
          `${sheet.title}!${RANGE}`
        );

        // 2. KVから前回の状態を取得
        const prevStatusesRaw = await STATUS_KV.get(kvKey);
        // KV保存形式: 旧 {key: ServerStatus} / 新 { statuses: {...}, failureMeta: {...} }
        type FailureMetaEntry = { consecutive: number; lastNotify?: number };
        type FailureMeta = Record<string, FailureMetaEntry>;
        interface PersistedStatusData {
          statuses: Record<string, ServerStatus>;
          failureMeta?: FailureMeta;
        }
        const isPersistedStatusData = (
          v: unknown
        ): v is PersistedStatusData => {
          return (
            typeof v === 'object' &&
            v !== null &&
            'statuses' in v &&
            typeof (v as { statuses?: unknown }).statuses === 'object'
          );
        };

        let parsed: unknown = {};
        try {
          parsed = prevStatusesRaw ? JSON.parse(prevStatusesRaw) : {};
        } catch {
          parsed = {};
        }
        const prevStatuses: Record<string, ServerStatus> =
          isPersistedStatusData(parsed)
            ? parsed.statuses
            : (parsed as Record<string, ServerStatus>);
        const failureMeta: FailureMeta =
          isPersistedStatusData(parsed) && parsed.failureMeta
            ? parsed.failureMeta
            : {};

        // 3. 監視対象を抽出
        const targets: { rowIndex: number; row: string[] }[] = [];
        rows.forEach((row, rowIndex) => {
          if (row[1]) {
            targets.push({ rowIndex, row });
          }
        });

        const chunk = targets.slice(offset, offset + limit);

        // 4. chunk内の監視fetch
        const changedRows: {
          row: string[];
          rowIndex: number;
          statusObj: ServerStatus;
        }[] = [];
        const newStatuses: Record<string, ServerStatus> = { ...prevStatuses };
        const newFailureMeta: typeof failureMeta = { ...failureMeta };
        await Promise.all(
          chunk.map(async ({ row, rowIndex }) => {
            const { currentStatuses } = await generateCurrentStatuses([row], {
              httpTimeoutMs,
              tcpTimeoutMs,
              concurrency: checkConcurrency,
              perRequestDelayMs,
              retry: {
                maxRetries: retryMax,
                baseDelayMs: retryBaseDelay,
                maxDelayMs: retryMaxDelay,
                jitterMs: retryJitter,
              },
            });
            const key = row[0] || row[1];
            const statusObj = currentStatuses[key];
            if (!statusObj) return;
            const prev = prevStatuses[key];
            // 前回とstatusが違う場合のみ通知・更新
            const isError = statusObj.status.startsWith('ERROR');
            // 連続失敗カウンタ更新
            if (isError) {
              const meta = newFailureMeta[key] || { consecutive: 0 };
              meta.consecutive += 1; // 初回失敗も1
              newFailureMeta[key] = meta;
            } else {
              // 成功でカウンタリセット
              if (newFailureMeta[key]) newFailureMeta[key].consecutive = 0;
            }
            // 通知対象判定
            let notify = false;
            if (!prev || prev.status !== statusObj.status) {
              // 状態変化は常に通知候補
              notify = true;
            } else if (isError && suppressThreshold && newFailureMeta[key]) {
              const { consecutive, lastNotify } = newFailureMeta[key];
              if (consecutive >= suppressThreshold) {
                // 最終通知から間隔経過で再通知
                const nowMs = Date.now();
                if (
                  !lastNotify ||
                  nowMs - lastNotify > suppressIntervalMinutes * 60 * 1000
                ) {
                  notify = true;
                }
              }
            }
            if (notify) {
              if (isError) {
                // 最終通知時刻更新
                const meta = newFailureMeta[key] || { consecutive: 1 };
                meta.lastNotify = Date.now();
                newFailureMeta[key] = meta;
              }
              changedRows.push({ row, rowIndex, statusObj });
            }
            // 最新状態を保存
            newStatuses[key] = statusObj;
          })
        );

        // Discord通知・batchUpdateは変化があった行のみ
        await Promise.all(
          changedRows.map(async ({ row, rowIndex, statusObj }) => {
            const isError = statusObj.status.startsWith('ERROR');
            const sheetUrl = buildSheetUrlWithRange(
              SPREADSHEET_ID,
              sheet.sheetId,
              rowIndex
            );
            const embed = {
              title: isError
                ? `:rotating_light: Server health check failure - ${sheet.title || 'Unknown Sheet'}`
                : `:white_check_mark: Server Recovered - ${sheet.title || 'Unknown Sheet'}`,
              color: isError ? 0xff0000 : 0x00ff00,
              description: '',
              fields: [
                {
                  name: 'Server Name',
                  value: row[0] || 'N/A',
                  inline: true,
                },
                {
                  name: 'Server URL',
                  value: row[1] ? `${row[1]}` : 'N/A',
                  inline: true,
                },
                {
                  name: '\u200B',
                  value: '\u200B',
                  inline: true,
                },
                {
                  name: 'Status',
                  value: `${isError ? '🔴' : '🟢'} ${statusObj.status}`,
                  inline: true,
                },
                {
                  name: 'Last Updated',
                  value: statusObj.lastUpdate,
                  inline: true,
                },
                {
                  name: '\u200B',
                  value: '\u200B',
                  inline: true,
                },
                {
                  name: '\u200B',
                  value: `[📊 View in Google Sheets](${sheetUrl})`,
                  inline: false,
                },
              ],
              timestamp: new Date().toISOString(),
            };
            const content =
              isError && DISCORD_MENTION_ROLE_ID
                ? `<@&${DISCORD_MENTION_ROLE_ID}>`
                : '';
            await sendDiscordWebhook(DISCORD_WEBHOOK_URL, content, embed);
          })
        );

        // batchUpdateも変化があった行のみ
        const updatesBySheet: { range: string; values: [string, string] }[] =
          [];
        changedRows.forEach(({ rowIndex, statusObj }) => {
          updatesBySheet.push({
            range: `${sheet.title}!C${rowIndex + 2}:D${rowIndex + 2}`,
            values: [statusObj.status, statusObj.lastUpdate],
          });
        });
        const scope = 'https://www.googleapis.com/auth/spreadsheets';
        const accessToken = await getGoogleAccessToken(
          GOOGLE_CLIENT_EMAIL,
          fixedPrivateKey,
          scope
        );
        if (updatesBySheet.length > 0) {
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
          const body = {
            valueInputOption: 'USER_ENTERED',
            data: updatesBySheet.map((u) => ({
              range: u.range,
              values: [u.values],
            })),
          };
          await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          });
        }

        // 変化があった行のうち、エラー/OKで色分け
        const formatRequests: {
          repeatCell: {
            range: {
              sheetId: number;
              startRowIndex: number;
              endRowIndex: number;
              startColumnIndex: number;
              endColumnIndex: number;
            };
            cell: object;
            fields: string;
          };
        }[] = [];
        changedRows.forEach(({ rowIndex, statusObj }) => {
          const isOk = statusObj.status.startsWith('OK');
          formatRequests.push({
            repeatCell: {
              range: {
                sheetId: sheet.sheetId,
                startRowIndex: rowIndex + 1,
                endRowIndex: rowIndex + 2,
                startColumnIndex: 2, // C列
                endColumnIndex: 3,
              },
              cell: isOk
                ? { userEnteredFormat: {} }
                : {
                    userEnteredFormat: {
                      backgroundColor: { red: 1, green: 0.8, blue: 0.8 },
                    },
                  },
              fields: 'userEnteredFormat',
            },
          });
        });
        // batchUpdateで書式リクエストを送信
        if (formatRequests.length > 0) {
          const formatUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;
          const formatBody = { requests: formatRequests };
          await fetch(formatUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(formatBody),
          });
        }

        // シートごとにKVへ最新状態を保存
        await STATUS_KV.put(
          kvKey,
          JSON.stringify({ statuses: newStatuses, failureMeta: newFailureMeta })
        );
        allChangedRows = allChangedRows.concat(changedRows);
      }

      return new Response(
        JSON.stringify({
          message: 'Server health check complete',
          results: allChangedRows,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (e) {
      console.error('Worker error:', e);
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // 定期実行時もfetchと同じ監視処理を実行
    // fetchと同じエンドポイントロジックを呼び出す
    const req = new Request('https://dummy-cron-trigger');
    await this.fetch(req, env);
  },
};
