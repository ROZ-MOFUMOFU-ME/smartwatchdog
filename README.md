# SheetsWatchdog 🐕

[![Lint/Format](https://github.com/digitalregion/sheetswatchdog/actions/workflows/lint-format.yml/badge.svg)](https://github.com/digitalregion/sheetswatchdog/actions/workflows/lint-format.yml)
[![Deploy](https://github.com/digitalregion/sheetswatchdog/actions/workflows/deploy.yml/badge.svg)](https://github.com/digitalregion/sheetswatchdog/actions/workflows/deploy.yml)
[![Coverage Status](https://img.shields.io/badge/coverage-auto--generated-brightgreen)](./coverage/lcov-report/index.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Googleスプレッドシート**と**AWS Lambda**を使用したサーバーレスなサーバー死活監視ツール

## 📋 目次

- [概要](#概要)
- [主な機能](#主な機能)
- [アーキテクチャ](#アーキテクチャ)
- [技術スタック](#技術スタック)
- [セットアップ](#セットアップ)
- [使用方法](#使用方法)
- [開発](#開発)
- [テスト](#テスト)
- [CI/CD](#cicd)
- [トラブルシューティング](#トラブルシューティング)
- [貢献](#貢献)
- [ライセンス](#ライセンス)

## 🎯 概要

SheetsWatchdogは、Googleスプレッドシートを管理画面として使用し、AWS Lambdaでサーバーの死活監視を行うサーバーレスな監視ツールです。

### 特徴
- **🔄 自動監視**: 設定した間隔でサーバーの状態を自動チェック
- **📊 スプレッドシート管理**: 直感的なGoogleスプレッドシートでの監視対象管理
- **🔔 Slack通知**: 状態変化をリアルタイムでSlackに通知
- **🎨 視覚的フィードバック**: スプレッドシートの色分けで状態を一目で確認
- **💾 状態保持**: S3での状態履歴管理
- **🚀 サーバーレス**: AWS Lambdaによる自動スケーリング

## ✨ 主な機能

### 1. サーバー監視
- HTTP/HTTPSエンドポイントの死活監視
- カスタマイズ可能なタイムアウト設定（デフォルト: 5秒）
- 詳細なエラー情報の取得

### 2. スプレッドシート連携
- 複数シート対応
- 自動的な状態更新と色分け
- 削除されたサーバーの自動クリーンアップ

### 3. Slack通知
- エラー発生時の即座通知
- 復旧時の通知
- @channelメンション機能
- スプレッドシートへの直接リンク

### 4. 状態管理
- S3での状態履歴保存
- 変更検知による効率的な更新
- 複数シートの独立した状態管理

## 🏗️ アーキテクチャ

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Google Sheets │    │   AWS Lambda    │    │      Slack      │
│                 │    │                 │    │                 │
│ 監視対象管理     │◄──►│ サーバー監視     │───►│ 通知送信        │
│ 状態表示        │    │ 状態更新        │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │   Amazon S3     │
                       │                 │
                       │ 状態履歴保存     │
                       └─────────────────┘
```

## 🛠️ 技術スタック

### バックエンド
- **TypeScript** - 型安全な開発
- **Node.js** - ランタイム環境
- **AWS Lambda** - サーバーレス実行環境
- **Amazon S3** - 状態データ保存

### 外部API
- **Google Sheets API** - スプレッドシート操作
- **Slack Webhook API** - 通知送信
- **Axios** - HTTP通信

### 開発ツール
- **Jest** - ユニットテスト
- **ESLint** - コード品質管理
- **Prettier** - コード整形
- **GitHub Actions** - CI/CD

## 🚀 セットアップ

### 前提条件
- Node.js 18.x 以上
- npm 9.x 以上
- AWS アカウント
- Google Cloud Platform アカウント
- Slack ワークスペース

### 1. リポジトリのクローン
```bash
git clone https://github.com/digitalregion/sheetswatchdog.git
cd sheetswatchdog
npm install
```

### 2. Google Cloud Platform の設定

#### 2.1 Google Sheets API の有効化
1. [Google Cloud Console](https://console.cloud.google.com/) にアクセス
2. プロジェクトを作成または選択
3. **APIとサービス** → **ライブラリ** で「Google Sheets API」を検索して有効化

#### 2.2 サービスアカウントの作成
1. **APIとサービス** → **認証情報** に移動
2. **認証情報を作成** → **サービスアカウント** を選択
3. サービスアカウント名を入力して作成
4. **キーを作成** → **JSON** を選択してダウンロード

#### 2.3 スプレッドシートの設定
1. Googleスプレッドシートを新規作成
2. サービスアカウントのメールアドレスに編集権限を付与
3. スプレッドシートIDをコピー（URLから取得）

### 3. Slack Webhook の設定
1. Slackワークスペースにログイン
2. 通知を受け取りたいチャンネルで **「アプリの追加」** をクリック
3. **「Incoming Webhooks」** を検索して追加
4. Webhook URLをコピー

### 4. AWS の設定

#### 4.1 S3バケットの作成
```bash
aws s3 mb s3://your-bucket-name
```

#### 4.2 Lambda関数の作成
1. AWS Lambdaコンソールにアクセス
2. **関数の作成** → **一から作成** を選択
3. 関数名: `SheetsWatchdog`
4. ランタイム: `Node.js 18.x`
5. **関数の作成** をクリック

#### 4.3 環境変数の設定
Lambda関数の設定画面で以下の環境変数を追加：

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `GOOGLE_CLIENT_EMAIL` | サービスアカウントのメールアドレス | `service@project.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | サービスアカウントの秘密鍵 | `-----BEGIN PRIVATE KEY-----\n...` |
| `SPREADSHEET_ID` | スプレッドシートID | `1A2B3C4D5E6F7G8H9I0J` |
| `RANGE` | データ範囲 | `A2:D` または `シート1!A2:D` |
| `SLACK_WEBHOOK_URL` | Slack Webhook URL | `https://hooks.slack.com/services/...` |
| `S3_BUCKET_NAME` | S3バケット名 | `your-bucket-name` |
| `AWS_REGION` | AWSリージョン | `ap-northeast-1` |

### 5. デプロイ
```bash
npm run build
# 生成されたdist/index.jsをLambdaにアップロード
```

## 📖 使用方法

### 1. スプレッドシートの設定

#### 基本レイアウト
| A列（サーバー名） | B列（サーバーURL） | C列（ステータス） | D列（最終更新） |
|------------------|-------------------|------------------|-----------------|
| ExampleServer1   | https://api1.com  | （自動更新）      | （自動更新）     |
| ExampleServer2   | https://api2.com  | （自動更新）      | （自動更新）     |

#### 列の説明
- **A列**: サーバー名（任意、空の場合はURLが使用される）
- **B列**: サーバーURL（必須、HTTP/HTTPS）
- **C列**: ステータス（自動更新）
  - `OK Status:200` - 正常
  - `ERROR! Status:404` - エラー
  - `ERROR! Server not reachable` - 到達不能
- **D列**: 最終更新日時（自動更新）

### 2. 監視の開始
1. スプレッドシートに監視対象サーバーを入力
2. AWS EventBridgeでスケジュールを設定
3. 自動監視が開始される

### 3. 通知の確認
- **エラー発生時**: 赤いアイコンと@channelメンション
- **復旧時**: 緑のアイコンで通知
- **通知内容**: サーバー名、URL、ステータス、更新日時、スプレッドシートリンク

## 🛠️ 開発

### 開発環境のセットアップ
```bash
# 依存関係のインストール
npm install

# TypeScriptのビルド
npm run build

# 開発サーバーの起動（ローカルテスト用）
npm run start:ts
```

### コード品質管理
```bash
# ESLintによる静的解析
npm run lint

# Prettierによる自動整形
npm run format

# 型チェック
npx tsc --noEmit
```

### プロジェクト構造
```
src/
├── index.ts              # メインエントリーポイント
├── types.ts              # TypeScript型定義
└── utils/                # ユーティリティ関数
    ├── date.ts           # 日時処理
    ├── s3.ts             # S3操作
    ├── status.ts         # ステータス処理
    └── stream.ts         # ストリーム処理
```

## 🧪 テスト

### テストの実行
```bash
# 全テストの実行
npm test

# カバレッジ付きテスト
npm test -- --coverage

# 特定のテストファイル
npm test -- src/utils/status.test.ts
```

### テストカバレッジ
- **ユニットテスト**: 各ユーティリティ関数のテスト
- **統合テスト**: Slack通知、S3操作のテスト
- **モック**: 外部APIのモック化

### テストファイル構成
```
src/
├── index.test.ts         # メイン機能のテスト
└── utils/
    ├── date.test.ts      # 日時処理のテスト
    ├── s3.test.ts        # S3操作のテスト
    ├── status.test.ts    # ステータス処理のテスト
    └── stream.test.ts    # ストリーム処理のテスト
```

## 🔄 CI/CD

### GitHub Actions ワークフロー

#### 1. Lint/Format/Test (`lint-format.yml`)
- **トリガー**: push/PR to main/dev
- **処理**:
  - ESLintによる静的解析
  - Prettierによるコード整形チェック
  - Jestによるユニットテスト

#### 2. Deploy (`deploy.yml`)
- **トリガー**: push to main/dev
- **処理**:
  - 複数Node.jsバージョンでのテスト
  - AWS Lambdaへの自動デプロイ
  - S3へのアーティファクト保存

### バッジ
- **Lint/Format**: コード品質の状態
- **Deploy**: デプロイの成功/失敗
- **Coverage**: テストカバレッジ

## 🔧 トラブルシューティング

### よくある問題

#### 1. Google Sheets API エラー
```
Error: Invalid range: Sheet name is not specified
```
**解決方法**: `RANGE`環境変数にシート名を含める（例: `シート1!A2:D`）

#### 2. Slack通知が送信されない
**確認項目**:
- Webhook URLが正しいか
- チャンネルにIncoming Webhooksが追加されているか
- ネットワーク接続が正常か

#### 3. S3アクセスエラー
```
AccessDenied: Access Denied
```
**解決方法**: Lambda実行ロールにS3アクセス権限を追加

#### 4. タイムアウトエラー
**対処法**:
- サーバーの応答時間を確認
- タイムアウト設定を調整（コード内で5秒に設定）

### ログの確認
```bash
# CloudWatchログの確認
aws logs tail /aws/lambda/SheetsWatchdog --follow
```

## 🤝 貢献

### 貢献の流れ
1. このリポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feature/amazing-feature`)
5. プルリクエストを作成

### 開発ガイドライン
- TypeScriptの型安全性を保つ
- テストカバレッジを維持する
- ESLint/Prettierのルールに従う
- コミットメッセージは日本語で記述

### 報告すべき問題
- バグ報告
- 機能要求
- ドキュメント改善
- パフォーマンス改善

## 📄 ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開されています。

## 🙏 謝辞

- [Google Sheets API](https://developers.google.com/sheets/api) - スプレッドシート操作
- [AWS Lambda](https://aws.amazon.com/lambda/) - サーバーレス実行環境
- [Slack API](https://api.slack.com/) - 通知機能
- [TypeScript](https://www.typescriptlang.org/) - 型安全な開発

## 📞 サポート

- **Issues**: [GitHub Issues](https://github.com/digitalregion/sheetswatchdog/issues)
- **Documentation**: [詳細手順書](https://digital-region.docbase.io/posts/3529871)
- **Email**: プロジェクトメンテナーまで

---

**Made with ❤️ by [Digital Region](https://github.com/digitalregion)**
