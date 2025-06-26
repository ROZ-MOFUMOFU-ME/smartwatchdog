import https from 'https';
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyHandler } from 'aws-lambda';
import axios from 'axios';
import { google } from 'googleapis';
import type {
  ServerStatus,
  S3StatusData,
  SlackStatusData,
  SlackNotificationType,
  SheetUpdateResult,
} from './types';
import { getCurrentJST } from './utils/date';
import { writeStatusesToS3, readStatusesFromS3 } from './utils/s3';
import { generateCurrentStatuses } from './utils/status';

const s3Client = new S3Client({ region: process.env.AWS_REGION });
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const objectKeyPrefix = 'server_status';

// Google Auth client
const getAuthClient = async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return await auth.getClient();
};

// Get all sheet names and IDs
const getAllSheetNamesAndIds = async (
  sheetId: string,
  retries = 10,
  delay = 5000
): Promise<{ title: string; id: number }[]> => {
  const sheetsApi = google.sheets('v4');
  try {
    const response = await sheetsApi.spreadsheets.get({
      spreadsheetId: sheetId,
    });
    return (response.data.sheets || []).map((sheet) => ({
      title: sheet.properties?.title || '',
      id: sheet.properties?.sheetId || 0,
    }));
  } catch (error) {
    if (
      retries > 0 &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: number }).code === 429
    ) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return getAllSheetNamesAndIds(sheetId, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
};

// Get sheet ID by name
const getSheetId = async (
  sheetId: string,
  sheetName: string
): Promise<number> => {
  const sheets = await getAllSheetNamesAndIds(sheetId);
  const sheet = sheets.find((s) => s.title === sheetName);
  if (sheet) return sheet.id;
  throw new Error(
    `Sheet with name ${sheetName} not found in spreadsheet ${sheetId}`
  );
};

// Get sheet data
const getSheetData = async (
  sheetId: string,
  range: string
): Promise<string[][]> => {
  const [sheetName, cellRange] = range.includes('!')
    ? range.split('!')
    : [null, range];
  if (!sheetName || sheetName.trim() === '') {
    throw new Error('Invalid range: Sheet name is not specified');
  }
  const requestRange = `${sheetName}!${cellRange}`;
  const sheetsApi = google.sheets('v4');
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: requestRange,
  });
  return res.data.values as string[][];
};

// Slack notification
const sendSlackNotification = async (
  statusData: SlackStatusData,
  type: SlackNotificationType | string,
  sheetName: string | null = null,
  mentionChannel = false
) => {
  const headerText =
    type === 'error'
      ? ':rotating_light: Server health check failure'
      : ':white_check_mark: Server is now alive';
  const header =
    sheetName && sheetName !== 'シート1'
      ? `${headerText} - ${sheetName}`
      : `${headerText}`;
  const payload = {
    blocks: [
      ...(mentionChannel
        ? [{ type: 'section', text: { type: 'mrkdwn', text: '@channel' } }]
        : []),
      {
        type: 'header',
        text: { type: 'plain_text', text: header, emoji: true },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Server Name:*\n${statusData.serverName || 'N/A'}`,
          },
          {
            type: 'mrkdwn',
            text: `*Server URL:*\n${statusData.serverUrl || 'N/A'}`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Status:*\n:${type === 'error' ? 'red_circle' : 'large_green_circle'}: ${statusData.status}`,
          },
          { type: 'mrkdwn', text: `*Last Updated:*\n${statusData.lastUpdate}` },
        ],
      },
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View in Google Sheets',
              emoji: true,
            },
            value: 'view_sheets',
            url: `${statusData.sheetUrl}`,
          },
        ],
      },
    ],
  };
  const options = {
    hostname: 'hooks.slack.com',
    path: `/services/${SLACK_WEBHOOK_URL.split('https://hooks.slack.com/services/')[1]}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
    },
  };
  return new Promise<void>((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
};

// Update Google Sheet with status and color
const updateSheet = async (
  sheetId: string,
  range: string,
  results: PromiseSettledResult<SheetUpdateResult | null>[]
) => {
  const colorMap = {
    red: { red: 0.956, green: 0.8, blue: 0.8 },
    white: { red: 1, green: 1, blue: 1 },
  };
  const [sheetName, cellRange] = range.split('!');
  const sheetIdInt = await getSheetId(sheetId, sheetName);
  const startColumnIndex =
    cellRange.match(/[A-Z]+/g)![0].charCodeAt(0) - 'A'.charCodeAt(0);
  const startRowIndex = parseInt(cellRange.match(/\d+/g)![0], 10) - 1;
  const statusColumnIndex = startColumnIndex + 2;
  const lastUpdateColumnIndex = startColumnIndex + 3;
  const validResults = results
    .filter(
      (result): result is PromiseFulfilledResult<SheetUpdateResult> =>
        result.status === 'fulfilled' && result.value !== null
    )
    .map((result) => result.value);
  const requests = validResults.map((result) => {
    const { index, status, lastUpdate, color, deleteColumns } = result;
    const range = {
      sheetId: sheetIdInt,
      startRowIndex: index + startRowIndex,
      endRowIndex: index + startRowIndex + 1,
      startColumnIndex: statusColumnIndex,
      endColumnIndex: lastUpdateColumnIndex + 1,
    };
    const values = deleteColumns
      ? [
          {
            userEnteredValue: null,
            userEnteredFormat: { backgroundColor: colorMap['white'] },
          },
          {
            userEnteredValue: null,
            userEnteredFormat: { backgroundColor: colorMap['white'] },
          },
        ]
      : [
          {
            userEnteredValue: { stringValue: status },
            userEnteredFormat: { backgroundColor: colorMap[color ?? 'white'] },
          },
          {
            userEnteredValue: { stringValue: lastUpdate },
            userEnteredFormat: { backgroundColor: colorMap['white'] },
          },
        ];
    return {
      updateCells: {
        range,
        rows: [{ values }],
        fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
      },
    };
  });
  if (requests.length > 0) {
    const sheetsApi = google.sheets('v4');
    const request = { spreadsheetId: sheetId, resource: { requests } };
    await sheetsApi.spreadsheets.batchUpdate(request);
  }
};

// Check server status and notify Slack
const checkServerStatus = async (
  row: string[],
  index: number,
  sheetId: string,
  sheetName: string,
  previousStatuses: Record<string, ServerStatus>,
  currentStatuses: Record<string, ServerStatus>
): Promise<SheetUpdateResult | null> => {
  let serverName = row[0];
  const serverUrl = row[1];
  const sheetIdInt = await getSheetId(sheetId, sheetName);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${sheetIdInt}&range=${index + 2}:${index + 2}`;
  if (!serverName && !serverUrl) {
    return { index, deleteColumns: true, needsUpdate: true };
  }
  if (!serverUrl || serverUrl.trim() === '') return null;
  if (!serverName) serverName = serverUrl;
  const previousStatus = previousStatuses[serverName]?.status || null;
  let newStatus = '';
  let notificationType: SlackNotificationType | '' = '';
  let mentionChannel = false;
  try {
    const response = await axios.get(serverUrl, { timeout: 5000 });
    newStatus = `OK Status:${response.status}`;
  } catch (error) {
    const err = error as {
      code?: string;
      response?: { status?: number };
      message?: string;
    };
    newStatus =
      err.code === 'ENOTFOUND'
        ? 'ERROR! Server not reachable'
        : `ERROR! ${err.response ? `Status:${err.response.status}` : err.message}`;
  }
  if (previousStatus === newStatus) return null;
  currentStatuses[serverName] = {
    status: newStatus,
    lastUpdate: getCurrentJST(),
  };
  if (newStatus.startsWith('ERROR')) {
    notificationType = 'error';
    mentionChannel = !previousStatus || !previousStatus.startsWith('ERROR');
  } else if (newStatus.startsWith('OK')) {
    notificationType = 'recovery';
  }
  await sendSlackNotification(
    {
      serverName,
      serverUrl,
      status: newStatus,
      lastUpdate: getCurrentJST(),
      sheetUrl,
    },
    notificationType,
    sheetName,
    mentionChannel
  );
  const needsUpdate = !previousStatus || newStatus.startsWith('ERROR');
  return {
    index,
    serverName,
    serverUrl,
    status: newStatus,
    color: newStatus.startsWith('OK') ? 'white' : 'red',
    lastUpdate: getCurrentJST(),
    needsUpdate,
  };
};

// Main Lambda handler
export const handler: APIGatewayProxyHandler = async () => {
  try {
    const authClient = await getAuthClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    google.options({ auth: authClient as any });
    const sheetId = process.env.SPREADSHEET_ID!;
    const range = process.env.RANGE!;
    await processSheets(sheetId, range);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Server health check complete.' }),
    };
  } catch (error) {
    await sendSlackNotification(
      { status: `An error occurred: ${(error as Error).message}` },
      'error'
    );
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'An error occurred.',
        error: (error as Error).message,
      }),
    };
  }
};

// Export functions for testing
export { sendSlackNotification, updateSheet, google };

// Process all sheets
const processSheets = async (sheetId: string, range: string) => {
  const allSheetNames = await getAllSheetNamesAndIds(sheetId);
  const [sheetNameInRange, cellRange] = range.includes('!')
    ? range.split('!')
    : [null, range];
  if (sheetNameInRange) {
    await processSingleSheet(sheetId, range, sheetNameInRange);
  } else {
    for (const sheet of allSheetNames) {
      const fullRange = `${sheet.title}!${cellRange}`;
      await processSingleSheet(sheetId, fullRange, sheet.title);
    }
  }
};

// Process a single sheet
const processSingleSheet = async (
  sheetId: string,
  range: string,
  sheetName: string
) => {
  const rows = await getSheetData(sheetId, range);
  if (!rows || !rows.length) return;
  const fileName = `${objectKeyPrefix}_${sheetName}.json`;
  const previousData = await readStatusesFromS3(
    s3Client,
    fileName,
    process.env.S3_BUCKET_NAME!
  );
  const previousStatuses: Record<string, ServerStatus> =
    (previousData as S3StatusData).statuses || {};
  const previousSheetUrl: string =
    (previousData as S3StatusData).sheetUrl || '';
  const { currentStatuses, removedStatuses } =
    await generateCurrentStatuses(rows);
  const previousKeys = Object.keys(previousStatuses);
  const currentKeys = Object.keys(currentStatuses);
  previousKeys.forEach((key) => {
    if (!currentKeys.includes(key)) {
      removedStatuses[key] = true;
    }
  });
  for (const key in removedStatuses) {
    if (previousStatuses[key]) {
      delete previousStatuses[key];
    }
  }
  const checks = rows.map((row, index) =>
    checkServerStatus(
      row,
      index,
      sheetId,
      sheetName,
      previousStatuses,
      currentStatuses
    )
  );
  const results = await Promise.allSettled(checks);
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${await getSheetId(sheetId, sheetName)}`;
  const hasChanges =
    Object.keys(currentStatuses).some((key) => {
      return (
        !previousStatuses[key] ||
        JSON.stringify(previousStatuses[key]) !==
          JSON.stringify(currentStatuses[key])
      );
    }) ||
    Object.keys(removedStatuses).length > 0 ||
    previousSheetUrl !== sheetUrl;
  if (
    hasChanges ||
    results.some(
      (result) =>
        result.status === 'fulfilled' &&
        result.value &&
        result.value.deleteColumns
    )
  ) {
    await writeStatusesToS3(
      s3Client,
      { ...previousStatuses, ...currentStatuses },
      fileName,
      sheetUrl,
      process.env.S3_BUCKET_NAME!
    );
    await updateSheet(sheetId, range, results);
  }
};
