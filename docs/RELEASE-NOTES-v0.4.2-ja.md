# Codex Micro Deck v0.4.2 リリースノート

リリース日: 2026年7月25日

v0.4.2では、Ask／Autoを含むダイヤル設定の同期を「送信できたか」ではなく「Codexから読み戻した値が一致したか」で判定するようにしました。

## AskとAutoを正しく区別

AskとAutoはどちらも`approval_policy=on-request`を使います。実際の違いは次のレビュアー設定です。

| 表示 | `approval_policy` | `approvals_reviewer` |
|---|---|---|
| Ask | `on-request` | `user` |
| Auto | `on-request` | `auto_review` |

以前は`thread/settings/update`が応答すれば同期成功としていたため、別の設定更新と競合してレビュアーが戻ってもDeck側だけ✓になる可能性がありました。v0.4.2では各タスクを更新した後に`thread/resume`で全設定を読み戻し、両方の承認項目を含む完全な一致を確認します。

## 不一致は再試行してから警告

読み戻した値が違う場合は、同じ完全設定を一度だけ再送して再検証します。それでも一致しないタスクは成功件数に含めません。

- 全件一致: Model、Reasoning、Speedは`✓ Synced`
- Approval levelの全件一致: `Ask ✓`または`Auto ✓`
- 一部または全件不一致: `⚠ X/N`
- 追跡タスクなし: `✓ Default`

補助表示の`N tasks verified · new default`は、N件すべてについて読み戻し検証まで完了したことを表します。

## Codex画面の即時更新

現在Codex Desktopが追跡しているタスクへの即時更新は、永続設定の読み戻しに成功した後で行います。永続状態を確定してから画面側を更新するため、Deck表示、次ターンの実動作、Codex画面の順序が安定します。現在実行中のターン自体は途中変更せず、新しい設定は次のターンから使用されます。

通常、Codexデスクトップ全体の再起動は不要です。プラグイン更新時だけStream Deckプラグインを一度再起動します。
