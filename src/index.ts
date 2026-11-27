import type { Env, ServerStatus } from './types';
import { mapWithConcurrency } from './utils/concurrency';
import { getGoogleAccessToken } from './utils/google_jwt';
import {
  DiscordWebhookError,
  fetchAllSheets,
  fetchSheetsRows,
  sendDiscordWebhook,
} from './utils/sheets_fetch';
import { generateCurrentStatuses } from './utils/status';
import {
  decideStatus,
  isOk,
  parseFailThreshold,
  sameStatus,
} from './utils/transition';

// 同時に走らせるチェックの数。Workersの同時接続の上限（6）より少なくして、
// 接続待ちの時間がタイムアウトに数えられないようにする
const CHECK_CONCURRENCY = 5;

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

// Google Sheets APIへの書き込み結果を確認し、失敗ならログに残す。
// 使わないbodyもcancelしないと接続が滞留し、同時実行上限でstall→cancelされる
async function logIfFailed(resp: Response, label: string): Promise<void> {
  if (resp.ok) {
    await resp.body?.cancel();
    return;
  }
  console.error(
    `Google Sheets API error (${label}): ${resp.status} ${await resp.text()}`
  );
}

// 1シート分の監視処理。あらかじめ取得した行（rows）を受け取る。
// - Discord通知: OK⇔異常が確定した行と新しい行だけ（判定は utils/transition.ts）
// - KV保存: 記録する内容（保留中の失敗回数を含む）が変わったときだけ
// - シート更新: 通知した行と、シートのC列が記録した状態と食い違っている行
//   （書き込みに一度失敗しても、次の監視で自動的に直るようにするため）
// - Discord側の一時的な障害で通知できなかった行は、記録もシートも進めず、次の監視で再通知する
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

  // 3. chunk内の監視（同時接続の上限内で実行）
  const threshold = parseFailThreshold(env.FAIL_THRESHOLD);
  const changedRows: ChangedRow[] = []; // 通知する行（OK⇔異常が確定した行・新しい行）
  const sheetRows: ChangedRow[] = []; // シートを書き直す行
  const newStatuses: Record<string, ServerStatus> = { ...prevStatuses };
  const changedKeys = new Set<string>(); // 記録する内容が変わった行（KV保存の要否）
  await mapWithConcurrency(
    chunk,
    CHECK_CONCURRENCY,
    async ({ row, rowIndex }) => {
      const { currentStatuses } = await generateCurrentStatuses([row]);
      const key = row[0] || row[1];
      const current = currentStatuses[key];
      if (!current) return;
      const prev = prevStatuses[key];
      const { next, notify } = decideStatus(prev, current, threshold);
      // 記録する内容が変わったときだけKVへ保存する（変化が無い行は前回の値をそのまま残すので、
      // KVのlastUpdateはシートのD列と同じく「最後に状態が変化した時刻」になる）
      if (!sameStatus(prev, next)) {
        newStatuses[key] = next;
        changedKeys.add(key);
        const state = notify
          ? 'changed'
          : next.failCount
            ? `pending ${next.failCount}/${threshold}`
            : 'updated';
        console.log(
          `[status] ${sheet.title} / ${key}: ${prev?.status ?? '(new)'} -> ${current.status} (${state})`
        );
      }
      const item = { row, rowIndex, statusObj: next };
      if (notify) changedRows.push(item);
      // シートは、通知した行に加えて、C列の表示が記録した状態と違う行も書き直す。
      // シートへの書き込みに失敗すると、KVはOKなのにシートはERRORのまま、のような
      // 食い違いが残り、KVだけを見ていると二度と直らないため
      if (notify || row[2] !== next.status) {
        sheetRows.push(item);
      }
    }
  );

  // 4. Discord通知は、OK⇔異常が確定した行と新しい行のみ。
  //    Webhook の回数制限に当たりにくいよう1件ずつ送る
  const confirmedRows: ChangedRow[] = []; // 状態の変化を確定した行（戻り値）
  for (const item of changedRows) {
    const { row, rowIndex, statusObj } = item;
    const isError = !isOk(statusObj.status);
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
    try {
      await sendDiscordWebhook(DISCORD_WEBHOOK_URL, content, embed);
      confirmedRows.push(item);
    } catch (err) {
      const key = row[0] || row[1];
      console.error(`[notify failed] ${sheet.title} / ${key}:`, err);
      if (err instanceof DiscordWebhookError && err.retryable) {
        // Discord側の一時的な障害: 記録もシートも前回のままにして、次の監視でもう一度判定・通知する
        const prev = prevStatuses[key];
        if (prev) newStatuses[key] = prev;
        else delete newStatuses[key];
        changedKeys.delete(key);
        const i = sheetRows.indexOf(item);
        if (i >= 0) sheetRows.splice(i, 1);
      } else {
        // Webhook URLの誤りなど、送り直しても届かない: 記録とシートの表示だけは進める
        confirmedRows.push(item);
      }
    }
  }

  // 5. 値・書式のbatchUpdateは書き直す行があるときだけ実行する。
  //    書き込みスコープのトークンも、その時だけ取得してsubrequestを節約する。
  if (sheetRows.length > 0) {
    const updatesBySheet: { range: string; values: [string, string] }[] = [];
    sheetRows.forEach(({ rowIndex, statusObj }) => {
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
    // 失敗してもKVは保存する（通知の重複を防ぐ）。シートはC列の食い違いとして次の監視で書き直される
    await logIfFailed(valuesResp, `update values: ${sheet.title}`);

    // 書き直す行を、エラー/OKで色分け
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
    sheetRows.forEach(({ rowIndex, statusObj }) => {
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
    await logIfFailed(formatResp, `update format: ${sheet.title}`);
  }

  // 6. 記録する内容が変わったシートだけKVへ保存する（保留中の失敗回数の更新を含む）。
  //    無料プランのKV書き込みはアカウント全体で1日1,000回まで。変化が無くても
  //    毎回保存すると「シート数 × 144回/日（10分間隔）」を消費し、手動実行や
  //    外部からのアクセスが重なると上限を超える。
  if (changedKeys.size > 0) {
    await STATUS_KV.put(kvKey, JSON.stringify(newStatuses));
  }
  return confirmedRows;
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

// 必須環境変数が揃っているか
function hasRequiredEnv(env: Env): boolean {
  return !!(
    env.GOOGLE_CLIENT_EMAIL &&
    env.GOOGLE_PRIVATE_KEY &&
    env.SPREADSHEET_ID &&
    env.DISCORD_WEBHOOK_URL
  );
}

// 2つの文字列を、内容によらず同じ時間で比較する（比較時間からトークンを推測されないように）
function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// HTTPアクセスの認可。TRIGGER_TOKEN を設定していれば Authorization: Bearer <token> を必須にする。
// 公開URLやプレビューURLへの無関係なアクセスで、監視・Google API・Discord通知が走るのを防ぐ。
function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.TRIGGER_TOKEN?.trim();
  if (!expected) return true;
  const match = (request.headers.get('Authorization') || '').match(
    /^Bearer\s+(\S+)$/i
  );
  return !!match && timingSafeEqual(match[1], expected);
}

// SELFバインディング経由でシート単位に子invocationへファンアウトする。
// 各子は新たな50 subrequest枠を持つため、合計の監視可能数を増やせる。
// ファンアウトはシート単位（任意チャンク単位ではない）にして、KVキーごとの
// 書き込み者が1実行につき必ず1つになるようにする。戻り値はディスパッチしたシート数。
async function fanOutPerSheet(env: Env): Promise<number> {
  const self = env.SELF;
  if (!self) return 0;
  const fixedPrivateKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const sheets = await fetchAllSheets(
    env.GOOGLE_CLIENT_EMAIL,
    fixedPrivateKey,
    env.SPREADSHEET_ID,
    env.STATUS_KV
  );
  const fanoutLimit = parseInt(env.FANOUT_LIMIT || '40', 10);
  // TRIGGER_TOKEN 設定時は、子invocationも同じ認可を通るようにトークンを付ける
  const token = env.TRIGGER_TOKEN?.trim();
  const childInit: RequestInit = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : {};
  for (const sheet of sheets) {
    // 1つの子が失敗しても残りを止めないようtry/catch。
    // 子レスポンスのbodyを読み切らないと、親invocation終了時に子が打ち切られて
    // tail上 "Canceled" になる。結果は使わないが必ず読み切って完了を待つ。
    try {
      const childResp = await self.fetch(
        `https://smartwatchdog.internal/?sheetId=${sheet.sheetId}&title=${encodeURIComponent(sheet.title)}&limit=${fanoutLimit}`,
        childInit
      );
      await childResp.text();
    } catch (err) {
      console.error(`Fan-out failed for sheet ${sheet.sheetId}:`, err);
    }
  }
  return sheets.length;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // トークンが無い・違うアクセスは、監視処理を一切実行せずに拒否する
    if (!isAuthorized(request, env)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        },
      });
    }
    try {
      // クエリパラメータでoffset/limit/sheetId/titleを指定可能に
      const url = new URL(request.url);
      const sheetIdParam = url.searchParams.get('sheetId');

      // sheetId未指定でSELFがあれば、cronと同じくシート単位でファンアウトする。
      // 引数なしの/を1 invocationで全シート処理すると50 subrequest上限を超えるため。
      if (sheetIdParam === null && env.SELF && hasRequiredEnv(env)) {
        const dispatched = await fanOutPerSheet(env);
        return new Response(
          JSON.stringify({
            message: 'Server health check fanned out',
            dispatched,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // それ以外（sheetId指定 or SELF未設定）は同一invocationで処理する
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
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
      // SELFがあればシート単位でファンアウト（各子が新たな50 subrequest枠を得る）
      if (env.SELF && hasRequiredEnv(env)) {
        await fanOutPerSheet(env);
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
