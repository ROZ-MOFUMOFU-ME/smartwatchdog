const { google } = require('googleapis');
const axios = require('axios');
const sheets = google.sheets('v4');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// AWS S3クライアントを初期化
const s3Client = new S3Client({ region: process.env.AWS_REGION }); // AWSのリージョンを自動取得
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // Slack Webhook URLを環境変数から取得
const objectKeyPrefix = 'server_status'; // S3に保存するファイル名の接頭辞

// Google認証クライアントの取得関数
const getAuthClient = async () => {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL, // 環境変数からサービスアカウントのメールを取得
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // 改行コードを適切に変換
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Google Sheets APIのスコープ
    });
    return await auth.getClient(); // 認証クライアントを返す
};

const processSheets = async (sheetId, range) => {
    const allSheetNames = await getAllSheetNames(sheetId); // 全シート名を取得

    // rangeにシート名が含まれているかを確認し、含まれていればそのまま使用
    const [sheetNameInRange, cellRange] = range.includes('!') ? range.split('!') : [null, range];

    if (sheetNameInRange) {
        // シート名がすでに含まれている場合、そのシートのみを処理
        const rows = await getSheetData(sheetId, range); // シート名をそのまま使う
        if (!rows || !rows.length) {
            console.log(`No data found in sheet: ${sheetNameInRange}`);
            return;
        }

        const fileName = `${objectKeyPrefix}_${sheetNameInRange}.json`;
        let previousStatuses = await readStatusesFromS3(fileName);

        const checks = rows.map((row, index) => checkServerStatus(row, index, sheetId, sheetNameInRange, previousStatuses));
        const results = await Promise.allSettled(checks);

        const currentStatuses = await generateCurrentStatuses(rows);
        await writeStatusesToS3(currentStatuses, fileName);
        await updateSheet(sheetId, range, results);
    } else {
        // シート名が含まれていない場合、全シートを処理
        for (const sheetName of allSheetNames) {
            const fullRange = `${sheetName}!${cellRange}`;
            const rows = await getSheetData(sheetId, fullRange);

            if (!rows || !rows.length) {
                console.log(`No data found in sheet: ${sheetName}`);
                continue;
            }

            const fileName = `${objectKeyPrefix}_${sheetName}.json`;
            let previousStatuses = await readStatusesFromS3(fileName);

            const checks = rows.map((row, index) => checkServerStatus(row, index, sheetId, sheetName, previousStatuses));
            const results = await Promise.allSettled(checks);

            const currentStatuses = await generateCurrentStatuses(rows);
            await writeStatusesToS3(currentStatuses, fileName);
            await updateSheet(sheetId, fullRange, results);
        }
    }
};

// Google Sheetsの全シート名を取得する関数
const getAllSheetNames = async (sheetId) => {
    const response = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
    });
    return response.data.sheets.map(sheet => sheet.properties.title); // すべてのシート名を取得
};

// Google SheetsからシートIDを取得する関数
const getSheetId = async (sheetId, sheetName) => {
    const response = await sheets.spreadsheets.get({
        spreadsheetId: sheetId,
    });
    const sheet = response.data.sheets.find(s => s.properties.title === sheetName);

    if (sheet) {
        return sheet.properties.sheetId;
    } else {
        throw new Error(`Sheet with name ${sheetName} not found in spreadsheet ${sheetId}`);
    }
};

// Google Sheetsからデータを取得する関数
const getSheetData = async (sheetId, range) => {
    // シート名とセル範囲を分離する
    const [sheetName, cellRange] = range.includes('!') ? range.split('!') : [null, range];

    // シート名がない場合のエラーチェック
    if (!sheetName || sheetName.trim() === '') {
        throw new Error('Invalid range: シート名が指定されていません');
    }

    // 正しいリクエストURLを生成し、データを取得
    const requestRange = `${sheetName}!${cellRange}`;

    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: requestRange, // 正しいリクエスト範囲
        });
        return res.data.values; // スプレッドシートの値を返す
    } catch (error) {
        console.error('Error fetching sheet data:', error);
        throw error;
    }
};

// S3にステータスを保存する関数
const writeStatusesToS3 = async (statuses, fileName) => {
    const params = {
        Bucket: process.env.S3_BUCKET_NAME, // S3バケット名
        Key: fileName, // S3に保存するファイルの名前
        Body: JSON.stringify(statuses, null, 2), // JSONデータを文字列化して保存
        ContentType: 'application/json', // コンテンツタイプをJSONとして設定
    };
    await s3Client.send(new PutObjectCommand(params)); // S3にデータを書き込む
};

// S3からステータスを読み込む関数
const readStatusesFromS3 = async (fileName) => {
    try {
        const data = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME, // S3バケット名
            Key: fileName, // S3からロードするファイルの名前
        }));
        const statusData = await streamToString(data.Body); // ストリームデータを文字列に変換
        return JSON.parse(statusData); // 文字列をJSONに変換して返す
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            return {}; // ファイルが存在しない場合は空のオブジェクトを返す
        } else {
            throw error; // それ以外のエラーはスロー
        }
    }
};

// ストリームデータを文字列に変換する関数
const streamToString = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk)); // データを受信
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); // 全てのデータが揃ったら文字列に変換
        stream.on('error', reject); // エラーが発生したら拒否
    });
};

// Googleスプレッドシートの内容を基にJSONデータを生成する関数
const generateCurrentStatuses = async (rows) => {
    const currentStatuses = {};
    for (let i = 0; i < rows.length; i++) {
        const serverName = rows[i][0]; // A列: サーバー名 
        const serverUrl = rows[i][1]; // B列: サーバーURL
        const status = rows[i][2]; // C列: ステータス
        const lastUpdate = rows[i][3]; // D列: 最終更新日時

        if (serverName || serverUrl) {
            const key = serverName || serverUrl; // A列が空ならB列をキーに使用
            currentStatuses[key] = {
                status,
                lastUpdate,
            };
        }
    }
    return currentStatuses; // ステータスデータを返す
};

// サーバーステータスのチェックとSlack通知を行う関数
const checkServerStatus = async (row, index, sheetId, sheetName, previousStatuses) => {
    let serverName = row[0]; // A列: サーバー名
    const serverUrl = row[1]; // B列: サーバーURL
    const sheetIdInt = await getSheetId(sheetId, sheetName);
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${sheetIdInt}&range=${index + 2}:${index + 2}`; // Google Sheetsのリンク

    if (!serverName && !serverUrl) {
        delete previousStatuses[serverName]; // サーバー名とサーバーURL共に空の場合はステータスから削除
        return { index, serverName: null, serverUrl: null, status: '', color: 'white', lastUpdate: '' }; // CとDも空にする
    }
    // サーバーURLが空の場合は処理をスキップ
    if (!serverUrl || serverUrl.trim() === '') {
        return { index, serverName: null, serverUrl: null, status: '', color: 'white', lastUpdate: '' }; // スキップとして扱う
    }

    if (!serverName) {
        serverName = serverUrl; // サーバー名が空でサーバーURLがある場合、B列のURLをサーバー名として使用
    }

    const previousStatus = previousStatuses[serverName] ? previousStatuses[serverName].status : null;

    try {
        const response = await axios.get(serverUrl, { timeout: 5000 });
        const newStatus = `OK Status:${response.status}`;

        if (!previousStatus || previousStatus !== newStatus) {
            await sendSlackNotification({
                serverName,
                serverUrl,
                status: newStatus,
                lastUpdate: getCurrentJST(),
                sheetUrl
            }, 'recovery', sheetName); // 復旧時の通知
        }

        previousStatuses[serverName] = { status: newStatus, lastUpdate: getCurrentJST() };
        return { index, serverName, serverUrl, status: newStatus, color: 'white', lastUpdate: getCurrentJST() };
    } catch (error) {
        let customStatus = '';
        if (error.code === 'ENOTFOUND') {
            customStatus = 'ERROR! Server not reachable';
        } else {
            customStatus = `ERROR! ${error.response ? `Status:${error.response.status}` : error.message}`;
        }

        if (!previousStatus || previousStatus !== customStatus) {
            await sendSlackNotification({
                serverName,
                serverUrl,
                status: customStatus,
                lastUpdate: getCurrentJST(),
                sheetUrl
            }, 'error', sheetName); // エラー時の通知
        }

        previousStatuses[serverName] = { status: customStatus, lastUpdate: getCurrentJST() }; // ステータスを更新
        return { index, serverName, serverUrl, status: customStatus, color: 'red', lastUpdate: getCurrentJST() }; // エラー時のステータス
    }
};

// Slack Block Kit形式で通知を送信する関数
const sendSlackNotification = async (statusData, type, sheetName = null) => {
    const headerText = type === 'error'
        ? ":rotating_light: Server health check failure :rotating_light:" // エラー時の通知
        : ":white_check_mark: Server is now alive :white_check_mark:"; // 復旧時の通知

    // シート名を含めるかどうかを制御
    const header = sheetName && sheetName !== 'シート1' ? `${headerText} - ${sheetName}` : `${headerText}`;

    const payload = {
        blocks: [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: header, // シート名が指定されていない場合はシート名を通知内容に含める
                    emoji: true
                }
            },
            {
                type: "section",
                fields: [
                    {
                        type: "mrkdwn",
                        text: `*Server Name:*\n${statusData.serverName || 'N/A'}` // サーバー名
                    },
                    {
                        type: "mrkdwn",
                        text: `*Server URL:*\n${statusData.serverUrl || 'N/A'}` // サーバーURL
                    }
                ]
            },
            {
                type: "section",
                fields: [
                    {
                        type: "mrkdwn",
                        text: `*Status:*\n:${type === 'error' ? 'red_circle' : 'large_green_circle'}: ${statusData.status}`
                    },
                    {
                        type: "mrkdwn",
                        text: `*Last Updated:*\n${statusData.lastUpdate}`
                    }
                ]
            },
            {
                type: "divider"
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "View in Google Sheets",
                            emoji: true
                        },
                        value: "view_sheets",
                        url: `${statusData.sheetUrl}` // Google SheetsのURL
                    }
                ]
            }
        ]
    };

    // Slackにメッセージを送信するためのオプション設定
    const options = {
        hostname: 'hooks.slack.com',
        path: `/services/${SLACK_WEBHOOK_URL.split('https://hooks.slack.com/services/')[1]}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
        },
    };

    // Slack通知を送信するHTTPリクエスト
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => console.log(`Slack response: ${chunk}`)); // Slackからのレスポンス
            res.on('end', () => resolve()); // 完了
        });
        req.on('error', (e) => {
            console.error("Slack notification error:", e); // エラーログ
            reject(e);
        });
        req.write(JSON.stringify(payload)); // メッセージを送信
        req.end();
    });
};

// 現在のJSTの時刻を取得する関数
const getCurrentJST = () => {
    const now = new Date();
    now.setHours(now.getHours() + 9); // UTC+9の日本標準時に変換
    return now.toISOString().replace('T', ' ').split('.')[0] + ' UTC+0900 (JST)';
};

// スプレッドシートの更新とセルの色設定を同時に行う関数
async function updateSheet(sheetId, range, results) {
    const colorMap = {
        'red': { red: 0.956, green: 0.8, blue: 0.8 }, // エラーカラー
        'white': { red: 1, green: 1, blue: 1 }        // 正常カラー
    };

    const [sheetName, cellRange] = range.split('!');
    const sheetIdInt = await getSheetId(sheetId, sheetName); // シートIDを取得
    const startColumn = cellRange.match(/[A-Z]+/g)[0];
    const startRow = parseInt(cellRange.match(/\d+/g)[0], 10);
    const statusColumn = String.fromCharCode(startColumn.charCodeAt(0) + 2); // C列
    const lastUpdateColumn = String.fromCharCode(startColumn.charCodeAt(0) + 3); // D列

    const updateRange = `${sheetName}!${statusColumn}${startRow}:${lastUpdateColumn}${startRow + results.length - 1}`;

    console.log(`Updating sheet with range: ${updateRange}`); // デバッグ: 更新範囲を出力

    const requests = results.map(result => {
        const { index, status, lastUpdate, color } = result.value || result.reason;

        return {
            updateCells: {
                range: {
                    sheetId: sheetIdInt, // 正しいシートIDを使用
                    startRowIndex: index + startRow - 1,
                    endRowIndex: index + startRow,
                    startColumnIndex: statusColumn.charCodeAt(0) - 'A'.charCodeAt(0),
                    endColumnIndex: lastUpdateColumn.charCodeAt(0) - 'A'.charCodeAt(0) + 1
                },
                rows: [
                    {
                        values: [
                            { userEnteredValue: { stringValue: status }, userEnteredFormat: { backgroundColor: colorMap[color] } },
                            { userEnteredValue: { stringValue: lastUpdate } }
                        ]
                    }
                ],
                fields: 'userEnteredValue,userEnteredFormat.backgroundColor'
            }
        };
    });

    const request = {
        spreadsheetId: sheetId,
        resource: { requests },
    };

    try {
        const response = await sheets.spreadsheets.batchUpdate(request);
        console.log('Batch update response:', response.data); // デバッグ: 更新結果を出力
    } catch (error) {
        console.error('Error in updateSheet:', error); // エラーログを出力
        throw error;
    }
}

// Lambda関数のメイン処理
exports.handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));
    try {
        const authClient = await getAuthClient();
        google.options({ auth: authClient });

        const sheetId = process.env.SPREADSHEET_ID;
        const range = process.env.RANGE;

        // シート名が指定されている場合、そのシートに対して処理
        await processSheets(sheetId, range);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Server health check complete.' })
        };
    } catch (error) {
        console.error("Error:", error);
        await sendSlackNotification({ status: `An error occurred: ${error.message}` }, 'error');
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'An error occurred.', error: error.message })
        };
    }
};
