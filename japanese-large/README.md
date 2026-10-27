# Japanese Large for Even G2

Even Hubのネイティブな`TextContainer`では変更できないフォントサイズを、
日本語をCanvas上で大きなPNG画像に変換して表示することで実現する実験アプリです。
`english-flow`とは独立したプロジェクトです。

## 仕組み

```text
src/messages.ts の日本語
  → ブラウザCanvasで最大52px・自動折返し
  → 288x144 PNGを生成
  → Even Hub SDKが4-bitグレースケールへ変換
  → Bluetooth経由でEven G2へ表示
```

この試作版は文章をアプリ内に持つため、学習サーバーやTailscale Serveは不要です。

## 操作

- クリック、下スクロール: 次の文章
- 上スクロール: 前の文章
- ダブルクリック: アプリ終了

表示内容は`src/messages.ts`で編集します。長文も自動で折り返しますが、
大きな表示を保つには1枚10文字前後がおすすめです。

## Local Testing

Node.js 20.19以上、または22.12以上を使います。

```sh
cd ~/even-g2-portfolio/japanese-large
npm install
npm run dev
```

別のターミナルでシミュレーターを起動します。

```sh
cd ~/even-g2-portfolio/japanese-large
npm run sim
```

実機のLocal Testing用QRコード:

```sh
npm run qr -- --url 'http://192.168.1.100:5175'
```

## Betaパッケージ

```sh
npm run pack
```

生成物は`japanese-large-beta.ehpk`です。このBeta版は表示内容を内蔵するため、
起動後にPCへ接続する必要はありません。文章を変更した場合は再度packします。

## 主なファイル

- `src/main.ts`: G2画面、画像転送、クリック操作
- `src/renderJapanese.ts`: 日本語の折返し、文字サイズ調整、PNG生成
- `src/messages.ts`: 表示する日本語
- `app.json`: Even Hubアプリ設定
