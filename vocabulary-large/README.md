# Vocabulary Large for Even G2

英単語・日本語の意味・短い例文を、大きな画像文字で表示する単語帳です。
バージョン0.2.0から、`english-flow`と同じPC配信方式を標準にしています。
TOEIC 700〜800点帯を想定した200語を収録しています。

## 構成

```text
data/cards.json（単語200語）
  ↓ PCが10秒ごとにカードを切替・現在位置を保存
Vocabulary server（127.0.0.1:8790）
  ↓ Tailscale Serve（HTTPS :8444、tailnet限定）
スマホのBeta版Vocabulary Largeが定期取得
  ↓ Canvas画像4枚をBluetoothで転送
Even G2（単語・意味・例文を大きく表示）
```

English Flowは`:8443 → :8788`、本アプリは`:8444 → :8790`です。
配信サーバーとTailscaleが必要です。iPhone上での画像生成・画像転送は継続するため、
この変更だけでスリープ中のクラッシュが解消したとは断定できません。
実機での継続動作は別途確認します。

## 操作

- PCが10秒ごとに次のカードへ切替
- クリック・下スクロール: PCへ次のカードを要求
- 上スクロール: PCへ前のカードを要求
- ダブルクリック: システムの終了確認を表示
- 最後の次は先頭、先頭の前は最後へ戻る

手動操作後はPCの10秒タイマーを数え直します。
スマホは次の更新予定に合わせ、最大15秒間隔で現在値を取得します。
更新番号が同じなら画像転送を省略し、復帰時にはPCの現在位置を再取得します。
PCはスマホを閉じている間もカードを進めます。再接続時は現在のカードへ移ります。

## PC側の起動

Node.js 20.19以上、または22.12以上を使用します。

```sh
cd /absolute/path/to/even-g2-portfolio/vocabulary-large
npm install
cp .env.example .env
```

`.env`の`VITE_VOCABULARY_API_URL`を実際のTailscale URLへ変更します。
`app.json`の`network.whitelist`も同じHTTPSホスト・ポートに合わせてください。
この公開用コピーの接続先は例です。実機用に設定してください。

```sh
npm run vocabulary-server
```

常駐運転は付属のuser serviceを登録します。

```sh
systemctl --user link "$PWD/deploy/vocabulary-large.service"
systemctl --user daemon-reload
systemctl --user enable --now vocabulary-large.service
systemctl --user status vocabulary-large.service
tailscale serve --bg --https=8444 http://127.0.0.1:8790
tailscale serve status
```

スマホのTailscaleを同じtailnetへ接続します。
この構成はtailnet内に限定します。`tailscale funnel`で公開しないでください。
user serviceの配置先を自身の環境に合わせ、`ExecStart`のNode.jsパスを`command -v node`で確認した絶対パスへ変更してください。

## 開発者モードで試す（Local Testing）

PCの配信サーバーを起動した状態で、開発サーバーとQRコードを用意します。

```sh
cd /absolute/path/to/even-g2-portfolio/vocabulary-large
npm run dev -- --strictPort
```

別のターミナルで:

```sh
npm run qr -- --url http://192.168.1.100:5177
```

iPhoneのTailscaleを接続し、G2を接続したEvenアプリの開発者ハブにある
Local TestingからQRを読み込みます。スマホ画面の`Version 0.2.0 / PC配信`を確認します。
開発サーバーと配信サーバーの両方を起動したまま使います。
Local Testingでは単語APIも`http://192.168.1.100:5177/vocabulary-api/`経由で取得します。
ViteがPC内の配信サーバーへ転送するため、開発時の別HTTPS接続は不要です。
編集内容は開発サーバー経由で反映され、パッケージの作成・アップロードは不要です。

## Betaパッケージ

```sh
npm run pack
```

`vocabulary-large-beta.ehpk`（0.2.0）を既存プロジェクトへアップロードし、
自分を含むBetaグループへ配布します。iPhoneのEvenアプリのBeta欄から更新してください。
スマホ画面の`Version 0.2.0 / PC配信`で確認できます。
パッケージには接続先URLを含みますが、Tailscaleの認証情報は含みません。

## 教材・更新間隔

`data/cards.json`の`word`・`meaning`・`example`を編集し、サーバーを再起動します。
教材の変更だけならBetaパッケージの再作成は不要です。

```json
{ "word": "achieve", "meaning": "達成する", "example": "You can achieve your goal." }
```

`.env`の`VOCABULARY_INTERVAL_MS=10000`で更新間隔を設定します（最小5000）。
変更後は`systemctl --user restart vocabulary-large.service`を実行します。
現在位置は`var/vocabulary-state.json`へ保存し、再起動時に復元します。
接続先URLを変更した場合は`app.json`も合わせてBeta版を再作成します。

## 検証・開発

```sh
npm test
npm run build
npm run sim
```

`npm test`はサーバーの自動更新・前後移動・競合・状態復元と、スマホ側の定期取得・
更新省略・復帰・通信復旧・終了を検証します。実機でのスリープ動作の代わりにはなりません。
シミュレーターでも配信サーバーを別途起動してください。

## 主なファイル

| ファイル | 役割 |
|---|---|
| `data/cards.json` | 教材の共通データ |
| `server/index.mjs` | PC側のカード切替・API・保存 |
| `deploy/vocabulary-large.service` | PC側の常駐設定 |
| `src/main.ts` | スマホ側の取得・操作・画像転送 |
| `src/renderCard.ts` | 大きな文字の描画と4枚への分割 |
| `app.json` | Beta版のメタデータ・接続許可 |

旧方式は比較用として`src/mainOffline.ts`（0.1.8画像版）、`src/mainText.ts`
（0.1.9文字版）に残しています。`.env.text.example`を`.env.text`へコピーして使う`npm run pack:text`は旧方式の
文字比較パッケージを作成します。通常利用では`npm run pack`を使ってください。
