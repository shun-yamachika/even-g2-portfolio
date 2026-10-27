# English Flow for Even G2

自宅PCが英文・和訳・解説のカードを一定間隔で切り替え、Tailscale経由でEven G2へ流す実装例です。Beta版は表示クライアントだけをスマホへインストールし、カードと表示順序は自宅PCが管理します。

## 構成

```text
Linuxドキュメント英語30件 + 旅行英語30件
      ↓ 各カード16秒、セットは1時間ごとに交代
自宅PCのStudy server（127.0.0.1:8788）
      ↓
Tailscale Serve（HTTPS :8443、tailnet限定）
      ↓
スマホのBeta版English Flow
      ↓ Bluetooth
Even G2
```

### 1枚が表示されるまで

```text
server/index.mjs のタイマー
  └─ data/*.json から次のカードを選ぶ
       └─ var/study-state.json に現在位置を保存
            └─ GET /api/cards/current で現在値を返す
                 └─ src/main.ts が定期取得して画面の文字を更新
                      └─ スマホからBluetooth経由でEven G2へ表示
```

グラスをクリックした場合は逆向きに、`src/main.ts`から
`POST /api/cards/advance`を送り、自宅PCが次のカードを選んで返します。
Tailscale専用のAPIをコードから呼んでいるわけではありません。スマホ側では
通常の`fetch(HTTPS URL)`を使い、その通信経路をTailscaleアプリが自宅PCへ
ルーティングしています。

## ファイル案内

| ファイル | 実行・利用場所 | 役割 |
|---|---|---|
| `data/cards.json` | 自宅PC | Linuxドキュメント英語30枚の教材データ |
| `data/travel-cards.json` | 自宅PC | 旅行英語30枚の教材データ |
| `server/index.mjs` | 自宅PC | 教材の読込、16秒更新、1時間交代、状態保存、HTTP API |
| `src/main.ts` | スマホのEven Hub内 | API取得、文字の描画、クリック・復帰イベント処理 |
| `index.html` | スマホのEven Hub内 | Viteが`src/main.ts`を読み込む最小の入口 |
| `.env` | ビルド時と自宅PC | 実際の接続先、カード更新間隔、待受ポート |
| `.env.example` | 開発者向け | `.env`のひな型。秘密情報ではなく設定例 |
| `app.json` | Betaパッケージ作成時 | アプリ名、SDK版、接続許可するHTTPSホスト |
| `package.json` | 開発用PC | `npm run ...`のコマンドと依存ライブラリ |
| `deploy/english-flow.service` | 自宅PCのsystemd | サーバーの常駐・障害時再起動 |
| `tsconfig.json` | ビルド時 | TypeScriptの型検査設定 |

次のものはソースではなく、自動生成または実行時データです。

| ファイル・ディレクトリ | 内容 |
|---|---|
| `dist/` | `npm run build`で作るスマホ側の配信ファイル |
| `english-flow-beta.ehpk` | `npm run pack`で作るBeta Testing用パッケージ |
| `var/study-state.json` | サーバーが保存する現在カード、更新番号、次回更新時刻 |
| `node_modules/` | `npm install`で取得したライブラリ |

## コードを読む順番

最初は次の順番がおすすめです。

1. `data/cards.json`の先頭2枚を見て、1カードのデータ構造をつかむ。
2. `server/index.mjs`の冒頭から`loadCardSets()`までを読み、設定と教材読込を見る。
3. 同ファイルの`publish()`、`advanceCard()`、`scheduleCardUpdate()`を読み、「次の1枚」が作られる流れを見る。
4. 同ファイル末尾の`createServer()`を読み、GETとPOSTの入口を見る。
5. `src/main.ts`の`StudyResponse`と`pageText()`を読み、受け取ったJSONが文字列になる箇所を見る。
6. 同ファイルの`fetchCurrent()`と`schedulePoll()`を読み、自動更新の流れを見る。
7. 同ファイルの`onEvenHubEvent()`を読み、クリックとダブルクリックの処理を見る。
8. 最後に`.env`、`app.json`、`package.json`を読み、通信先・権限・起動コマンドを対応づける。

全体を一度に理解するより、まず「教材JSON → サーバーの`publish()` →
クライアントの`fetchCurrent()` → `render()`」という1本の経路を追うと把握しやすくなります。

## 自宅PCで起動

```sh
cd /absolute/path/to/even-g2-portfolio/english-flow
npm run study-server
```

PCログイン後もバックグラウンドで継続運転する場合は、同梱のuser serviceの配置先とNode.jsの絶対パスを自身の環境に合わせて編集してから登録します。

```sh
systemctl --user link "$PWD/deploy/english-flow.service"
systemctl --user daemon-reload
systemctl --user enable --now english-flow.service
systemctl --user status english-flow.service
```

Tailscale Serveは初回だけ設定します。

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8788
tailscale serve status
```

スマホ側のTailscaleを接続しておく必要があります。Study serverを止めると、G2には接続エラーが表示されます。

## 操作

- 自動: 自宅PCが16秒ごとに次のカードへ切替
- セット: Linuxドキュメント英語と旅行英語を1時間ごとに交互表示
- クリック: 自宅PCへ次のカードを要求
- ダブルクリック: システムの終了確認を表示
- 最終カードの次は先頭へ戻る

## Local Testing

```sh
npm run dev
npm run sim
```

実機用QRコード:

```sh
npm run qr -- --url 'http://192.168.1.100:5174'
```

## Betaパッケージ

```sh
npm run pack
```

生成物は`english-flow-beta.ehpk`です。Betaグループは、自宅PCと同じtailnetへ参加している自分のスマホだけで使用してください。

`.ehpk`には接続先`https://your-pc.example.ts.net:8443`が含まれますが、Tailscaleの鍵・認証トークン・アカウント情報は含まれません。接続権限はスマホのTailscaleアプリとtailnetのACLが管理します。

Linuxカードは`data/cards.json`、旅行カードは`data/travel-cards.json`で編集します。Study serverを再起動すると反映され、`.ehpk`の作り直しは不要です。

カードの表示時間は`STUDY_INTERVAL_MS`、セットの交代時間は`STUDY_SET_INTERVAL_MS`で指定します。
