# 🏛️ 民主主義Bot

Discord鯖を「国」のように民主主義で運営するためのBotシステムです。

## 概要

管理者派閥と国民代表派閥の二大勢力が、サーバーの運営方針を議論・決定していきます。

### 派閥構成

| 派閥 | 役職 | 説明 |
|------|------|------|
| 管理者派閥 | サーバーオーナー・管理者 | 既存のDiscord権限による運営 |
| 国民代表派閥 | 国民代表（議員） | 選挙で選出。議決権＋一部Discord権限 |
| 国民代表派閥 | 大臣 | 議員が任命。イベント担当、治安担当など |
| 国民代表派閥 | 補佐官 | 議員が任命。サポート役 |
| 国民代表派閥 | 裁判官 | 紛争解決・ルール違反判定 |

## 機能

### Discord Bot コマンド

| コマンド | 説明 |
|----------|------|
| `/citizen register` | 市民として登録 |
| `/citizen info [@user]` | 市民情報を表示 |
| `/election start` | 選挙を開始（管理者のみ） |
| `/election register` | 立候補する |
| `/election status` | 選挙状況を表示 |
| `/election advance` | 選挙フェーズを進める（管理者のみ） |
| `/election finalize` | 選挙を確定する（管理者のみ） |
| `/propose submit` | 政策を提案する（議員のみ） |
| `/propose list` | 提案一覧を表示 |
| `/propose vote` | 提案に投票する（議員のみ） |
| `/propose start_vote` | 提案の投票を開始（議員のみ） |
| `/propose close` | 提案の投票を締切（議員のみ） |
| `/appoint minister` | 大臣を任命（議員のみ） |
| `/appoint aide` | 補佐官を任命（議員のみ） |
| `/appoint judge` | 裁判官を任命 |
| `/appoint dismiss` | 役職を解任 |
| `/trial file` | 裁判を提訴 |
| `/trial judge` | 裁判の担当に志願（裁判官のみ） |
| `/trial verdict` | 判決を下す（担当裁判官のみ） |
| `/trial list` | 進行中の裁判一覧 |
| `/government show` | 政府構成を表示 |
| `/government setup` | Bot設定（管理者のみ） |

### Web機能

- Discord OAuth2 ログイン
- 選挙投票画面
- 政府構成ダッシュボード
- 政策提案一覧
- 裁判記録

## セットアップ

### 1. Discord Bot の作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. Bot を追加し、トークンを取得
3. OAuth2 > Redirects に `http://localhost:3000/auth/callback` を追加
4. Bot の Privileged Gateway Intents で `Server Members Intent` を有効化

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集:

```
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
WEB_PORT=3000
WEB_BASE_URL=http://localhost:3000
SESSION_SECRET=random_secret_string
DATABASE_URL=file:./dev.db
```

### 3. インストール・起動

```bash
npm install
npx prisma generate
npx prisma db push

# スラッシュコマンドを登録
npm run deploy-commands

# Bot + Web サーバーを起動
npm run dev
```

## 技術構成

- **Bot**: discord.js + TypeScript
- **Web**: Express
- **DB**: SQLite (Prisma ORM)
- **認証**: Discord OAuth2
