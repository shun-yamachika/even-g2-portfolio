# News Large for Even G2

Even G2へ日本語ニュースを大きな画像文字で自動表示するプロジェクトです。通常フォント版の`news-flow`とは独立しており、既定の実ニュース配信には無料のRSSを使用します。

Node.js 22以上が必要です。

## 構成

```text
News server (RSSは10分ごとに取得、記事は2分ごとに切替)
  ├─ FNN・毎日新聞・朝日新聞のRSS
  ├─ 株式・スポーツ・経済・企業・IT・金融ニュースを先に配信
  ├─ 見出し・概要を100字以内へ整形
  ├─ var/news-state.json（重複防止と再起動復旧）
  └─ GET /api/news/current
                ↓ 次回更新時刻に合わせて確認
Even Hub app → Canvasで大きな日本語画像を生成 → Even G2 display
```

- G2でクリック: 次の記事を即時取得
- G2で上・下スワイプ: 本文のページを移動
- G2でダブルクリック: アプリを終了
- 画面上部に大きな見出し、下部に26px相当の本文をページ分割して表示します。
- G2の画像上限に合わせて画面を4枚の画像へ分割し、スクロール時は本文側の2枚だけを更新します。
- 未読の株式・スポーツ・経済・企業・IT・金融ニュースを先に流し終えてから、それ以外の未読ニュースを表示します。
- 本文を取得できない記事はRSS概要を代わりに表示します。

## デモ起動（APIキー不要）

ターミナル1:

```sh
npm run news-server
```

ターミナル2:

```sh
npm run dev
```

ターミナル3:

```sh
npm run sim
```

初期状態では3件のデモ記事を30秒ごとに切り替えます。

## 実機をホストPCへ接続

PCとスマートフォンを同じWi-Fiへ接続し、PCのLAN IPを確認します。以下では例として`192.168.1.100`を使用します。

ターミナル1:

```sh
NEWS_PROVIDER=mock npm run news-server
```

ターミナル2:

```sh
VITE_NEWS_API_URL='http://192.168.1.100:8789' npm run dev
```

Even Hub CLIで、スマートフォンが読み込むURLのQRコードを生成します。

```sh
npm run qr -- --url 'http://192.168.1.100:5176'
```

ファイアウォールではTCPの`5176`と`8789`をLAN内から接続可能にしてください。実機で`localhost`を指定するとスマートフォン自身を指すため、必ずPCのLAN IPへ置き換えます。

## 実ニュースで起動

初回だけ、プロジェクト専用の設定ファイルを作ります。

```sh
cp .env.example .env
chmod 600 .env
```

`.env`をエディタで開き、少なくとも次の項目を設定してください。Tailscale IPへ直接接続する場合の例です。

```dotenv
VITE_NEWS_API_URL=http://192.168.1.100:8789
NEWS_PROVIDER=rss
NEWS_INTERVAL_MS=120000
RSS_REFRESH_MS=600000
RSS_FILTER=all
ARTICLE_BODY_MAX_CHARS=2000
NEWS_HOST=0.0.0.0
```

保存後は通常どおり起動します。`npm run news-server`は`.env`を自動的に読み込みます。

```sh
npm run news-server
```

RSSモードではAPIキーを使用せず、`.env`に既存の`OPENAI_API_KEY`が残っていてもOpenAI APIは呼び出しません。

設定可能な環境変数:

- `NEWS_PROVIDER`: `rss`（推奨）、`mock`または`openai`
- `NEWS_INTERVAL_MS`: 表示記事の切替間隔。RSS利用時の設定例は2分
- `RSS_REFRESH_MS`: RSSの再取得間隔。最小1分、設定例は10分
- `RSS_FILTER`: `business`で経済・企業ニュースだけに絞る。`all`ですべて表示
- `RSS_FEED_URLS`: 任意のRSS URLをカンマ区切りで指定。省略時はFNN・毎日新聞・朝日新聞
- `ARTICLE_BODY_MAX_CHARS`: 記事ページから保持する本文の最大文字数。既定2000字
- `NEWS_PORT`: APIサーバーのポート。既定`8789`
- `NEWS_HOST`: 待受アドレス。直接接続は`0.0.0.0`、Tailscale Serve経由は`127.0.0.1`
- `OPENAI_MODEL`: `NEWS_PROVIDER=openai`の場合だけ使用
- `VITE_NEWS_API_URL`: G2アプリから見えるAPI URL。既定`http://localhost:8789`

実機では`localhost`ではなく、スマートフォンから到達できるHTTPSのサーバーURLをビルド時に指定してください。
接続先を変更するときは、`app.json`の`network.whitelist`も同じURLへ変更します。

```sh
VITE_NEWS_API_URL='https://news.example.jp' npm run build
```

## Tailscale経由で利用

### 最短の確認方法（Tailscale IPへ直接接続）

`your-pc`のTailscale IPが`192.168.1.100`の場合:

```sh
NEWS_HOST=0.0.0.0 npm run news-server
VITE_NEWS_API_URL='http://192.168.1.100:8789' npm run dev
```

iPhoneのSafariで`http://192.168.1.100:8789/health`を開き、`{"ok":true,...}`が表示されれば疎通しています。

### 常用構成（Tailscale ServeでHTTPS化）

ニュースサーバーはlocalhostだけで待ち受けます。

```sh
NEWS_HOST=127.0.0.1 npm run news-server
tailscale serve --bg 8789
tailscale serve status
```

`tailscale serve`が表示した`https://your-pc.<tailnet>.ts.net`をAPI URLに指定します。

```sh
VITE_NEWS_API_URL='https://your-pc.<tailnet>.ts.net' npm run dev
```

ServeはTailnet内だけに公開されます。一般インターネットへ公開する`tailscale funnel`は、この用途では使用しません。

## ビルド

```sh
npm run build
npm run pack
```

大きな日本語表示の主要コードは次の2ファイルです。

- `src/main.ts`: ニュースAPI、4つの画像コンテナ、クリックとスクロール
- `src/renderNews.ts`: 日本語の折返し、本文ページ分割、Canvas描画、画像分割

画像はBluetoothで順番に転送するため、ニュース切替時は数秒かかる場合があります。

## 公開用コピーの初期設定

`.env.example`はAPIキー不要の`NEWS_PROVIDER=mock`、待受は`127.0.0.1`です。
実ニュースを使う場合は`NEWS_PROVIDER=rss`を指定してください。
実機からPCへ直接接続する場合は、`NEWS_HOST=0.0.0.0`とスマホから到達できるAPI URLを明示的に設定し、`app.json`の許可先も変更してください。
本番利用ではTailscale内の通信を想定しています。
