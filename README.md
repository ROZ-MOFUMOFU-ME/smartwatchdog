# Googleスプレッドシートでサーバーヘルスチェックとステータス通知 "SheetsWatchdog"

このアプリケーションは、Googleスプレッドシートにリストされたサーバーのヘルスステータスをチェックし、ステータスの更新（復旧またはエラー）をSlack通知で送信するAWS Lambda関数です。サーバーのステータスはGoogleスプレッドシートから取得し、結果はAWS S3バケットに保存されます。また、Googleスプレッドシートに最新のサーバーステータスを更新します。

## 主な機能

- **Googleスプレッドシート連携**: Googleスプレッドシートからサーバーデータを読み込み、サーバーステータスをシートに更新します。
- **Slack通知**: SlackのWebhook URLを使用して、サーバーステータスの復旧またはエラーをSlackチャンネルに通知します。
- **AWS S3連携**: サーバーステータスのデータをS3バケットに保存および取得します。
- **サーバーヘルス監視**: HTTPリクエストをサーバーのURLに送信し、サーバーのヘルスチェックを定期的に実施します。

## 必要条件

このプロジェクトを使用する前に、以下の環境が必要です:

- AWSアカウント（LambdaとS3が設定されていること）
- Google Sheets APIにアクセスするためのGoogle Cloudサービスアカウント
- SlackのWebhook URL
- 次のような構造を持つGoogleスプレッドシート（例）:

| サーバー名   | サーバーURL              | ステータス | 最終更新日時     |
|--------------|--------------------------|------------|-----------------|
| MyServer1    | https://example.com       | OK         | 2024-09-11      |
| MyServer2    | https://example2.com      | ERROR      | 2024-09-11      |

## 環境変数

AWS Lambda関数で以下の環境変数を設定してください:

- `GOOGLE_CLIENT_EMAIL`: Googleサービスアカウントのメールアドレス
- `GOOGLE_PRIVATE_KEY`: Googleサービスアカウントのプライベートキー
- `SPREADSHEET_ID`: GoogleスプレッドシートのID
- `RANGE`: チェックするシートの範囲（例: `シート1!A2:D`）
- `S3_BUCKET_NAME`: ステータスを保存するS3バケット名
- `SLACK_WEBHOOK_URL`: SlackのWebhook URL

## 使い方

1. Google Cloud ConsoleでGoogle Sheets APIを有効にし、サービスアカウントを作成してJSONキーを取得します。
2. 上記の環境変数をAWS Lambda関数に設定します。
3. Googleスプレッドシートにサーバー情報を記載します。
4. AWS Lambda関数をトリガーとして実行すると、サーバーステータスがチェックされ、GoogleスプレッドシートとSlackに通知されます。

## Slack通知例

Slack通知は以下のように表示されます:

```
:white_check_mark: サーバーが復旧しました :white_check_mark:

*Server Name:*
MyServer1

*Server URL:*
https://example.com

*Status:*
OK

*Last Updated:*
2024-09-11 10:00:00 UTC+0900 (JST)

[Googleスプレッドシートで確認する](https://docs.google.com/spreadsheets/d/your_spreadsheet_id/edit#gid=sheet_id)
```

## ライセンス

このプロジェクトはMITライセンスの下で提供されています
