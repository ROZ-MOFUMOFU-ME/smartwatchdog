import { google } from 'googleapis';
import type { sheets_v4 } from 'googleapis';
import type { GoogleAuth, OAuth2Client } from 'googleapis-common';
import type { Env, KVStatusData } from './types';
import { generateCurrentStatuses } from './utils/status';

// KVユーティリティ
const writeStatusesToKV = async (
  kv: KVNamespace,
  key: string,
  data: KVStatusData
): Promise<void> => {
  await kv.put(key, JSON.stringify(data));
};

const readStatusesFromKV = async (
  kv: KVNamespace,
  key: string
): Promise<KVStatusData> => {
  const value = await kv.get(key);
  return value ? JSON.parse(value) : { statuses: {} };
};

// Discord 個別通知
const sendDiscordNotification = async (
  webhookUrl: string,
  spreadsheetId: string,
  sheetId: number,
  notificationPayload: {
    serverName?: string;
    serverUrl?: string;
    status: string;
    lastUpdate: string;
  },
  rowNumber: number,
  mentionRoleId?: string,
  sheetName?: string
) => {
  const { serverName, serverUrl, status, lastUpdate } = notificationPayload;
  const isError = status.startsWith('ERROR');
  const mention = mentionRoleId && isError ? `<@&${mentionRoleId}>` : '';

  // Ensure the URL is clickable in Discord by prepending http:// if it's missing a protocol.
  let displayLinkUrl = serverUrl;
  if (displayLinkUrl && !/^[a-zA-Z]+:\/\//.test(displayLinkUrl)) {
    displayLinkUrl = `http://${displayLinkUrl}`;
  }
  // Google Sheets行リンク
  const sheetRowUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=${rowNumber}:${rowNumber}`;

  const embed = {
    title: isError
      ? `:rotating_light: Server health check failure - ${sheetName || 'Unknown Sheet'}`
      : `:white_check_mark: Server Recovered - ${sheetName || 'Unknown Sheet'}`,
    color: isError ? 0xff0000 : 0x00ff00,
    description: '',
    fields: [
      {
        name: 'Server Name',
        value: serverName || 'N/A',
        inline: true,
      },
      {
        name: 'Server URL',
        value: displayLinkUrl ? `<${displayLinkUrl}>` : 'N/A',
        inline: true,
      },
      {
        name: '\u200B',
        value: '\u200B',
        inline: true,
      },
      {
        name: 'Status',
        value: `${isError ? '🔴' : '🟢'} ${status}`,
        inline: true,
      },
      {
        name: 'Last Updated',
        value: lastUpdate,
        inline: true,
      },
      {
        name: '\u200B',
        value: '\u200B',
        inline: true,
      },
      {
        name: '\u200B',
        value: `[📊 View in Google Sheets](${sheetRowUrl})`,
        inline: false,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: mention,
        embeds: [embed],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Failed to send Discord notification: ${response.status} - ${errorText}`
      );
    } else {
      console.log('Discord notification sent successfully.');
      if (
        response.body &&
        typeof (response.body as { cancel?: () => void }).cancel === 'function'
      ) {
        (response.body as { cancel?: () => void }).cancel?.();
      }
    }
  } catch (error) {
    console.error('Error sending Discord notification:', error);
  }
};

// Google Sheetsデータ取得
const getSheetData = async (
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string
): Promise<string[][]> => {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: spreadsheetId,
    range,
  });
  return (res.data.values as string[][]) || [];
};

// スプレッドシートを一括更新
const batchUpdateSheet = async (
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[]
): Promise<void> => {
  if (requests.length === 0) {
    return;
  }
  const BATCH_LIMIT = 50;
  for (let i = 0; i < requests.length; i += BATCH_LIMIT) {
    const batch = requests.slice(i, i + BATCH_LIMIT);
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId,
      requestBody: {
        requests: batch,
      },
    });
  }
};

// KVでの状態管理・通知・シート更新
const handleWatchdog = async (env: Env) => {
  // Google認証
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: env.GOOGLE_CLIENT_EMAIL,
      private_key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  google.options({
    auth: (await auth.getClient()) as unknown as GoogleAuth<OAuth2Client>,
  });

  const sheetsApi = google.sheets('v4');
  const spreadsheetId = env.SPREADSHEET_ID;

  // 1. 全シートのメタデータを取得
  const spreadsheetInfo = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  if (
    !spreadsheetInfo.data.sheets ||
    spreadsheetInfo.data.sheets.length === 0
  ) {
    console.log('No sheets found in spreadsheet.');
    return;
  }

  // 2. 処理するシートを決定するためのカーソルをKVから読み込む
  const rangePattern = 'A2:D'; // env.RANGE.split('!')[1] || 'A2:D';
  const sheetMetas = spreadsheetInfo.data.sheets
    .filter(
      (s) =>
        s.properties?.sheetId !== null &&
        s.properties?.sheetId !== undefined &&
        s.properties?.title
    )
    .map((s) => ({
      sheetId: s.properties!.sheetId!,
      title: s.properties!.title!,
      range: `${s.properties!.title}!${rangePattern}`,
      kvKey: `${spreadsheetId}-${s.properties!.sheetId!}`,
    }));

  const cursorStr = await env.STATUS_KV.get('SHEETS_WATCHDOG_CURSOR');
  let cursor = cursorStr ? parseInt(cursorStr, 10) : 0;
  if (cursor >= sheetMetas.length) {
    cursor = 0;
  }

  const sheetToProcess = sheetMetas[cursor];

  // 3. 選択されたシートのデータを取得
  const rows = await getSheetData(
    sheetsApi,
    spreadsheetId,
    sheetToProcess.range
  );
  const prevData = await readStatusesFromKV(
    env.STATUS_KV,
    sheetToProcess.kvKey
  );

  // --- 空行削除フェーズ ---
  const startRow = (rangePattern.match(/^([A-Z]+)(\d+)/) || [])[2];
  const startRowIndex = startRow ? parseInt(startRow, 10) - 1 : 1;
  const emptyRowDeleteRequests: sheets_v4.Schema$Request[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const [serverName, serverUrl] = rows[i];
    if (!serverName && !serverUrl) {
      emptyRowDeleteRequests.push({
        deleteDimension: {
          range: {
            sheetId: sheetToProcess.sheetId,
            dimension: 'ROWS',
            startIndex: startRowIndex + i,
            endIndex: startRowIndex + i + 1,
          },
        },
      });
    }
  }
  if (emptyRowDeleteRequests.length > 0) {
    await batchUpdateSheet(sheetsApi, spreadsheetId, emptyRowDeleteRequests);
    // To ensure row deletion is fully reflected, skip further processing this run.
    // The next scheduled run will operate on the updated sheet.
    return;
  }

  // --- 通常の監視・通知・シート更新フェーズ ---
  if (rows.length > 0) {
    const prevStatuses = prevData?.statuses || {};
    const { currentStatuses } = await generateCurrentStatuses(rows);

    const updateRequests: sheets_v4.Schema$Request[] = [];
    const notificationPromises: Promise<void>[] = [];
    // startRow, startRowIndexは上で定義済み

    rows.forEach((row, index) => {
      const [serverName, serverUrl] = row;
      const key = serverName || serverUrl;
      const currentStatus = currentStatuses[key];
      const prevStatus = prevStatuses[key];

      // 空行は既に削除済みなのでスキップ
      if (!serverName && !serverUrl) {
        return;
      }
      // Server NameはあるがServer URLが空の場合は何もしない
      if (serverName && !serverUrl) {
        return;
      }
      if (
        currentStatus &&
        (!prevStatus || prevStatus.status !== currentStatus.status)
      ) {
        const isError = currentStatus.status.startsWith('ERROR');
        const rowNumber = startRowIndex + index + 1;
        updateRequests.push({
          updateCells: {
            rows: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: currentStatus.status },
                    userEnteredFormat: {
                      backgroundColor: isError
                        ? { red: 1, green: 0.8, blue: 0.8 }
                        : { red: 1, green: 1, blue: 1 },
                    },
                  },
                  {
                    userEnteredValue: { stringValue: currentStatus.lastUpdate },
                    userEnteredFormat: {
                      backgroundColor: isError
                        ? { red: 1, green: 0.8, blue: 0.8 }
                        : { red: 1, green: 1, blue: 1 },
                    },
                  },
                ],
              },
            ],
            fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
            range: {
              sheetId: sheetToProcess.sheetId,
              startRowIndex: startRowIndex + index,
              endRowIndex: startRowIndex + index + 1,
              startColumnIndex: 2,
              endColumnIndex: 4, // C:D
            },
          },
        });
        const notificationPayload = {
          serverName: key,
          serverUrl,
          status: currentStatus.status,
          lastUpdate: currentStatus.lastUpdate,
        };
        notificationPromises.push(
          sendDiscordNotification(
            env.DISCORD_WEBHOOK_URL,
            spreadsheetId,
            sheetToProcess.sheetId,
            notificationPayload,
            rowNumber,
            env.DISCORD_MENTION_ROLE_ID,
            sheetToProcess.title
          )
        );
      }
    });

    await Promise.all(notificationPromises);
    if (updateRequests.length > 0) {
      await batchUpdateSheet(sheetsApi, spreadsheetId, updateRequests);
    }
    await writeStatusesToKV(env.STATUS_KV, sheetToProcess.kvKey, {
      statuses: currentStatuses,
    });
  }

  // 6. 次に処理するシートのカーソルを更新
  const nextCursor = (cursor + 1) % sheetMetas.length;
  await env.STATUS_KV.put('SHEETS_WATCHDOG_CURSOR', nextCursor.toString());
};

// Cloudflare Workersエントリポイント
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await handleWatchdog(env);
      return new Response(
        JSON.stringify({ message: 'Server health check complete.' }),
        { status: 200 }
      );
    } catch (error) {
      console.error(error);
      const rayId = request.headers.get('cf-ray');
      const errorMessage = `An error occurred. Ray ID: ${rayId}. Error: ${(error as Error).message}`;
      return new Response(JSON.stringify({ error: errorMessage }), {
        status: 500,
      });
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    try {
      await handleWatchdog(env);
    } catch (error) {
      console.error(`Scheduled task failed: ${(error as Error).stack}`);
    }
  },
};
