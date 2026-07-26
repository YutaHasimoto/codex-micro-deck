# Codex Micro Deck v0.3.0 リリースノート

リリース日: 2026年7月21日

v0.3.0では、Stream Deck +の4つのダイヤルをCodex設定専用の操作へ変更しました。左からModel、Reasoning、Speed、Approval levelです。

## 新しい4ダイヤル

| 左から | 表示 | 設定 | 候補 | 既定値 |
|---|---|---|---|---|
| 1 | Model | `model` | ローカルのモデルキャッシュで`visibility=list`のモデルをpriority順に表示 | モデルキャッシュの既定モデル |
| 2 | Reasoning | `model_reasoning_effort` | 選択モデルが対応するLow、Medium、High、XHigh、Max、Ultra | 選択モデルの既定値 |
| 3 | Speed | `service_tier` | Standard、Fast、Flex | Standard |
| 4 | Approval | `approval_policy`と`approvals_reviewer` | Strict、Ask、Auto、Never | Ask |

モデル候補は固定リストではありません。Codexのローカルモデルキャッシュにある、一覧表示可能なモデルをpriority順に循環します。タッチ領域では長いモデル名を短縮して表示します。

Reasoningの候補もモデルキャッシュに従います。選択モデルが対応しない推論レベルは候補に出しません。

Modelを適用するとき、現在のReasoningを新しいモデルも利用できる場合はそのまま保持します。利用できない場合は、新しいモデルの既定Reasoningへ合わせます。

## 4ダイヤル共通の操作

| 操作 | 結果 |
|---|---|
| 回す | 候補を選ぶ。表示だけが変わり、まだ設定は保存しない |
| ダイヤルを押す | 選択した候補をCodex設定へ適用する |
| タッチ領域をタップ | ディスクに保存されている現在設定を再読込する |
| タッチ領域を長押し | その項目を既定値へ戻し、Codex設定へ適用する |

回転と保存を分けたため、候補を探している途中の値が誤って適用されません。未適用候補はアンバーで表示され、保存すると役割ごとの色へ戻ります。目的の値を表示してからダイヤルを押します。保存前にタップすると、未適用の選択を破棄して保存済みの値へ戻せます。

複数tickが1回の回転イベントにまとまって届いた場合も、tick数に合わせて候補を移動します。

## Approval levelの4段階

| 表示 | 意味 | `approval_policy` | `approvals_reviewer` |
|---|---|---|---|
| Strict | 常に確認 | `untrusted` | `user` |
| Ask | 必要時に確認。既定値 | `on-request` | `user` |
| Auto | 必要時に自動レビュー | `on-request` | `auto_review` |
| Never | 確認しない | `never` | `user` |

Approval levelは、以後のCodex操作で使う承認方針です。ダイヤルを回しただけでは変更されず、押して保存した時点から有効になります。

## 設定ファイルへの保存

適用した値は`~/.codex/config.toml`へ保存します。保存途中のファイルをCodexが読むことを避けるため、一時ファイルを経由して原子的に置き換えます。対象のルート設定だけを書き換え、関係のない設定、コメント、TOMLテーブルは保持します。

- Modelの長押し: モデルキャッシュの既定モデルと、そのモデルの既定Reasoningへ戻す
- Reasoningの長押し: 選択モデルの既定推論レベルへ戻す
- Speedの長押し: Standardへ戻し、`service_tier`キーを削除する
- Approval levelの長押し: Askへ戻す

設定は現在実行中の処理を途中から変更しません。ModelとReasoningは主に新しいタスク、Speedは次のターン、Approval levelは以後の操作に反映されます。

Property Inspectorの「Codexへのキー操作を有効にする」は、macOSのSystem Eventsを使うキー操作だけを停止します。OFFでも4つの設定ダイヤルによる選択、再読込、適用、既定値へのリセットを利用できます。

## アイコン表示

タッチ領域は大きなLucideアイコンと現在値を1行で表示します。

- Model: CPU
- Reasoning: 脳回路
- Speed: 速度計
- Approval level: 盾とチェック

8キーの既定配置は、6つのAgent、Approve、Declineのままです。Agent番号、色と形の状態表示、承認の二重押し防止など、v0.2.0の改善も引き続き利用できます。

## 更新後の確認

1. Stream Deckアプリで「Codex Micro Deck」プロファイルを選びます。
2. タッチ領域が左からModel、Reasoning、Speed、Approvalの順になっていることを確認します。
3. ダイヤルを回し、表示だけが候補へ変わることを確認します。
4. ダイヤルを押し、選択値が適用されることを確認します。
5. タッチ領域をタップし、保存済みの現在値が再表示されることを確認します。

全体の操作は[かんたん操作ガイド](../GUIDE-ja.md)、Codex Microとの対応関係は[機能対応表](CAPABILITY-MAP-ja.md)、権限と制約は[メインREADME](../README.md)を参照してください。
