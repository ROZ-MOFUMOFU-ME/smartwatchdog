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
            client_email: process.env.GOOGLE_CLIENT_EMAIL, // 環境変数からサービスアカウントのメールアドレスを取得
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // 改行コードを適切に変換
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Google Sheets APIのスコープ
    });
    return await auth.getClient(); // 認証クライアントを返す
};

// リトライロジックを含むGoogle Sheetsの全シート名とシートIDを取得する関数
const getAllSheetNamesAndIds = async (sheetId, retries = 10, delay = 5000) => {
    let retryCount = 0; // リトライ回数をカウント
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: sheetId,
        });
        return response.data.sheets.map(sheet => ({
            title: sheet.properties.title,
            id: sheet.properties.sheetId
        })); // すべてのシート名とシートIDを取得
    } catch (error) {
        if (retries > 0 && error.code === 429) {
            retryCount++;
            if (retryCount % 5 === 0) {
                console.warn(`Quota exceeded, retrying... (${retries} retries left, ${retryCount} attempts so far)`);
            }
            await new Promise(resolve => setTimeout(resolve, delay)); // 指数バックオフで待機時間を増やす
            return getAllSheetNamesAndIds(sheetId, retries - 1, delay * 2);
        } else {
            if (retryCount > 0) {
                console.warn(`Quota exceeded, retried ${retryCount} times`);
            }
            throw error;
        }
    }
};

// Google Sheetsのシート名から特定のシートIDを取得する関数
const getSheetId = async (sheetId, sheetName) => {
    const sheets = await getAllSheetNamesAndIds(sheetId);
    const sheet = sheets.find(s => s.title === sheetName);

    if (sheet) {
        return sheet.id; // シートが見つかった場合はシートIDを返す
    } else {
        throw new Error(`Sheet with name ${sheetName} not found in spreadsheet ${sheetId}`); // シートが見つからない場合はエラー
    }
};

// Google Sheetsからデータを取得する関数
const getSheetData = async (sheetId, range) => {
    // シート名とセル範囲を分離する
    const [sheetName, cellRange] = range.includes('!') ? range.split('!') : [null, range];

    // シート名がない場合のエラーチェック
    if (!sheetName || sheetName.trim() === '') {
        throw new Error('Invalid range: Sheet name is not specified');
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
        console.error('Error fetching sheet data:', error); // シートデータの取得エラーをログ出力
        throw error;
    }
};

// S3にステータスを保存する関数
const writeStatusesToS3 = async (statuses, fileName, sheetUrl) => {
    const dataToWrite = {
        sheetUrl, // スプレッドシートのURLを追加
        statuses, // ステータスデータ
    };

    const params = {
        Bucket: process.env.S3_BUCKET_NAME, // S3バケット名
        Key: fileName, // S3に保存するファイルの名前
        Body: JSON.stringify(dataToWrite, null, 2), // JSONデータを文字列化して保存
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
    const currentStatuses = {}; // 現在のステータスを格納するオブジェクト
    const removedStatuses = {}; // 削除されたステータスを格納するオブジェクト

    for (let i = 0; i < rows.length; i++) {
        const [serverName, serverUrl, status, lastUpdate] = rows[i];
        if (serverName || serverUrl) {
            const key = serverName || serverUrl; // A列が空ならB列をキーに使用
            currentStatuses[key] = { status, lastUpdate }; // ステータスと最終更新日時を格納
        }
    }

    return { currentStatuses, removedStatuses }; // 現在のステータスと削除されたステータスを返す
};

// サーバーステータスのチェックとSlack通知を行う関数
const checkServerStatus = async (row, index, sheetId, sheetName, previousStatuses, currentStatuses) => {
    let [serverName, serverUrl] = row; // サーバー名とサーバーURLを取得
    const sheetIdInt = await getSheetId(sheetId, sheetName); // シートIDを取得
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${sheetIdInt}&range=${index + 2}:${index + 2}`; // Google Sheetsのリンク

    if (!serverName && !serverUrl) {
        // サーバー名とサーバーURLが共に空の場合、C列とD列を削除し、ステータスも削除
        return {
            index,
            deleteColumns: true, // C列とD列を削除するフラグを返す
        };
    }

    if (!serverUrl || serverUrl.trim() === '') {
        return null; // サーバーURLが空の場合は処理をスキップ
    }

    if (!serverName) {
        serverName = serverUrl; // サーバー名が空の場合、サーバーURLをサーバー名として使用
    }

    const previousStatus = previousStatuses[serverName]?.status || null; // 前回のステータスを取得
    let newStatus = ''; // 新しいステータスを初期化

    try {
        const response = await axios.get(serverUrl, { timeout: 5000 });
        newStatus = `OK Status:${response.status}`; // ステータスが200の場合はOK
    } catch (error) {
        newStatus = error.code === 'ENOTFOUND' ? 'ERROR! Server not reachable' : `ERROR! ${error.response ? `Status:${error.response.status}` : error.message}`; // エラーの場合はエラーステータス
    }

    // ステータスに変化がない場合は処理をスキップ
    if (previousStatus === newStatus) {
        return null;
    }

    // ステータスを更新し、後でS3に保存するためにcurrentStatusesに追加
    currentStatuses[serverName] = { status: newStatus, lastUpdate: getCurrentJST() };

    // ステータスに変化があった場合にSlack通知を送信
    const notificationType = newStatus.startsWith('OK') ? 'recovery' : 'error';
    await sendSlackNotification({ serverName, serverUrl, status: newStatus, lastUpdate: getCurrentJST(), sheetUrl }, notificationType, sheetName);

    return { index, serverName, serverUrl, status: newStatus, color: newStatus.startsWith('OK') ? 'white' : 'red', lastUpdate: getCurrentJST() }; // ステータスと色を返す
};

// Slack Block Kit形式で通知を送信する関数
const sendSlackNotification = async (statusData, type, sheetName = null) => {
    const headerText = type === 'error'
        ? ":rotating_light: Server health check failure" // エラー時の通知
        : ":white_check_mark: Server is now alive"; // 復旧時の通知

    // シート名を含めるかどうかを制御、「シート1」の場合はシート名を含めない
    const header = sheetName && sheetName !== 'シート1' ? `${headerText} - ${sheetName}` : `${headerText}`;

    const payload = {
        blocks: [
            { type: "header", text: { type: "plain_text", text: header, emoji: true } },
            { type: "section", fields: [{ type: "mrkdwn", text: `*Server Name:*\n${statusData.serverName || 'N/A'}` }, { type: "mrkdwn", text: `*Server URL:*\n${statusData.serverUrl || 'N/A'}` }] },
            { type: "section", fields: [{ type: "mrkdwn", text: `*Status:*\n:${type === 'error' ? 'red_circle' : 'large_green_circle'}: ${statusData.status}` }, { type: "mrkdwn", text: `*Last Updated:*\n${statusData.lastUpdate}` }] },
            { type: "divider" },
            { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "View in Google Sheets", emoji: true }, value: "view_sheets", url: `${statusData.sheetUrl}` }] }
        ]
    };

    // Slackにメッセージを送信するためのオプション設定
    const options = {
        hostname: 'hooks.slack.com',
        path: `/services/${SLACK_WEBHOOK_URL.split('https://hooks.slack.com/services/')[1]}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) },
    };

    // Slack通知を送信するHTTPリクエスト
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            res.setEncoding('utf8');
            let responseCount = 0; // レスポンスカウントを初期化
            res.on('data', (chunk) => {
                responseCount++;
                if (responseCount % 5 === 0) { // 5回ごとにログを出力
                    console.log(`Slack response: ${chunk}`);
                }
            }); // Slackからのレスポンス
            res.on('end', () => resolve()); // 通知が成功した場合は完了
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
const updateSheet = async (sheetId, range, results) => {
    const colorMap = { 
        'red': { red: 0.956, green: 0.8, blue: 0.8 }, // エラー時の色
        'white': { red: 1, green: 1, blue: 1 }, // デフォルトのホワイト
    };

    const [sheetName, cellRange] = range.split('!');
    const sheetIdInt = await getSheetId(sheetId, sheetName);
    const startColumn = cellRange.match(/[A-Z]+/g)[0];
    const startRow = parseInt(cellRange.match(/\d+/g)[0], 10);
    const statusColumn = String.fromCharCode(startColumn.charCodeAt(0) + 2); // C列
    const lastUpdateColumn = String.fromCharCode(startColumn.charCodeAt(0) + 3); // D列

    const validResults = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
    const requests = validResults.map(result => {
        const { index, status, lastUpdate, color, deleteColumns, needsUpdate } = result;

        // A列とB列が空の場合、C列とD列を削除し、色をデフォルトに戻す
        if (deleteColumns) {
            return {
                updateCells: {
                    range: {
                        sheetId: sheetIdInt,
                        startRowIndex: index + startRow - 1,
                        endRowIndex: index + startRow,
                        startColumnIndex: statusColumn.charCodeAt(0) - 'A'.charCodeAt(0),
                        endColumnIndex: lastUpdateColumn.charCodeAt(0) - 'A'.charCodeAt(0) + 1,
                    },
                    rows: [
                        {
                            values: [
                                { userEnteredValue: null, userEnteredFormat: { backgroundColor: colorMap['white'] } }, // C列（ステータス）をクリアしてホワイトに設定
                                { userEnteredValue: null, userEnteredFormat: { backgroundColor: colorMap['white'] } }, // D列（最終更新日時）をクリアしてホワイトに設定
                            ],
                        },
                    ],
                    fields: 'userEnteredValue,userEnteredFormat.backgroundColor', // 値と色をクリア
                },
            };
        }

        // C列とD列が空の場合、新しいステータスと更新日時を設定
        if (needsUpdate) {
            return {
                updateCells: {
                    range: {
                        sheetId: sheetIdInt,
                        startRowIndex: index + startRow - 1,
                        endRowIndex: index + startRow,
                        startColumnIndex: statusColumn.charCodeAt(0) - 'A'.charCodeAt(0),
                        endColumnIndex: lastUpdateColumn.charCodeAt(0) - 'A'.charCodeAt(0) + 1,
                    },
                    rows: [
                        {
                            values: [
                                { userEnteredValue: { stringValue: status }, userEnteredFormat: { backgroundColor: colorMap[color] } }, // ステータスと色を設定
                                { userEnteredValue: { stringValue: lastUpdate }, userEnteredFormat: { backgroundColor: colorMap['white'] } }, // 更新日時は常に白色
                            ],
                        },
                    ],
                    fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
                },
            };
        }

        return {
            updateCells: {
                range: {
                    sheetId: sheetIdInt, // 正しいシートIDを使用
                    startRowIndex: index + startRow - 1,
                    endRowIndex: index + startRow,
                    startColumnIndex: statusColumn.charCodeAt(0) - 'A'.charCodeAt(0),
                    endColumnIndex: lastUpdateColumn.charCodeAt(0) - 'A'.charCodeAt(0) + 1,
                },
                rows: [
                    {
                        values: [
                            { userEnteredValue: { stringValue: status }, userEnteredFormat: { backgroundColor: colorMap[color] } }, // ステータスと色を設定
                            { userEnteredValue: { stringValue: lastUpdate }, userEnteredFormat: { backgroundColor: colorMap['white'] } }, // 更新日時は常に白色
                        ],
                    },
                ],
                fields: 'userEnteredValue,userEnteredFormat.backgroundColor',
            },
        };
    });

    if (requests.length > 0) { // リクエストがある場合のみシートを更新
        const request = { spreadsheetId: sheetId, resource: { requests } };
        try {
            const response = await sheets.spreadsheets.batchUpdate(request);
            console.log('Batch update response:', response.data); // デバッグ: 更新結果を出力
        } catch (error) {
            console.error('Error in updateSheet:', error); // エラーログを出力
            throw error;
        }
    }
};

// Lambda関数のメイン処理
exports.handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2)); // イベントをログ出力
    try {
        const authClient = await getAuthClient();
        google.options({ auth: authClient });

        const sheetId = process.env.SPREADSHEET_ID;
        const range = process.env.RANGE;

        // シート名が指定されている場合、そのシートに対して処理
        await processSheets(sheetId, range);
        return { statusCode: 200, body: JSON.stringify({ message: 'Server health check complete.' }) };
    } catch (error) {
        console.error("Error:", error);
        await sendSlackNotification({ status: `An error occurred: ${error.message}` }, 'error'); // エラー通知を送信
        return { statusCode: 500, body: JSON.stringify({ message: 'An error occurred.', error: error.message }) };
    }
};

// シートの処理関数
const processSheets = async (sheetId, range) => {
    const allSheetNames = await getAllSheetNamesAndIds(sheetId); // 全シート名を取得
    const [sheetNameInRange, cellRange] = range.includes('!') ? range.split('!') : [null, range]; // // rangeにシート名が含まれているかを確認し、含まれていればそのまま使用
    console.log(`All sheets: ${allSheetNames.map(sheet => sheet.title).join(', ')}`); // シート名全てをログ出力

    if (sheetNameInRange) {
        // rangeにシート名が含まれている場合、そのシートのみを処理
        await processSingleSheet(sheetId, range, sheetNameInRange);
    } else {
        // rangeにシート名が含まれていない場合、全てのシートを処理
        for (const sheet of allSheetNames) {
            const fullRange = `${sheet.title}!${cellRange}`;
            await processSingleSheet(sheetId, fullRange, sheet.title);
        }
    }
};

// 各シートの処理関数
const processSingleSheet = async (sheetId, range, sheetName) => {
    console.log(`Processing sheet: ${sheetName}`); // 処理対象のシート名をログ出力

    const rows = await getSheetData(sheetId, range);
    if (!rows || !rows.length) {
        console.log(`No data found in sheet: ${sheetName}`); // データが見つからない場合のログ
        return;
    }

    // S3に保存するファイル名を生成
    const fileName = `${objectKeyPrefix}_${sheetName}.json`;
    let previousData = await readStatusesFromS3(fileName);
    let previousStatuses = previousData.statuses || {};
    let previousSheetUrl = previousData.sheetUrl || '';

    const { currentStatuses, removedStatuses } = await generateCurrentStatuses(rows); // 現在のステータスと削除されたステータスを取得

    // 削除されたサーバーをpreviousStatusesから削除
    const previousKeys = Object.keys(previousStatuses); // 前回のステータスのキーを取得
    const currentKeys = Object.keys(currentStatuses); // 現在のステータスのキーを取得

    previousKeys.forEach(key => {
        if (!currentKeys.includes(key)) {
            removedStatuses[key] = true;
        }
    });

    for (const key in removedStatuses) {
        if (previousStatuses[key]) {
            delete previousStatuses[key];
        }
    }

    // ステータスを個別にチェック
    const checks = rows.map((row, index) => checkServerStatus(row, index, sheetId, sheetName, previousStatuses, currentStatuses));
    const results = await Promise.allSettled(checks); // すべてのチェックを待機

    // updateSheetを呼ぶ前にステータスの変更を確認
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=${await getSheetId(sheetId, sheetName)}`; // Google Sheetsのリンク
    const hasChanges = Object.keys(currentStatuses).some(key => { // 変更があるかどうかを確認
        return !previousStatuses[key] || JSON.stringify(previousStatuses[key]) !== JSON.stringify(currentStatuses[key]); // 前回のステータスと現在のステータスが異なる場合
    }) || Object.keys(removedStatuses).length > 0 || previousSheetUrl !== sheetUrl; // 削除されたステータスがある場合やシートURLが異なる場合も変更とみなす

    // currentStatusesをフィルタリングして削除されたステータスを除外
    if (hasChanges || results.some(result => result.value && result.value.deleteColumns)) { // 変更があるか、削除されたステータスがある場合
        await writeStatusesToS3({ ...previousStatuses, ...currentStatuses }, fileName, sheetUrl); // 前回のステータスと今回の変更をマージしてS3に保存
        await updateSheet(sheetId, range, results); // 変更があったサーバーのみシートを更新
        console.log(`S3 and sheet updated with status changes in ${sheetName}.`); // S3とシートの更新が完了したログ
    } else {
        console.log(`No status changes detected in ${sheetName}.`); // シートに変更がない場合のログ
    }
};
