# SmartWatchdog 🐕

[![Lint/Format](https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog/actions/workflows/lint-format.yml/badge.svg)](https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog/actions/workflows/lint-format.yml)
[![Deploy](https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog/actions/workflows/deploy.yml/badge.svg)](https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog/actions/workflows/deploy.yml)
[![Coverage Status](https://img.shields.io/badge/coverage-auto--generated-brightgreen)](./coverage/lcov-report/index.html)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Googleスプレッドシート**と**Cloudflare Workers**を使用したサーバーレスなサーバー死活監視ツール

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

SmartWatchdogは、Googleスプレッドシートを管理画面として使用し、Cloudflare Workersでサーバーの死活監視を行うサーバーレスな監視ツールです。通知はDiscord Webhookで行います。

### 特徴
- **🔄 自動監視**: 設定した間隔でサーバーの状態を自動チェック
- **📊 スプレッドシート管理**: 直感的なGoogleスプレッドシートでの監視対象管理
- **🔔 Discord通知**: 状態変化をリアルタイムでDiscordに通知
- **🎨 視覚的フィードバック**: スプレッドシートの色分けで状態を一目で確認
- **💾 状態保持**: KVでの状態履歴管理
- **🚀 サーバーレス**: Cloudflare Workersによる自動スケーリング

## ✨ 主な機能

### 1. サーバー監視
- HTTP/HTTPSエンドポイントの死活監視
- TCPポート監視（Cloudflare Sockets API対応）
- カスタマイズ可能なタイムアウト設定（デフォルト: 5秒）
- 詳細なエラー情報の取得

### 2. スプレッドシート連携
- 複数シート対応
- 自動的な状態更新と色分け
- 削除されたサーバーの自動クリーンアップ

### 3. Discord通知
- エラー発生時の即座通知
- 復旧時の通知
- @everyone/@roleメンションや埋め込み通知
- スプレッドシートへの直接リンク

### 4. 状態管理
- KVでの状態履歴保存
- 変更検知による効率的な更新
- 複数シートの独立した状態管理

## 🏗️ アーキテクチャ

```
┌─────────────────┐    ┌────────────────────────┐    ┌─────────────────┐
│   Google Sheets │    │ Cloudflare Workers     │    │     Discord     │
│                 │    │                        │    │                 │
│ 監視対象管理     │◄──►│ サーバー監視            │───►│ 通知送信         │
│ 状態表示         │    │ 状態更新・KV保存        │    │                 │
└─────────────────┘    └────────────────────────┘    └─────────────────┘
```

## 🛠️ 技術スタック

- **TypeScript**
- **Cloudflare Workers**
- **Google Sheets API**
- **Discord Webhook API**
- **Cloudflare KV**
- **Jest / ESLint / Prettier / GitHub Actions**

## 🚀 セットアップ

### 前提条件
- Node.js 22.x 以上
- npm 9.x 以上
- Google Cloud Platform アカウント
- Discordサーバー管理権限
- Cloudflareアカウント

### 1. リポジトリのクローン
```bash
git clone https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog.git
cd smartwatchdog
npm install
```

### 2. Google Cloud Platform の設定
（Google Sheets APIの有効化・サービスアカウント作成・シート共有は従来通り）

### 3. Discord Webhook の設定
1. Discordサーバーのチャンネル設定→「連携サービス」→「ウェブフック」→「新しいウェブフック」作成
2. Webhook URLをコピー

### 4. Cloudflare Workers/KVの設定
1. [Cloudflare Workers](https://developers.cloudflare.com/workers/)で新規プロジェクト作成
2. KV Namespaceを作成し、`wrangler.toml`にバインド
3. wrangler.toml例:
```toml
name = "smartwatchdog-worker"
main = "src/index.ts"
compatibility_date = "2024-06-20"
kv_namespaces = [
  { binding = "STATUS_KV", id = "xxxxxx" }
]
[vars]
GOOGLE_CLIENT_EMAIL = "xxx"
GOOGLE_PRIVATE_KEY = "xxx"
SPREADSHEET_ID = "xxx"
DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/xxx/yyy"
# Optional: ID for role to mention on error
# DISCORD_MENTION_ROLE_ID = "123456789012345678"
```

### 5. デプロイ
```bash
npx wrangler publish
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
  - `OK: Status 200` - 正常
  - `ERROR: Status 404` - エラー
  - `ERROR: Server not reachable` - 到達不能
- **D列**: 最終更新日時（自動更新）

### 2. 監視の開始
- Cloudflare Workersのスケジューラや外部トリガーで定期実行
- Discordに通知が届くことを確認

### 3. 通知の例
- **エラー発生時**: 赤色embed＋:rotating_light:＋@mention
- **復旧時**: 緑色embed＋:white_check_mark:
- **内容**: サーバー名、URL、ステータス、更新日時、スプレッドシートリンク

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
    └── status.ts         # ステータス処理
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
- **統合テスト**: Discord通知、KV操作のテスト
- **モック**: 外部API（Google Sheets/Discord/KV）のモック化

### テストファイル構成
```
src/
├── index.test.ts         # メイン機能のテスト
└── utils/
    ├── date.test.ts      # 日時処理のテスト
    └── status.test.ts    # ステータス処理のテスト
```

## 🔄 CI/CD
- GitHub ActionsでLint/Format/Test自動化
- wrangler publishで自動デプロイも可能

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
  - Cloudflare Workersへの自動デプロイ

### バッジ
- **Lint/Format**: コード品質の状態
- **Deploy**: デプロイの成功/失敗
- **Coverage**: テストカバレッジ

## 🔧 トラブルシューティング
- Google Sheets API認証エラー→サービスアカウント/シート共有/秘密鍵改行に注意
- Discord通知が来ない→Webhook URL/権限/レート制限を確認
- KV Namespace未設定→wrangler.tomlとCloudflareダッシュボードで確認

### よくある問題

#### 1. Google Sheets API エラー
```
Error: Invalid range: Sheet name is not specified
```
**解決方法**: シート名や範囲指定が正しいか確認（例: `シート1!A2:D`）

#### 2. Discord通知が送信されない
**確認項目**:
- Webhook URLが正しいか
- Discordチャンネルの権限が正しいか
- レートリミットに達していないか

#### 3. KV Namespace未設定
```
Error: KV namespace not bound
```
**解決方法**: `wrangler.toml`とCloudflareダッシュボードでKVバインドを確認

### ログの確認
```bash
# Cloudflare Workersのログ確認
npx wrangler tail
```

## 🤝 貢献
- フォーク＆PR歓迎
- TypeScript/ESLint/Prettier/Jestルール遵守

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
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) - サーバーレス実行環境
- [Discord Webhook API](https://discord.com/developers/docs/resources/webhook) - 通知機能
- [TypeScript](https://www.typescriptlang.org/) - 型安全な開発

## 📞 サポート

- **Issues**: [GitHub Issues](https://github.com/ROZ-MOFUMOFU-ME/smartwatchdog/issues)
- **Documentation**: [詳細手順書](https://digital-region.docbase.io/posts/3529871)
- **Email**: プロジェクトメンテナーまで
