# Codex Micro機能対応表

この表は、Codex Microの公式機能をStream Deck +へどう置き換えたかを示します。「同等」は操作の意図を再現、「代替」はStream Deck +に合う別操作へ再配置、「部分」は公開APIの制約で一部のみ対応、という意味です。

## タスク管理と状態表示

| Codex Micro | Codex Shortcuts Plugin | 対応度 | 実装経路・差分 |
|---|---|---|---|---|
| 6つのAgent Key | 8キー中の6キー | 同等 | 直近6件を自動割り当て。各キーにタスク名を1行表示。キーごとのタスクID固定にも対応。自動割り当てOFFかつ空欄は未割り当て |
| 1回でバックグラウンド選択 | Agentキー1回 | 同等 | `codex://threads/<id>`をバックグラウンドで開く |
| 350ms以内の2回押しで前面表示 | Agentキー2回 | 同等 | 同じ350ms判定でCodexを前面表示 |
| 白・青・緑・アンバー・赤・消灯 | 同じ色と意味 | 部分 | 専用デバイスAPIではなく、ローカルDB・rollout・未読情報から推定。色に加えて円、チェック、感嘆符、三角形などの状態アイコンを表示 |
| 選択中キーのパルス | 外枠の明滅 | 部分 | 選択中Agentの外枠を明滅。公式ハードウェア固有の完全な光り方は対象外 |
| Most recent | 直近6件 | 同等 | ユーザー所有の通常タスクだけを対象にする |
| Pinned | タスクID固定 | 代替 | 6件をPinned順に自動選択するモードは未実装 |
| Priority | なし | 未対応 | 承認待ちや作業中を色で確認できるが、優先度順の並べ替えはしない |
| Custom assignments | タスクID固定 | 同等 | Property Inspectorでキーごとに指定 |

## コマンド操作

| Codex Micro既定操作 | Codex Shortcuts Plugin既定操作 | 対応度 | 実装経路 |
|---|---|---|---|
| Fast切替 | SpeedダイヤルでFastを選ぶ | 代替 | 全4ダイヤル共通で回転停止80ミリ秒後に自動適用し、追跡中のAgentタスクすべてでは次のターンから反映 |
| Approve | キー7 | 同等 | コマンド／ファイルの実承認待ちがある間だけ点灯し、要求IDを指定してIPCで承認。キーボード入力は送らない |
| Decline | 任意キーへDecline役割を設定 | 代替 | 実承認待ちがある間だけ点灯し、要求IDを指定してIPCで却下。キーボード入力は送らない |
| Continue in a new chat | 任意キーへFork役割を設定 | 代替 | CodexのFork相当コマンド |
| Push-to-talk | 右下Voiceキーと4設定ダイヤルの共通押下 | 代替 | 1回目でCodexの音声入力を開始し、2回目で文字起こしして送信。押している間だけ録音する旧PTT役割も選択可能 |
| Send message | 任意キーへ送信役割を設定 | 代替 | Codexを前面にしてReturnを送る |

キーとEncoderの役割はProperty Inspectorで変更できます。キーとダイヤル回転にはショートカットを直接指定できますが、既定4設定ダイヤルの物理押下は音声入力専用です。

## アイコン中心の表示と設定画面

| 項目 | 実装 |
|---|---|
| 8キー | 大きなLucideアイコンを中心に表示。Agentキーだけタスク名を1行追加 |
| Agentキー | ロボットアイコン、1〜6の番号、色と形の状態アイコン、1行のタスク名を表示。表示中6キーの長名はそれぞれ100ミリ秒間隔・10ピクセル刻みで滑らかにマーキーし、短名は静止。選択中の外枠明滅は維持。UnicodeとXML特殊文字を安全に処理 |
| Approve／Decline | 大きなチェック／バツのアイコンを表示。直接応答可能な実承認待ちが0件なら消灯。Declineは任意キーへ設定可能 |
| Voiceキー | 待機中は白いマイクと`Tap to talk`、録音中は青いマイクと`Listening…`を表示 |
| 4タッチ領域 | 通常時はModel、Reasoning、Speed、AccessをCPU、脳回路、速度計、盾とチェックのアイコンで表示。値は1行に限定。音声入力中は4画面を横断する同期波形へ切り替え |
| 設定画面 | 役割に応じた操作を日本語で表示。ダイヤル設定は新規タスクの既定値と、Deckで追跡中のAgentタスクすべてへ同期すると案内 |
| タスク固定 | 自動割り当てOFFかつタスクID空欄なら未割り当て。暗黙に最近のタスクへ戻さない |
| 画面・キー操作の許可 | 「Codexへの画面・キー操作を有効にする」で音声入力ボタン、ショートカット、コマンドパレットのSystem Events操作だけをON／OFF。設定ダイヤルの回転、再読込、適用、リセットはOFFでも利用可能 |

## v0.4.8のCodex設定ダイヤル

| 左から | 役割 | 設定先 | 候補と既定値 | 適用操作 |
|---|---|---|---|---|
| 1 | Model | `model` | ローカルのモデルキャッシュで`visibility=list`のモデルをpriority順に循環。キャッシュ既定モデルとその既定Reasoningへ戻せる | 回転停止80ミリ秒後に自動適用 |
| 2 | Reasoning | `model_reasoning_effort` | モデル対応のLow、Medium、High、XHigh、Ultra。Maxは旧値としても送信しない。モデル既定値へ戻せる | 回転停止80ミリ秒後に自動適用 |
| 3 | Speed | `service_tier` | Standard、Fast。既定はStandardで、設定キーを削除する | 回転停止80ミリ秒後に自動適用 |
| 4 | Access | `approval_policy`、`approvals_reviewer`、permission profile／sandbox | Ask、Delegate、Full、Custom。選択はグローバル設定に保存 | 回転停止80ミリ秒後に自動適用 |

4つとも回転、押下、タッチ、長押しを使います。回転だけで適用でき、待機時間は全ダイヤル共通で80ミリ秒です。

| ジェスチャー | 動作 |
|---|---|
| 回す | 候補を選ぶ。全4本とも停止80ミリ秒後に自動適用。再回転は前の待機を取り消す。音声入力中は設定もカスタム回転操作も実行しない |
| ダイヤルを押す | 1回目はCodexの音声入力を開始。2回目はCodex自身の「文字起こしして送信する」を実行。開始と終了は別の設定ダイヤルでもよい |
| タッチ | ディスク上の現在設定を再読込し、待機中の自動適用を中止 |
| タッチ長押し | 項目を既定値へ戻して原子的に適用し、待機中の自動適用を中止 |

音声入力開始前に、まだ開始していない4ダイヤルすべての自動適用を中止します。録音中は通常のアイコンと値を隠し、同じ800×100ピクセル波形を`0／200／400／600`ピクセルから切り出して4画面へ同期表示します。この波形はマイク入力のRMS音量に追従し、音量を取得できない場合は録音状態を示す補助アニメーションとして動作します。

Accessの4択は次の設定値へ対応します。

| 表示 | 意味 | `approval_policy` | `approvals_reviewer` | 権限 |
|---|---|---|---|
| Ask | workspace書込み・本人確認 | `on-request` | `user` | `permissions=:workspace` |
| Delegate | workspace書込み・代理承認 | `on-request` | `guardian_subagent` | `permissions=:workspace` |
| Full | フルアクセス・確認なし | `never` | `user` | `permissions=:danger-full-access` |
| Custom | 現在のconfig.tomlを使う | config解決値 | config解決値 | `sandboxPolicy` |

Ask、Delegate、Fullは新規タスク既定としてconfig.tomlも更新します。Customだけはconfig.tomlを書き換えず、今のconfig解決値をタスクへ送ります。Access selectionはグローバル設定に保存されるため、Model、Reasoning、Speedを後から変更してもCustomへ戻りません。旧Strict／Auto／Neverは読み込み互換だけを残し、通常候補には含めません。

Ask、Delegate、Fullは`~/.codex/config.toml`へ保存し、新しいタスクの既定値として使います。Customは設定ファイルを変更しません。その後、Agent 1〜6の各論理枠を解決し、重複を除いた最大6タスクへ同期します。変更した1項目だけでなく保存済みの4設定すべてを完全な組として送り、直後の`thread/resume`で全項目を読み戻します。Ask／Delegate／Fullは`activePermissionProfile.id`、Customは`sandbox`に加えて`activePermissionProfile=null`まで照合します。現在実行中のターン途中は変更せず、次のターンから有効です。

| Deck表示 | 結果 |
|---|---|
| 選択中の値を維持 | 全対象への同期成功。Model、Reasoning、Speed、Accessはいずれも通常表示へ戻る |
| `✓ Default` | 対象タスクがない。新規タスクの既定値だけ保存 |
| `⚠ X/N` | X件成功、N件中の一部または全部が失敗。4秒間アンバーで再試行を案内。全件失敗は`⚠ 0/N` |

一部成功を成功表示へまとめないため、Deck上だけ値が変わってCodex側の反映状態が分からない問題を避けられます。

## v0.2.0の安定性改善

| 修正対象 | 動作 |
|---|---|
| Agentの順序 | 既に割り当てられた有効なタスクは同じキーに保持し、空いたキーだけを最近のタスクで補充する |
| Agent枠の解除 | キーを別役割へ変更、またはキーが非表示になったとき、旧roleと旧座標から該当枠を解決し、以前の固定IDを同期対象から外す |
| 一時的な読取エラー | SQLiteまたはWALの一時エラーでは最後に正常取得した6件を保持し、全キーが一斉に消灯するのを防ぐ。状態DBそのものがない場合は安全のため未割り当てに戻す |
| Approve／Decline | live requestIdを持つコマンド／ファイル承認だけを対象にし、実行中ロックと応答済み要求の消費で重複送信を防ぐ |
| 対象タスク | 複数タスクに承認待ちがある場合、明示選択Agentを最優先し、未選択なら現在表示中の一意な対象を使う。決まらなければ推測しない |
| Push-to-talkキー | 入力元を所有者として管理し、重複した押下イベントや対応しない解放イベントでは音声状態を反転しない。開始と停止は直列処理する |
| トグル式Voiceキー | 同じ物理押下で重複したdownイベントを無視し、key upでは録音を止めない。次の物理押下を開始／送信の切り替えとして直列処理する |
| 4設定ダイヤルの音声入力 | 押下中に重複して届くdownイベントを無視し、開始／送信を直列化。録音中は全4本の回転とカスタム回転操作を二重に遮断 |
| ダイヤルの複数tick | 1イベントに複数tickが含まれる場合も、そのtick数だけ候補選択を進める |
| 障害ログ | 役割、イベント種別、短いエラー理由を記録する。タスクID、タスクURL、ユーザーパス、複数行出力は除去する |

## Codex Microのアナログ操作との違い

Codex Microの単一ダイヤルやスティック操作をそのまま複製するのではなく、Stream Deck +の4ダイヤル回転をCodexの設定変更へ、物理押下を共通の音声入力へ割り当てています。各ダイヤルの役割変更や左右回転のカスタムショートカットは、Stream DeckのProperty Inspectorで設定します。

## Stream Deck +固有の入力

| 入力 | 使用状況 |
|---|---|
| 8 LCDキー | 6 Agent + Approve + Voiceで全て使用。Declineは任意キーへ再割り当て可能 |
| 4ダイヤル回転 | 全4本とも80ミリ秒の停止後に自動適用。追跡Agent全件では次のターンへ反映 |
| 4ダイヤル押下 | どれでもCodex音声入力を開始。次の押下で文字起こし・送信 |
| 4タッチ領域 | 各設定の再読込で全て使用 |
| 4タッチ領域の長押し | 各設定を既定値へ戻して適用する操作で全て使用 |
| タッチストリップのスワイプ | Stream Deck本体がページ・プロファイル切替に使用。プラグインAPIでは取得不可 |

## ハードウェア固有機能

| Codex Micro | Stream Deck +での扱い |
|---|---|
| 専用キーキャップ交換 | LCDキー中央の大きなアイコン、Agent番号、色と形の状態表示で代替 |
| バッテリー状態 | USB接続のStream Deck +では対象外 |
| 専用照明の明るさ・消灯時間 | Stream Deckアプリの明るさ・スリープ設定を使用 |
| Codex用レイヤーとWork Louder追加レイヤー | Stream Deckのプロファイルとページを使用 |
| 専用ハードウェア検出・Input Monitoring | Stream Deck SDKで検出。Codex操作の補完にはmacOSアクセシビリティを使用 |

## 状態取得経路

Codex MicroはCodexデスクトップ内部の専用デバイス統合を利用できますが、一般のStream Deckプラグインへ同じ接続は公開されていません。本プラグインは次の順序で不足を補います。

1. Codexディープリンクでタスクを開く
2. 公式ショートカットで安定した操作を実行する
3. macOSアクセシビリティ経由でCodexの音声入力ボタンとコマンドパレットを利用する
4. ローカルDBとrolloutを読み取り専用で確認し、タスク状態を推定する
5. 設定ダイヤルの適用時、同じユーザーで起動中のCodexへ常設ローカル接続し、6論理枠で解決した最大6タスクへ完全な4設定を順番に同期する
6. 現在follow中のタスクへは常設Desktop followerで同じpatchの即時反映を先に開始する。その成否にかかわらず、全対象の永続化は同期batch中だけCodex App Serverを`experimentalApi`付きで1回起動して、exact IDごとに`thread/resume`→`thread/settings/update`→読み戻しの順を保つ。異なるタスク間だけ並列にし、batch完了前にDesktop更新も待つ。finallyで停止し、成功件数はApp Server結果を基準にする

参考資料:

- [Codex Micro公式ガイド](https://learn.chatgpt.com/docs/features/codex-micro)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Stream DeckのDials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/guides/dials/)
