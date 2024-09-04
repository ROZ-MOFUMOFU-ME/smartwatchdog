const { google } = require('googleapis');
const axios = require('axios');
const sheets = google.sheets('v4');

exports.handler = async (event) => {
    // Google Sheets API認証
    const auth = new google.auth.GoogleAuth({
        keyFile: 'secret.json',
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const authClient = await auth.getClient();
    google.options({ auth: authClient });

    // スプレッドシートIDと範囲を指定
    const spreadsheetId = '1mcIUsQ4W92PAXEm-k0y5WvBFFFg4HEuH4zjlDEp-Vkw';
    const range = 'Sheet1!A2:B';

    // スプレッドシートからデータを取得
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    });

    const rows = res.data.values;

    if (!rows.length) {
        console.log('No data found.');
        return {
            statusCode: 200,
            body: 'No data found.',
        };
    }

    // サーバーの死活監視
    for (const row of rows) {
        const serverName = row[0];
        const serverUrl = row[1];

        try {
            const response = await axios.get(serverUrl, { timeout: 5000 });
            if (response.status === 200) {
                console.log(`Server ${serverName} is alive.`);
            } else {
                console.log(`Server ${serverName} is down.`);
            }
        } catch (error) {
            console.log(`Server ${serverName} is down. Error: ${error.message}`);
        }
    }

    return {
        statusCode: 200,
        body: 'Server health check complete.',
    };
};
