const { google } = require('googleapis');
const axios = require('axios');
const sheets = google.sheets('v4');
const https = require('https');

// SlackのWebhook URLを環境変数から取得
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

exports.handler = async (event) => {
    try {
        // Google認証情報の設定
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // 改行文字を適切に処理
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Google Sheets APIのスコープ
        });

        // 認証クライアントを取得
        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        // スプレッドシートIDと範囲を環境変数から取得
        const sheetId = process.env.SPREADSHEET_ID;
        const range = process.env.RANGE;

        // スプレッドシートのデータを取得
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: range,
        });

        // 取得したデータを行ごとに分割
        const rows = res.data.values;

        // データが存在しない場合の処理
        if (!rows.length) {
            console.log('No data found.');
            return {
                statusCode: 200,
                body: 'No data found.',
            };
        }

        // 前回のステータスを保持するオブジェクト
        let previousStatuses = {};

        // サーバーチェックを非同期に処理する
        const checks = rows.map(async (row, index) => {
            const serverName = row[0]; // サーバー名
            const serverUrl = row[1]; // サーバーURL
            const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0&range=A${index + 2}`;

            try {
                // サーバーのステータスをHTTPリクエストでチェック
                const response = await axios.get(serverUrl, { timeout: 5000 });
                const newStatus = 'OK';
                if (previousStatuses[serverName] && previousStatuses[serverName] !== newStatus) {
                    await sendSlackNotification(`Server <${sheetUrl}|${serverName}> is now alive.`);
                }
                previousStatuses[serverName] = newStatus;
                return { index, status: newStatus, lastUpdate: getCurrentJST() }; // ステータスが200の場合
            } catch (error) {
                const statusCode = error.response ? error.response.status : 'Unknown';
                let customStatus;
                let errorMessage;

                if (error.code === 'ENOTFOUND') {
                    customStatus = 'NOT_FOUND';
                    errorMessage = `Server <${sheetUrl}|${serverName}> is not found.`;
                } else {
                    customStatus = `ERROR! (${statusCode})`;
                    errorMessage = `Server <${sheetUrl}|${serverName}> has problem! Error code: ${statusCode}`;
                }

                if (previousStatuses[serverName] !== customStatus) {
                    previousStatuses[serverName] = customStatus;
                    if (error.code !== 'ENOTFOUND') {
                        await sendSlackNotification(errorMessage);
                    }
                }
                return { index, status: customStatus, lastUpdate: getCurrentJST() }; // エラーが発生した場合
            }
        });

        // 全てのチェックが完了するのを待つ
        const results = await Promise.all(checks);

        // スプレッドシートの更新
        for (const { index, status, lastUpdate } of results) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `${range.split('!')[0]}!C${index + 2}:D${index + 2}`, // C2以降とD2以降に書き込み
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[status, lastUpdate]], // ステータスと最終更新日時を更新
                },
            });
        }

        return {
            statusCode: 200,
            body: 'Server health check complete.',
        };
    } catch (error) {
        await sendSlackNotification(`An error occurred: ${error.message}`); // エラーが発生した場合にSlackに通知
        return {
            statusCode: 500,
            body: 'An error occurred.',
        };
    }
};

// Slackに通知を送信する関数
const sendSlackNotification = async (message) => {
    const payload = JSON.stringify({ text: message });

    const options = {
        hostname: 'hooks.slack.com',
        path: '/services/' + SLACK_WEBHOOK_URL.split('https://hooks.slack.com/services/')[1], // Webhookのパスを設定
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                console.log(`Response: ${chunk}`);
            });
            res.on('end', () => {
                resolve();
            });
        });

        req.on('error', (e) => {
            console.error(`Problem with request: ${e.message}`);
            reject(e);
        });

        req.write(payload);
        req.end();
    });
};

// 現在の日時を日本標準時（JST）で取得する関数
const getCurrentJST = () => {
    const now = new Date();
    now.setHours(now.getHours() + 9); // JSTはUTC+9
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds} UTC+0900 (JST)`; // フォーマットを「YYYY/MM/DD HH:MM:SS UTC+0900 (JST)」に設定
};