# Codex Micro Deck v0.4.3 リリースノート

リリース日: 2026年7月25日

右端のApproval levelダイヤルを、現行CodexのAccess 4択に更新しました。物理roleは`approval`のままなので、既存プロファイルとの互換性は保たれます。表示名はAccessです。

| Access | 新規タスク既定とタスク設定 |
|---|---|
| Ask | `on-request`、`user`、`:workspace` |
| Delegate | `on-request`、`guardian_subagent`、`:workspace` |
| Full | `never`、`user`、`:danger-full-access` |
| Custom | config.tomlから解決したapproval、reviewer、sandboxPolicy |

Ask、Delegate、Fullはconfig.tomlの既定値を更新し、追跡中タスクへも同期します。Customだけはconfig.tomlを変更せず、現在の設定を追跡中タスクへ送ります。選んだAccessはプラグインのグローバル設定に保存するため、Model、Reasoning、Speedの更新でCustomへ戻りません。

Reasoningはモデルキャッシュの対応値だけを候補にし、旧来の`Max`は候補にもIPC送信値にも含めません。キャッシュが古い、または一時的に読めない場合にも同じ制約を適用するため、存在しない`Max`による設定エラーを防ぎます。

## Fullは2回押し

Fullを選んで1回押すと、Deckは`Full · again`を4秒間表示します。この時点ではconfig.tomlもタスクも変更しません。4秒以内の2回目の押下でだけFullを適用します。回転、タップ、長押しは確認を解除します。長押しはAskへ戻します。

## 読み戻し検証を拡張

`thread/settings/update`後に`thread/resume`で読み戻し、Ask／Delegate／Fullでは`activePermissionProfile.id`、Customではsandboxと`activePermissionProfile=null`を確認します。DelegateはCodexの互換表現である`guardian_subagent`または`auto_review`のどちらが戻っても、代理承認として検証します。

現在実行中のターンは途中変更せず、設定は次のターンから有効になります。通常、Codexの再起動は不要です。Stream Deckアプリの再起動・プラグイン配備は、このリリースノートの作成だけでは行いません。
