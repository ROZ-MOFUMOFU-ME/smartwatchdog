# Server Health Check Application

このアプリケーションは、Google Sheetsからサーバーリストを取得し、各サーバーの死活監視を行います。AWS Lambda上で動作します。

## 必要条件

- Node.js 20.x
- AWSアカウント
- Google Cloud Platformアカウント
- Google Sheets API有効化
- `secret.json`ファイル（Google Cloudのサービスアカウントキー）

## インストール

1. リポジトリをクローンします。

    ```sh
    git clone https://github.com/emerauda/sheetswatchdog.git
    cd sheetswatchdog
    ```

2. 必要なパッケージをインストールします。

    ```sh
    npm install
    ```

3. Google Cloud Platformでサービスアカウントを作成し、`secret.json`ファイルをプロジェクトのルートディレクトリに配置します。

4. `index.js`ファイル内のスプレッドシートIDと範囲を適宜変更します。

    ```javascript
    const spreadsheetId = 'your_spreadsheet_id';
    const range = 'Sheet1!A2:B';
    ```

## 使用方法

1. アプリケーションを実行します。

    ```sh
    node index.js
    ```

2. Google Sheetsからサーバーリストを取得し、各サーバーの死活監視を行います。結果はコンソールに出力されます。

## AWS Lambdaデプロイ

1. プロジェクトディレクトリをZIPファイルに圧縮します。

    ```sh
    zip -r function.zip .
    ```

2. AWS Lambdaコンソールに移動し、新しい関数を作成します。

3. 「.zipファイルをアップロード」を選択し、先ほど作成したZIPファイルをアップロードします。

4. 必要な環境変数（例：スプレッドシートID、範囲など）を設定します。

5. 関数をテストし、Google Sheetsからデータを取得してサーバーの死活監視を行うことを確認します。

## ファイル構成

- `index.js`: メインのアプリケーションロジック
- `secret.json`: Google Cloudサービスアカウントキー（セキュリティのため、公開しないでください）

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は`LICENSE`ファイルを参照してください。

## 参考リンク

- [Building a REST API from Google Sheets with AWS Lambda and API Gateway](https://chrisboakes.com/building-a-rest-api-with-google-sheets-and-aws-lambda/)
- [Google Sheets API Documentation](https://developers.google.com/sheets/api)