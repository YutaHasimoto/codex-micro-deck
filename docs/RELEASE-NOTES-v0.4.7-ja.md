# Codex Micro Deck v0.4.7 リリースノート

## Standard速度の読み戻し検証を修正

実機では、Model、Reasoning、Accessを含む設定patch自体はすべてCodexへ正しく保存されていました。しかしStandard速度を送るときの`serviceTier: null`を、Codex App Serverの`thread/resume`が`"default"`へ正規化して返すため、プラグインが読み戻しを不一致と誤判定し、`Codex task settings verification failed`を表示していました。

v0.4.7はStandard速度についてだけ`null`と`"default"`を同じ値として検証します。Fastなど明示したサービス速度は従来どおり厳密に照合するため、別の速度への取り違えを成功扱いしません。

## 継承する操作と同期

v0.4.6のAgentキーのタスク名1行表示、長名の選択中マーキー、番号、状態アイコン、色、選択枠を維持します。Model、Reasoning、Speed、Accessの80ミリ秒自動適用も変わりません。

follow中タスクにはDesktop IPCで同じpatchの即時反映を先に開始します。最大6タスクの永続化と読み戻しは1つのCodex App Server内でタスク間を並列に処理し、各タスクでは`thread/resume`、`thread/settings/update`、読み戻し検証の順を守ります。Desktop IPCの失敗は永続化成功を妨げず、batch完了前にその結果を待つため古いpatchが後から新しいダイヤル操作を上書きしません。

回転後すぐ物理押下した場合は、まだ開始していない80ミリ秒の自動適用を中止して、同じ設定を二重に適用しません。

## 配布物

プラグインのバージョンは`0.4.7.0`です。v0.4.5とv0.4.6の配布アーカイブは残し、v0.4.7は`dist-v0.4.7-final`へ出力します。
