# GP-10 Web Editor

BOSS GP-10 用の非公式 Web MIDI エディタです。ブラウザから GP-10 と SysEx（RQ1 / DT1）で直接通信し、現在のパッチを読み込んで編集できます。インストール不要の HTML 1 ファイルで動きます。

> An unofficial, single-file Web MIDI editor for the BOSS GP-10 guitar processor. Open `index.html` in Chrome or Edge, press 「接続」 (Connect), and allow MIDI SysEx access.

BOSS / Roland とは無関係の個人制作ツールです。BOSS、GP-10、Roland は Roland Corporation の商標です。

## 使い方

1. GP-10 のドライバ（BOSS 公式）を入れて、USB で接続します。
2. `index.html` を Chrome か Edge で開きます（ローカルファイルのままでも、HTTPS で配信しても動きます。Safari と Firefox は Web MIDI の SysEx に対応していないため使えません）。
3. 右上の「接続」を押し、MIDI デバイスの使用（SysEx）を許可します。
4. 現在のパッチが読み込まれます。動かした値はすぐに本体へ送られます。
5. 保存は本体の WRITE ボタンで行ってください（エディタが書き換えるのは現在のパッチ＝テンポラリだけです）。

MIDI ポートは「GP-10」を選びます（「GP-10 DAW CTRL」ではありません）。名前に GP-10 を含むポートは自動で選ばれます。

## できること

- 現在のパッチ（37 ブロック・609 項目）の一括読み込みと、全項目の編集（変更は DT1 で即時送信）
- エフェクトチェーンの表示（ON/OFF の表示、クリックで開く、ダブルクリックで ON/OFF）
- FX Select や Modeling Type、SYNTH Type などに応じた表示の切り替え
- 本体の表示と同じ単位・選択肢名での表示（-10〜+10、ms、dB、アンプ名など）
- パッチ名の編集、99 パッチの一覧と切り替え、本体側のパッチ切り替えへの追従
- 「本体の変更を反映」で、本体のつまみでの変更を定期的に読み直して反映
- パッチの `.syx` 書き出し・読み込み（読み込んだデータは現在のパッチに送られます）

### まだできないこと

- ユーザーパッチへの直接書き込み（本体の WRITE を使ってください）
- ASSIGN の TARGET（0〜4095）の名前表示（公式資料に対応表がないため番号のまま）

## 構成

| パス | 内容 |
|---|---|
| `index.html` | エディタ本体（`tools/` から生成。データ埋め込み済みの 1 ファイル） |
| `bench/index.html` | GP-10 SysEx Bench。Identity / RQ1 / アドレススキャン / ダンプ差分 / ラベル付けの調査用ツール |
| `data/gp10-address-map.json` | GP-10 のアドレスマップ（Setup・System・パッチ全 37 ブロック、名前・範囲・表示変換・選択肢） |
| `tools/editor.template.html` | エディタのテンプレート |
| `tools/gen_data.py` | アドレスマップを圧縮してテンプレートに埋め込み、`index.html` を生成 |
| `tools/parse_mi.py` | 公式 MIDI Implementation（PDF をテキスト化したもの）からアドレスマップを生成 |
| `tests/` | 擬似 GP-10 を使った Playwright のテスト。`fixtures/` は実機のテンポラリパッチのダンプ |

## GP-10 の SysEx について（要点）

- Roland 形式。Device ID `10`、Model ID `00 00 00 05`、Identity Reply の Family は `05 03`
- 番地: `00 00 00 00` Setup、`10 00 00 00` System、`20 00 00 00` 現在のパッチ（テンポラリ）
- ユーザーパッチ p（1〜99）は `20 00 00 00` から 2 バイト目を 4p 進めた位置（7 ビット繰り上がり）。User 1 = `20 04 00 00`、User 99 = `23 0C 00 00`
- RQ1 はブロック単位で DT1 を返す。`20 00 00 00` にサイズ `00 04 00 00` を指定すると、パッチ全体（37 ブロック・693 バイト）が返る
- 2 バイト以上の項目（Delay Time など）は 1 バイト 4 ビットずつ上位から格納
- 本体でパッチを切り替えると `B0 00 00` / `B0 20 00` / `C0 (p-1)` が送られてくる
- 本体側でつまみを動かしても DT1 は自動送信されない（そのため定期読み直しで反映）

アドレスマップは BOSS 公式の「GP-10 MIDI Implementation Ver.1.01」から機械抽出し、全 37 ブロックの長さと全 693 バイトの値の範囲を実機ダンプで照合しています。

## 開発

```sh
npm install            # Playwright（テスト用）
npm run build          # data/ と tools/editor.template.html から index.html を生成
npm test               # 擬似 GP-10 でエディタと Bench をテスト
```

アドレスマップを作り直す場合は、BOSS の公式サイトから GP-10 の MIDI Implementation（PDF）を各自で入手し、テキスト化してから実行します（PDF はリポジトリに含めていません）。

```sh
pdftotext -layout GP-10_MIDI_Imple_e02_W.pdf mi.txt
python3 tools/parse_mi.py mi.txt tests/fixtures/temp-patch-dump.txt data/gp10-address-map.json
npm run build
```

## ライセンス

未定。
