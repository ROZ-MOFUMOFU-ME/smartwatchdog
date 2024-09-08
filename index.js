const { google } = require('googleapis');
const axios = require('axios');
const sheets = google.sheets('v4');
const https = require('https');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// AWS S3クライアントを初期化
const s3Client = new S3Client({ region: process.env.AWS_REGION }); // AWSのリージョンを環境変数から取得
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL; // Slack Webhook URLを環境変数から取得
const bucketName = process.env.S3_BUCKET_NAME; // S3バケット名を環境変数から取得
const objectKey = 'server_status.json'; // S3に保存するファイル名

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

// Google Sheetsからデータを取得する関数
const getSheetData = async (sheetId, range) => {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: range,
    });
    return res.data.values; // スプレッドシートの値を返す
};

// S3にステータスを保存する関数
const writeStatusesToS3 = async (statuses) => {
    const params = {
        Bucket: bucketName, // S3バケット名
        Key: objectKey, // S3に保存するファイルの名前
        Body: JSON.stringify(statuses, null, 2), // JSONデータを文字列化して保存
        ContentType: 'application/json', // コンテンツタイプをJSONとして設定
    };
    await s3Client.send(new PutObjectCommand(params)); // S3にデータを書き込む
};

// S3からステータスを読み込む関数
const readStatusesFromS3 = async () => {
    try {
        const data = await s3Client.send(new GetObjectCommand({
            Bucket: bucketName,
            Key: objectKey,
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
        const serverUrl = rows[i][1];  // B列: サーバーURL
        const status = rows[i][2];     // C列: ステータス
        const lastUpdate = rows[i][3]; // D列: 最終更新日時

        if (serverName || serverUrl) {
            const key = serverName || serverUrl; // A列が空ならB列をキーに使用
            currentStatuses[key] = {
                status,
                lastUpdate,
            };
        }
    }
    return currentStatuses; // 現在のステータスを返す
};

// サーバーステータスのチェックとSlack通知を行う関数
const checkServerStatus = async (row, index, sheetId, previousStatuses) => {
    let serverName = row[0]; // A列: サーバー名
    const serverUrl = row[1]; // B列: サーバーURL
    const serverStatus = row[2]; // C列: サーバーステータス
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=0#gid=0&range=${index + 2}:${index + 2}`; // Google Sheetsのリンク

    if (!serverName && !serverUrl) {
        delete previousStatuses[serverName]; // ステータスから削除
        return { index, serverName: null, serverUrl: null, status: '', color: 'white', lastUpdate: '' }; // CとDも空にする
    }

    if (!serverName) {
        serverName = serverUrl; // B列のURLをサーバー名として使用
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
            }, 'recovery'); // 復旧時の通知
        }

        previousStatuses[serverName] = { status: newStatus, lastUpdate: getCurrentJST() };
        return { index, serverName, serverUrl, status: newStatus, color: 'white', lastUpdate: getCurrentJST() };
    } catch (error) {
        let customStatus = '';
        if (error.code === 'ENOTFOUND') {
            customStatus = 'ERROR! Not found';
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
            }, 'error'); // エラー時の通知
        }

        previousStatuses[serverName] = { status: customStatus, lastUpdate: getCurrentJST() };
        return { index, serverName, serverUrl, status: customStatus, color: 'red', lastUpdate: getCurrentJST() };
    }
};

// Slack Block Kit形式で通知を送信する関数
const sendSlackNotification = async (statusData, type) => {
    const headerText = type === 'error' 
        ? ":rotating_light: Server health check failure :rotating_light:"
        : ":white_check_mark: Server is now alive :white_check_mark:";

    const payload = {
        blocks: [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: headerText, // エラーか復旧かによってヘッダーを変更
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
                        text: `*Status:*\n:${type === 'error' ? 'red' : 'large_green'}_circle: ${statusData.status}` // サーバーステータスに色付きアイコン
                    },
                    {
                        type: "mrkdwn",
                        text: `*Last Updated:*\n${statusData.lastUpdate}` // 最終更新日時
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
        path: '/services/' + SLACK_WEBHOOK_URL.split('https://hooks.slack.com/services/')[1],
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': JSON.stringify(payload).length,
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
        'red': { red: 0.956, green: 0.8, blue: 0.8 }, // R244 G204 B204
        'white': { red: 1, green: 1, blue: 1 }
    };

    const [sheetName, cellRange] = range.split('!');
    const startColumn = cellRange.match(/[A-Z]+/g)[0];
    const startRow = parseInt(cellRange.match(/\d+/g)[0], 10);
    const statusColumn = String.fromCharCode(startColumn.charCodeAt(0) + 2); // C列
    const lastUpdateColumn = String.fromCharCode(startColumn.charCodeAt(0) + 3); // D列

    const updateRange = `${sheetName}!${statusColumn}${startRow}:${lastUpdateColumn}${startRow + results.length - 1}`;

    const requests = results.map(result => {
        const { index, status, lastUpdate, color } = result.value || result.reason;

        return {
            updateCells: {
                range: {
                    sheetId: 0,
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
        console.log('Batch update response:', response.data);
    } catch (error) {
        console.error('Error in updateSheet:', error);
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

        const rows = await getSheetData(sheetId, range); 
        if (!rows || !rows.length) {
            console.log('No data found.');
            return response(200, 'No data found.');
        }

        let previousStatuses = await readStatusesFromS3();

        const checks = rows.map((row, index) => checkServerStatus(row, index, sheetId, previousStatuses));
        const results = await Promise.allSettled(checks);

        await updateSheet(sheetId, range, results);

        const currentStatuses = await generateCurrentStatuses(rows);

        await writeStatusesToS3(currentStatuses);

        return response(200, 'Server health check complete.');
    } catch (error) {
        console.error("Error:", error);
        await sendSlackNotification({ status: `An error occurred: ${error.message}` }, 'error');
        return response(500, 'An error occurred.');
    }
};

// 汎用レスポンス関数
const response = (statusCode, message) => ({
    statusCode, 
    body: message, 
});
