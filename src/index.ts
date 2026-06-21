import type { Env, ServerStatus } from './types';
import { getGoogleAccessToken } from './utils/google_jwt';
import {
  fetchAllSheets,
  fetchSheetsRows,
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

// 変化を検出した行（Discord通知・シート更新の対象）
type ChangedRow = {
  row: string[];
  rowIndex: number;
  statusObj: ServerStatus;
};

// 1シート分の監視処理。あらかじめ取得した行（rows）を受け取り、
// 変化があった行のみDiscord通知＋シート更新を行う。KVは毎回保存する。
async function processSheet(
  env: Env,
  fixedPrivateKey: string,
  sheet: { sheetId: number; title: string },
  rows: string[][],
  offset: number,
  limit: number
): Promise<ChangedRow[]> {
  const {
    GOOGLE_CLIENT_EMAIL,
    SPREADSHEET_ID,
    DISCORD_WEBHOOK_URL,
    DISCORD_MENTION_ROLE_ID,
    STATUS_KV,
  } = env;

  const kvKey = `${SPREADSHEET_ID}-${sheet.sheetId}`;

  // 1. KVから前回の状態を取得
  const prevStatusesRaw = await STATUS_KV.get(kvKey);
  const prevStatuses: Record<string, ServerStatus> = prevStatusesRaw
    ? JSON.parse(prevStatusesRaw)
    : {};

  // 2. 監視対象を抽出（URL列が空でない行のみ）
  const targets: { rowIndex: number; row: string[] }[] = [];
  rows.forEach((row, rowIndex) => {
    if (row[1]) {
      targets.push({ rowIndex, row });
    }
  });

  const chunk = targets.slice(offset, offset + limit);

  // 3. chunk内の監視fetch
  const changedRows: ChangedRow[] = [];
  const newStatuses: Record<string, ServerStatus> = { ...prevStatuses };
  await Promise.all(
    chunk.map(async ({ row, rowIndex }) => {
      const { currentStatuses } = await generateCurrentStatuses([row]);
      const key = row[0] || row[1];
      const statusObj = currentStatuses[key];
      if (!statusObj) return;
      const prev = prevStatuses[key];
      // 前回とstatusが違う場合のみ通知・更新
      if (!prev || prev.status !== statusObj.status) {
        changedRows.push({ row, rowIndex, statusObj });
      }
      // 最新状態を保存
      newStatuses[key] = statusObj;
    })
  );

  // 4. Discord通知は変化があった行のみ
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

  // 5. 値・書式のbatchUpdateは変化があった行があるときだけ実行する。
  //    書き込みスコープのトークンも、その時だけ取得してsubrequestを節約する。
  if (changedRows.length > 0) {
    const updatesBySheet: { range: string; values: [string, string] }[] = [];
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
      scope,
      STATUS_KV
    );
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`;
    const body = {
      valueInputOption: 'USER_ENTERED',
      data: updatesBySheet.map((u) => ({
        range: u.range,
        values: [u.values],
      })),
    };
    const valuesResp = await fetch(valuesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // bodyは使わないがcancelしないと接続が滞留し同時実行上限でstall→cancelされる
    await valuesResp.body?.cancel();

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
    const formatUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;
    const formatBody = { requests: formatRequests };
    const formatResp = await fetch(formatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formatBody),
    });
    // 同上: 使わないbodyはcancelして接続を解放する
    await formatResp.body?.cancel();
  }

  // 6. シートごとにKVへ最新状態を保存（変化が無くても保存）
  await STATUS_KV.put(kvKey, JSON.stringify(newStatuses));
  return changedRows;
}

// 監視処理の本体。sheetId指定時はそのシートだけを対象にする（ファンアウトの子invocation用）。
// 対象シートの行はまとめて1回のbatchGetで取得し、シートごとにprocessSheetを実行する。
async function runHealthCheck(
  env: Env,
  opts: { sheetId?: number; title?: string; offset: number; limit: number }
): Promise<ChangedRow[]> {
  const {
    GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY,
    SPREADSHEET_ID,
    RANGE,
    DISCORD_WEBHOOK_URL,
    STATUS_KV,
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

  // 対象シートの確定。子invocation（sheetId+title指定）では metadata 取得を省いて
  // subrequestを1つ節約する。それ以外は従来どおり全シートを取得して必要なら絞り込む。
  let sheets: { sheetId: number; title: string }[];
  if (opts.sheetId !== undefined && opts.title) {
    sheets = [{ sheetId: opts.sheetId, title: opts.title }];
  } else {
    const allSheets = await fetchAllSheets(
      GOOGLE_CLIENT_EMAIL,
      fixedPrivateKey,
      SPREADSHEET_ID,
      STATUS_KV
    );
    sheets =
      opts.sheetId !== undefined
        ? allSheets.filter((s) => s.sheetId === opts.sheetId)
        : allSheets;
  }

  // 選択した全シートの行を1回のvalues:batchGetでまとめて取得
  const ranges = sheets.map((s) => `${s.title}!${RANGE}`);
  const rowsBySheet = await fetchSheetsRows(
    GOOGLE_CLIENT_EMAIL,
    fixedPrivateKey,
    SPREADSHEET_ID,
    ranges,
    STATUS_KV
  );

  let allChangedRows: ChangedRow[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const changedRows = await processSheet(
      env,
      fixedPrivateKey,
      sheets[i],
      rowsBySheet[i] || [],
      opts.offset,
      opts.limit
    );
    allChangedRows = allChangedRows.concat(changedRows);
  }

  return allChangedRows;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // クエリパラメータでoffset/limit/sheetId/titleを指定可能に
      const url = new URL(request.url);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const sheetIdParam = url.searchParams.get('sheetId');
      const sheetId =
        sheetIdParam !== null ? parseInt(sheetIdParam, 10) : undefined;
      // titleがあれば子invocationはmetadata取得を省ける
      const title = url.searchParams.get('title') || undefined;

      const results = await runHealthCheck(env, {
        sheetId,
        title,
        offset,
        limit,
      });

      return new Response(
        JSON.stringify({
          message: 'Server health check complete',
          results,
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
    try {
      const hasRequiredEnv =
        env.GOOGLE_CLIENT_EMAIL &&
        env.GOOGLE_PRIVATE_KEY &&
        env.SPREADSHEET_ID &&
        env.DISCORD_WEBHOOK_URL;

      // SELFバインディングがあれば、シートごとに自分自身を子invocationとして呼び出す。
      // 各子invocationは新たな50 subrequest枠を得るため、合計の監視可能数を増やせる。
      // ファンアウトはシート単位（任意チャンク単位ではない）にして、KVキーごとの
      // 書き込み者が1実行につき必ず1つになるようにする。
      if (env.SELF && hasRequiredEnv) {
        const self = env.SELF;
        const fixedPrivateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
        const sheets = await fetchAllSheets(
          env.GOOGLE_CLIENT_EMAIL,
          fixedPrivateKey,
          env.SPREADSHEET_ID,
          env.STATUS_KV
        );
        const fanoutLimit = parseInt(env.FANOUT_LIMIT || '40', 10);
        for (const sheet of sheets) {
          // 1つの子が失敗しても残りを止めないよう、各呼び出しをtry/catchで囲む。
          // 子レスポンスのbodyを読み切らないと、親invocation終了時に子が打ち切られて
          // tail上 "Canceled" になる。結果は使わないが必ず読み切って完了を待つ。
          try {
            const childResp = await self.fetch(
              `https://smartwatchdog.internal/?sheetId=${sheet.sheetId}&title=${encodeURIComponent(sheet.title)}&limit=${fanoutLimit}`
            );
            await childResp.text();
          } catch (err) {
            console.error(`Fan-out failed for sheet ${sheet.sheetId}:`, err);
          }
        }
        return;
      }

      // フォールバック: SELF未設定（dev/local/テスト）では従来どおり逐次処理
      await runHealthCheck(env, {
        offset: 0,
        limit: parseInt(env.FANOUT_LIMIT || '40', 10),
      });
    } catch (e) {
      console.error('Scheduled handler error:', e);
    }
  },
};
