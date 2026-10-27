# GP-10 Web Editor

BOSS GP-10 用の非公式エディタです。ブラウザから GP-10 と直接通信して、現在のパッチを編集できます。インストール不要の HTML 1 ファイルで動きます。

> An unofficial browser editor for the BOSS GP-10. Open `index.html` in Chrome or Edge and press Connect.

BOSS / Roland とは無関係の個人制作ツールです。BOSS、GP-10、Roland は Roland Corporation の商標です。

## 使い方

1. GP-10 のドライバ（BOSS 公式）を入れて、USB でつなぎます。
2. `index.html` を Chrome か Edge で開きます（Safari と Firefox は非対応）。
3. 「Connect」を押し、MIDI デバイスの使用を許可します。
4. 現在のパッチが読み込まれます。動かした値はすぐに本体へ送られます。
5. 保存は本体の WRITE ボタンで行ってください。

### ドライバなしで使う（Android など）

「Connect over USB」を押すと、ドライバを通さずに Chrome が GP-10 と直接通信します（WebUSB）。

- Android: OTG アダプタで GP-10 をつなぎ、公開ページを Chrome で開きます（実機では未確認）
- Mac: ドライバを入れていないか、止めているときだけ使えます
- Windows: 使えません。ドライバを入れて「Connect」を使ってください
- 接続中は、BOSS TONE STUDIO などほかのアプリから GP-10 を使えません

iPhone / iPad では使えません。

## できること

- 信号経路の表示と、ブロックの ON/OFF・並べ替え
- 各ブロックのパラメータ編集とモデルの切り替え
- チューニングの編集（Alternate tuning / 12-string / String bend）
- 弦ごとの音量・パン（Modeling）
- GK setting 1〜3 の編集（本体全体の設定。バックアップと書き戻しつき）
- パッチ名の編集、99 パッチの一覧と切り替え
- `.syx` の保存・読み込み

### まだできないこと

- ユーザーパッチへの直接書き込み（本体の WRITE を使ってください）

## 開発

```sh
npm install      # Playwright（テスト用）
npm run build    # data/ と tools/ から index.html を生成
npm test         # 擬似 GP-10 でテスト
```

| パス | 内容 |
|---|---|
| `index.html` | エディタ本体（生成物） |
| `tools/` | エディタのテンプレート、USB-MIDI 送受信、生成スクリプト |
| `data/gp10-address-map.json` | GP-10 のアドレスマップ |
| `bench/` | SysEx と USB の調査用ページ |
| `tests/` | テスト |

アドレスマップは BOSS 公式の「GP-10 MIDI Implementation」から生成しています。作り直す場合は PDF を各自で入手してください（リポジトリには含めていません）。

```sh
pdftotext -layout GP-10_MIDI_Imple_e02_W.pdf mi.txt
python3 tools/parse_mi.py mi.txt tests/fixtures/temp-patch-dump.txt data/gp10-address-map.json
npm run build
```

## ライセンス

未定。
