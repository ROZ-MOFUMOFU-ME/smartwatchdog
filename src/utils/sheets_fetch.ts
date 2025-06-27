import { getGoogleAccessToken } from './google_jwt';
import { generateCurrentStatuses } from './status';

// 全シートのIDとタイトルを取得
export async function fetchAllSheets(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string
): Promise<{ sheetId: number; title: string }[]> {
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope
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

// Google Sheetsの値を取得（最初のシートID・タイトルを使う）
export async function fetchSheetValues(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string
): Promise<Record<string, unknown>> {
  const sheets = await fetchAllSheets(clientEmail, privateKey, spreadsheetId);
  const firstSheet = sheets[0];
  // 通常はタイトルでrangeを組み立てる
  const range = `${firstSheet.title}!A1:D10`;
  // IDで直接値取得はAPI仕様上できないが、IDを使ったAPI例:
  // const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${firstSheet.sheetId}!A1:D10`;
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope
  );
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('Google Sheets API error (get values):', text);
    throw new Error('Failed to fetch sheet values: ' + text);
  }
  return (await resp.json()) as Record<string, unknown>;
}

// シートの全行を取得
export async function fetchSheetRows(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const scope = 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope
  );
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Failed to fetch sheet rows: ' + text);
  }
  const data = (await resp.json()) as { values: string[][] };
  return data.values || [];
}

// ステータスをチェックし、変化があった行だけbatchUpdateで書き込む＋背景色も更新
export async function updateSheetStatuses(
  clientEmail: string,
  privateKey: string,
  spreadsheetId: string,
  sheetTitle: string,
  range: string,
  sheetId?: number // 追加: シートID
): Promise<{ updatedRows: number[] }> {
  // 1. 全行取得
  const rows = await fetchSheetRows(
    clientEmail,
    privateKey,
    spreadsheetId,
    range
  );
  if (rows.length === 0) return { updatedRows: [] };

  // 1.5. 1列目も2列目も空白の行を削除
  if (typeof sheetId === 'number') {
    const emptyRowIndexes: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const [col1, col2] = rows[i];
      if ((!col1 || col1.trim() === '') && (!col2 || col2.trim() === '')) {
        emptyRowIndexes.push(i);
      }
    }
    if (emptyRowIndexes.length > 0) {
      // まとめてdeleteDimensionリクエストを作成（下から順に削除）
      const deleteRequests = emptyRowIndexes
        .sort((a, b) => b - a)
        .map((rowIdx) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIdx + 1, // A2:Dのrows[1]は2行目
              endIndex: rowIdx + 2,
            },
          },
        }));
      const scope = 'https://www.googleapis.com/auth/spreadsheets';
      const accessToken = await getGoogleAccessToken(
        clientEmail,
        privateKey,
        scope
      );
      const formatUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
      const formatBody = { requests: deleteRequests };
      const formatResp = await fetch(formatUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(formatBody),
      });
      if (!formatResp.ok) {
        const text = await formatResp.text();
        throw new Error('Failed to delete empty rows: ' + text);
      }
      // 削除後は以降のロジックをスキップ（再取得推奨）
      return { updatedRows: [] };
    }
  }

  // 2. 監視結果生成
  const { currentStatuses } = await generateCurrentStatuses(rows.slice(1)); // 1行目はヘッダ
  // 3. 既存Statusと比較し、変化がある行だけ更新
  const updates: { rowIndex: number; status: string; lastUpdate: string }[] =
    [];
  for (let i = 1; i < rows.length; i++) {
    const [serverName, serverUrl, prevStatus] = rows[i];
    const key = serverName || serverUrl;
    if (!key) continue;
    const statusObj = currentStatuses[key];
    if (!statusObj) continue;
    if (statusObj.status !== prevStatus) {
      updates.push({
        rowIndex: i,
        status: statusObj.status,
        lastUpdate: statusObj.lastUpdate,
      });
    }
  }
  if (updates.length === 0) return { updatedRows: [] };
  // 4. batchUpdateリクエスト作成（値）
  const scope = 'https://www.googleapis.com/auth/spreadsheets';
  const accessToken = await getGoogleAccessToken(
    clientEmail,
    privateKey,
    scope
  );
  const requests = updates.map((u) => ({
    range: `${sheetTitle}!C${u.rowIndex + 2}:D${u.rowIndex + 2}`,
    values: [[u.status, u.lastUpdate]],
  }));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const body = {
    valueInputOption: 'USER_ENTERED',
    data: requests,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Failed to batch update sheet: ' + text);
  }
  // 5. batchUpdateリクエスト作成（書式）
  if (typeof sheetId === 'number') {
    const formatRequests = updates.map((u) => {
      const isOk = u.status.startsWith('OK');
      return isOk
        ? {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: u.rowIndex + 1,
                endRowIndex: u.rowIndex + 2,
                startColumnIndex: 2,
                endColumnIndex: 3,
              },
              cell: { userEnteredFormat: {} },
              fields: 'userEnteredFormat',
            },
          }
        : {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: u.rowIndex + 1,
                endRowIndex: u.rowIndex + 2,
                startColumnIndex: 2,
                endColumnIndex: 3,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 0.8, blue: 0.8 },
                },
              },
              fields: 'userEnteredFormat',
            },
          };
    });
    const formatUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const formatBody = { requests: formatRequests };
    const formatResp = await fetch(formatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(formatBody),
    });
    if (!formatResp.ok) {
      const text = await formatResp.text();
      throw new Error('Failed to batch update cell format: ' + text);
    }
  }
  return { updatedRows: updates.map((u) => u.rowIndex) };
}

// Discord Webhook通知ユーティリティ
export async function sendDiscordWebhook(
  webhookUrl: string,
  content: string,
  embed?: Record<string, unknown>
) {
  const body: Record<string, unknown> = { content };
  if (embed) body.embeds = [embed];
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
