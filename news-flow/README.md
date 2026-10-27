# News Flow for Even G2

Even G2へRSSニュースをネイティブの`TextContainer`で表示する通常フォント版です。
大きな画像文字を使う`news-large`とは独立しています。

## 構成

```text
自宅PCのニュースサーバー（8787）
  → RSS取得・優先キュー・2分ごとの記事切替
  → スマホのEven Hubアプリ（開発時5173）
  → Even G2のTextContainerへ見出しと本文を表示
```

優先対象は株式、スポーツ、経済、企業、IT、金融です。優先記事を流し終えると、
それ以外の未読記事を表示します。

## 起動

ターミナル1:

```sh
cd ~/even-g2-portfolio/news-flow
npm run news-server
```

ターミナル2:

```sh
cd ~/even-g2-portfolio/news-flow
npm run dev
```

ターミナル3:

```sh
cd ~/even-g2-portfolio/news-flow
npm run sim
```

実機Local Testing用QR:

```sh
npm run qr -- --url 'http://192.168.1.100:5173'
```

## 操作

- クリック: 次の記事
- 下スクロール: 本文の次ページ
- 上スクロール: 本文の前ページ
- ダブルクリック: アプリ終了

## Betaパッケージ

```sh
npm run pack
```

生成物は`news-flow.ehpk`です。接続先を変える場合は`.env`の
`VITE_NEWS_API_URL`と`app.json`の`network.whitelist`を両方変更します。

## 公開用コピーの初期設定

`.env.example`はAPIキー不要の`NEWS_PROVIDER=mock`、待受は`127.0.0.1`です。
実ニュースを使う場合は`NEWS_PROVIDER=rss`を指定してください。
実機からPCへ直接接続する場合は、`NEWS_HOST=0.0.0.0`とスマホから到達できるAPI URLを明示的に設定し、`app.json`の許可先も変更してください。
本番利用ではTailscale内の通信を想定しています。
