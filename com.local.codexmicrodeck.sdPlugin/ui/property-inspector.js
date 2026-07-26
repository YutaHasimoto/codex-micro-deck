(() => {
  "use strict";

  const DEFAULT_GLOBALS = {
    accessibilityEnabled: true,
    pollIntervalMs: 2000
  };
  const POLL_INTERVALS = [1000, 2000, 5000, 10000, 30000];
  const ENCODER_RESULT_GUIDE = "Deck表示は通常成功時は選択中の値のまま、X/Nが一部または全部の同期失敗（全件失敗は0/N）、Defaultが対象0件で新規タスクの既定値のみです。Model／Reasoning／Speed／Accessのダイヤル押下は共通の音声入力です。";

  const agentRoles = Array.from({ length: 6 }, (_, index) => ({
    value: `agent-${index + 1}`,
    label: `Agent ${index + 1}`,
    summary: "Codexのタスクと現在の状態を表示します。",
    operations: [
      ["1回押す", "タスクを背景で開く"],
      ["すばやく2回", "タスクを前面で開く"]
    ]
  }));

  const KEY_ROLES = [
    ...agentRoles,
    role("approve", "承認（安全確認あり）", "キーが点灯している実承認待ちだけを承認します。質問への回答には使いません。", [["押す", "点灯中の承認要求を承認"]]),
    role("decline", "却下（安全確認あり）", "キーが点灯している実承認待ちだけを却下します。質問への回答には使いません。", [["押す", "点灯中の承認要求を却下"]]),
    role("fast", "高速モード", "高速モードを切り替えます。", [["押す", "ON / OFFを切り替える"]]),
    role("submit", "送信", "入力中の内容をCodexへ送ります。", [["押す", "メッセージを送信"]]),
    role("new-chat", "新しいタスク", "空のタスクをすぐ開きます。", [["押す", "新しいタスクを作成"]]),
    role("fork", "別タスクへ分岐", "現在の会話を新しいタスクで続けます。", [["押す", "新しいタスクで続ける"]]),
    role("ptt", "音声入力", "押している間だけCodexの音声入力を行い、離すと文字起こしを入力欄へ挿入します。", [["押している間", "録音"], ["離す", "文字起こしを挿入"]]),
    role("interrupt", "生成を中断", "実行中のCodexを停止します。", [["押す", "現在の生成を停止"]]),
    role("review", "レビュー", "Codexのレビュー画面を開きます。", [["押す", "レビューを開く"]]),
    role("skills", "スキル", "Codexのスキル画面を開きます。", [["押す", "スキルを開く"]]),
    role("open-codex", "Codexを開く", "Codexアプリを前面に出します。", [["押す", "Codexを開く"]]),
    role("refresh", "状態を更新", "Agentキーの状態をすぐ更新します。", [["押す", "最新の状態を取得"]])
  ];

  const ENCODER_ROLES = [
    role("model", "モデル", "新規タスクの既定値を保存し、Deckで追跡中のAgentタスクへ同じ4設定を同期します。各タスクでは次のターンから有効で、現在実行中のターンは変わりません。モデルは回転停止から80ミリ秒後に適用します。通常はCodexの再起動は不要です。", [
      ["回す", "モデル候補を選ぶ（80ミリ秒後に自動適用）"], ["押す", "音声入力を開始／もう一度押して文字起こし・送信"],
      ["タップ", "現在設定を再読込"], ["長押し", "キャッシュ既定値へ戻して適用"]
    ]),
    role("reasoning", "推論", "新規タスクの既定値を保存し、Deckで追跡中のAgentタスクへ同じ4設定を同期します。各タスクでは次のターンから有効で、現在実行中のターンは変わりません。推論レベルは回転停止から80ミリ秒後に適用します。通常はCodexの再起動は不要です。", [
      ["回す", "推論レベル候補を選ぶ（80ミリ秒後に自動適用）"], ["押す", "音声入力を開始／もう一度押して文字起こし・送信"],
      ["タップ", "現在設定を再読込"], ["長押し", "モデル既定値へ戻して適用"]
    ]),
    role("speed", "速度", "新規タスクの既定値を保存し、Deckで追跡中のAgentタスクへ同じ4設定を同期します。各タスクでは次のターンから有効で、現在実行中のターンは変わりません。応答速度はStandard / Fastの2択で、回転停止から80ミリ秒後に適用します。通常はCodexの再起動は不要です。", [
      ["回す", "速度候補を選ぶ（80ミリ秒後に自動適用）"], ["押す", "音声入力を開始／もう一度押して文字起こし・送信"],
      ["タップ", "現在設定を再読込"], ["長押し", "既定値へ戻して適用（Standard）"]
    ]),
    role("approval", "Access", "新規タスクの既定値とDeckで追跡中のAgentタスクへ、Ask／Delegate／Full／Customを同期します。Askはworkspace書込み＋本人確認、Delegateはworkspace書込み＋代理承認、Fullはフルアクセス＋確認なしです。Accessは回転停止から80ミリ秒後に自動適用され、Fullも回転停止後80ミリ秒で適用します。Customだけはconfig.tomlを変更せず、現在のapproval・reviewer・sandbox設定をそのままタスクへ送ります。各タスクでは次のターンから有効で、現在実行中のターンは変わりません。", [
      ["回す", "Access候補を選ぶ（停止80ミリ秒後に次のターンへ自動適用）"], ["押す", "音声入力を開始／もう一度押して文字起こし・送信"],
      ["タップ", "現在設定を再読込・待機中の自動適用を中止"], ["長押し", "Askへ戻して適用・待機中の自動適用を中止"]
    ])
  ];

  const LEGACY_ENCODER_ROLES = [
    role("legacy-reasoning", "旧レイアウト（互換）：推論", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "推論を浅く / 深く"], ["押す", "推論メニュー"],
      ["タップ", "高速モード"], ["長押し", "Planモード"]
    ]),
    role("navigation", "旧レイアウト（互換）：画面移動", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "戻る / 進む"], ["押す", "サイドバー"],
      ["タップ", "新しいタスク"], ["長押し", "クイックチャット"]
    ]),
    role("skills", "旧レイアウト（互換）：コマンド", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "機能を選ぶ"], ["押す", "選んだ機能を実行"],
      ["タップ", "スキル"], ["長押し", "レビュー"]
    ]),
    role("composer", "旧レイアウト（互換）：音声と送信", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "カーソルを移動"], ["押している間", "音声入力"],
      ["タップ", "送信"], ["長押し", "別タスクへ分岐"]
    ]),
    role("review", "旧レイアウト（互換）：レビュー", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "戻る / 進む"], ["押す", "レビューを開く"],
      ["タップ", "レビューを開く"], ["長押し", "レビューを開く"]
    ]),
    role("voice", "旧レイアウト（互換）：音声入力", "以前のカスタム操作を保っています。切り替える場合は、新しい4ダイヤルの役割を選び直します。", [
      ["回す", "カーソルを移動"], ["押している間", "音声入力"],
      ["タップ", "送信"], ["長押し", "別タスクへ分岐"]
    ])
  ];

  let socket;
  let context;
  let actionUuid = "";
  let settings = {};
  let globals = { ...DEFAULT_GLOBALS };
  let actionSaveTimer;
  let globalSaveTimer;
  let savedFallbackTimer;
  let saveRevision = 0;

  const $ = (id) => document.getElementById(id);
  const elements = {
    role: $("role"),
    roleSummary: $("role-summary"),
    roleOperations: $("role-operations"),
    autoAssign: $("auto-assign"),
    threadId: $("thread-id"),
    threadIdHelp: $("thread-id-help"),
    shortcut: $("shortcut"),
    shortcutLeft: $("shortcut-left"),
    shortcutRight: $("shortcut-right"),
    shortcutPress: $("shortcut-press"),
    shortcutMessage: $("shortcut-message"),
    accessibility: $("accessibility-enabled"),
    pollInterval: $("poll-interval"),
    saveState: $("save-state"),
    connection: $("connection-state"),
    connectionText: document.querySelector(".connection-text")
  };

  function role(value, label, summary, operations) {
    return { value, label, summary, operations };
  }

  function isEncoder() {
    return actionUuid.endsWith(".encoder");
  }

  function isAgentRole(value) {
    return /^agent-[1-6]$/.test(value || "");
  }

  function isProtectedRole(value) {
    return value === "approve" || value === "decline";
  }

  function isVoiceEncoder(value) {
    return value === "composer" || value === "voice";
  }

  function isFocusedEncoder(value) {
    return value === "model" || value === "reasoning" || value === "speed" || value === "approval";
  }

  function currentRole() {
    return elements.role.value || (isEncoder() ? "model" : "agent-1");
  }

  function rolesForCurrentAction() {
    if (!isEncoder()) return KEY_ROLES;
    const legacy = LEGACY_ENCODER_ROLES.find((item) => item.value === settings.role);
    return legacy ? [legacy, ...ENCODER_ROLES] : ENCODER_ROLES;
  }

  function send(event, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ event, context, payload }));
    return true;
  }

  function setSaveState(text, state = "") {
    elements.saveState.textContent = text;
    elements.saveState.className = `save-status${state ? ` ${state}` : ""}`;
  }

  function setConnectionState(text, state = "") {
    elements.connectionText.textContent = text;
    elements.connection.className = `connection${state ? ` ${state}` : ""}`;
  }

  function scheduleSave(kind) {
    const revision = ++saveRevision;
    setSaveState("保存中…", "saving");
    const timerName = kind === "action" ? "actionSaveTimer" : "globalSaveTimer";
    if (timerName === "actionSaveTimer") clearTimeout(actionSaveTimer);
    else clearTimeout(globalSaveTimer);

    const callback = () => {
      const sent = kind === "action"
        ? send("setSettings", settings)
        : send("setGlobalSettings", globals);
      if (!sent) {
        setSaveState("未接続", "error");
        return;
      }
      clearTimeout(savedFallbackTimer);
      savedFallbackTimer = setTimeout(() => {
        if (revision === saveRevision && !hasInputErrors()) setSaveState("保存済み", "saved");
      }, 450);
    };

    if (timerName === "actionSaveTimer") actionSaveTimer = setTimeout(callback, 120);
    else globalSaveTimer = setTimeout(callback, 120);
  }

  function renderRoleOptions() {
    const roles = rolesForCurrentAction();
    const selected = settings.role || (isEncoder() ? "model" : "agent-1");
    elements.role.replaceChildren(...roles.map((item) => {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.title = item.summary;
      return option;
    }));
    elements.role.value = roles.some((item) => item.value === selected)
      ? selected
      : roles[0].value;
  }

  function renderRoleGuide() {
    const roles = rolesForCurrentAction();
    const selected = roles.find((item) => item.value === currentRole()) || roles[0];
    elements.roleSummary.textContent = `${selected.summary}${isEncoder() ? ` ${ENCODER_RESULT_GUIDE}` : ""}`;
    elements.roleOperations.replaceChildren(...selected.operations.map(([trigger, result]) => {
      const row = document.createElement("div");
      row.className = "operation";
      const triggerElement = document.createElement("span");
      triggerElement.className = "operation-trigger";
      triggerElement.textContent = trigger;
      const resultElement = document.createElement("span");
      resultElement.className = "operation-result";
      resultElement.textContent = result;
      row.append(triggerElement, resultElement);
      return row;
    }));
  }

  function renderVisibility() {
    const roleValue = currentRole();
    const agent = !isEncoder() && isAgentRole(roleValue);
    const protectedRole = !isEncoder() && isProtectedRole(roleValue);
    $("agent-options").hidden = !agent;
    $("fixed-thread-options").hidden = !agent || elements.autoAssign.checked;
    $("approval-guard").hidden = !protectedRole;
    $("shortcut-options").hidden = agent || protectedRole;
    document.querySelector(".encoder-shortcuts").hidden = !isEncoder();
    document.querySelector(".key-shortcut").hidden = isEncoder();
    $("press-shortcut-field").hidden = !isEncoder()
      || isVoiceEncoder(roleValue)
      || isFocusedEncoder(roleValue);
  }

  function render() {
    renderRoleOptions();
    elements.autoAssign.checked = settings.autoAssign !== false;
    elements.threadId.value = settings.threadId || "";
    elements.shortcut.value = settings.shortcut || "";
    elements.shortcutLeft.value = settings.counterClockwiseShortcut || "";
    elements.shortcutRight.value = settings.clockwiseShortcut || "";
    elements.shortcutPress.value = settings.pressShortcut || "";
    elements.accessibility.checked = globals.accessibilityEnabled !== false;
    elements.pollInterval.value = String(nearestPollInterval(globals.pollIntervalMs));
    $("action-heading").textContent = isEncoder() ? "ダイヤルの設定" : "キーの設定";
    $("action-kind").textContent = isEncoder() ? "CODEX DIAL" : "CODEX KEY";
    renderRoleGuide();
    renderVisibility();
    updateThreadIdState();
    updateShortcutState();
  }

  function nearestPollInterval(value) {
    const numeric = Number(value) || DEFAULT_GLOBALS.pollIntervalMs;
    return POLL_INTERVALS.reduce((nearest, candidate) => (
      Math.abs(candidate - numeric) < Math.abs(nearest - numeric) ? candidate : nearest
    ));
  }

  function validThreadId(value) {
    return /^[0-9a-f-]{16,64}$/i.test(value);
  }

  function updateThreadIdState() {
    const value = elements.threadId.value.trim();
    const fixedAssignment = !isEncoder() && isAgentRole(currentRole()) && !elements.autoAssign.checked;
    const invalid = fixedAssignment && value.length > 0 && !validThreadId(value);
    elements.threadId.setAttribute("aria-invalid", String(invalid));
    elements.threadIdHelp.classList.toggle("error", invalid || (!value && fixedAssignment));
    if (invalid) elements.threadIdHelp.textContent = "タスクIDの形式を確認してください。まだ保存していません。";
    else if (!value && fixedAssignment) elements.threadIdHelp.textContent = "IDを入れるまでは未割り当てです。";
    else elements.threadIdHelp.textContent = "CodexのタスクURL末尾にあるIDを貼り付けます。";
    return !invalid;
  }

  function validShortcut(value) {
    if (!value) return true;
    const tokens = value.toLowerCase().split("+").map((token) => token.trim()).filter(Boolean);
    if (!tokens.length) return false;
    const key = tokens.pop();
    const modifiers = new Set(["cmd", "command", "meta", "ctrl", "control", "alt", "opt", "option", "shift"]);
    const named = new Set(["enter", "return", "escape", "esc", "space", "tab", "left", "right", "down", "up", "delete", "backspace"]);
    return tokens.every((token) => modifiers.has(token))
      && (named.has(key) || /^[a-z0-9\[\]\/.,\-=]$/.test(key));
  }

  function updateShortcutState(activeInput) {
    const roleValue = currentRole();
    const inputs = isEncoder()
      ? [elements.shortcutLeft, elements.shortcutRight,
        ...(!isVoiceEncoder(roleValue) && !isFocusedEncoder(roleValue) ? [elements.shortcutPress] : [])]
      : (!isAgentRole(roleValue) && !isProtectedRole(roleValue) ? [elements.shortcut] : []);
    const allInputs = [elements.shortcut, elements.shortcutLeft, elements.shortcutRight, elements.shortcutPress];
    let invalid = false;
    for (const input of allInputs) {
      if (!inputs.includes(input)) {
        input.setAttribute("aria-invalid", "false");
        continue;
      }
      const inputInvalid = !validShortcut(input.value.trim());
      input.setAttribute("aria-invalid", String(inputInvalid));
      if (inputInvalid) invalid = true;
    }
    elements.shortcutMessage.classList.toggle("error", invalid);
    elements.shortcutMessage.textContent = invalid
      ? "形式を確認してください。例: cmd+shift+r / escape"
      : "使えるキー: A〜Z、数字、矢印、Enter、Escape";
    return activeInput ? validShortcut(activeInput.value.trim()) : !invalid;
  }

  function hasInputErrors() {
    return Boolean(document.querySelector('[aria-invalid="true"]'));
  }

  function showInputError() {
    saveRevision += 1;
    clearTimeout(actionSaveTimer);
    clearTimeout(savedFallbackTimer);
    setSaveState("入力を確認", "error");
  }

  elements.role.addEventListener("change", () => {
    settings.role = elements.role.value;
    if (isProtectedRole(settings.role)) {
      delete settings.shortcut;
      elements.shortcut.value = "";
    }
    renderRoleGuide();
    renderVisibility();
    updateThreadIdState();
    updateShortcutState();
    scheduleSave("action");
  });

  elements.autoAssign.addEventListener("change", () => {
    settings.autoAssign = elements.autoAssign.checked;
    renderVisibility();
    if (!updateThreadIdState()) {
      showInputError();
      return;
    }
    scheduleSave("action");
  });

  elements.threadId.addEventListener("input", () => {
    const value = elements.threadId.value.trim();
    if (!updateThreadIdState()) {
      showInputError();
      return;
    }
    settings.threadId = value;
    scheduleSave("action");
  });

  bindShortcut(elements.shortcut, "shortcut");
  bindShortcut(elements.shortcutLeft, "counterClockwiseShortcut");
  bindShortcut(elements.shortcutRight, "clockwiseShortcut");
  bindShortcut(elements.shortcutPress, "pressShortcut");

  function bindShortcut(input, property) {
    input.addEventListener("input", () => {
      if (!updateShortcutState(input)) {
        showInputError();
        return;
      }
      settings[property] = input.value.trim();
      scheduleSave("action");
    });
  }

  elements.pollInterval.addEventListener("change", () => {
    globals.pollIntervalMs = Number(elements.pollInterval.value) || DEFAULT_GLOBALS.pollIntervalMs;
    scheduleSave("global");
  });

  elements.accessibility.addEventListener("change", () => {
    globals.accessibilityEnabled = elements.accessibility.checked;
    scheduleSave("global");
  });

  window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, rawActionInfo) => {
    context = uuid;
    try {
      const actionInfo = JSON.parse(rawActionInfo || "{}");
      actionUuid = actionInfo.action || "";
      settings = actionInfo.payload?.settings || {};
    } catch {
      setConnectionState("設定を読み取れませんでした", "error");
      setSaveState("読取エラー", "error");
    }

    render();
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ event: registerEvent, uuid }));
      send("getGlobalSettings", {});
      setConnectionState("Stream Deckに接続済み", "connected");
      setSaveState("準備完了");
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === "didReceiveSettings") {
          settings = message.payload?.settings || settings;
          render();
        }
        if (message.event === "didReceiveGlobalSettings") {
          globals = { ...DEFAULT_GLOBALS, ...(message.payload?.settings || {}) };
          elements.accessibility.checked = globals.accessibilityEnabled !== false;
          elements.pollInterval.value = String(nearestPollInterval(globals.pollIntervalMs));
        }
        if ((message.event === "didReceiveSettings" || message.event === "didReceiveGlobalSettings")
          && !hasInputErrors()) {
          setSaveState("保存済み", "saved");
        }
      } catch {
        setSaveState("受信エラー", "error");
      }
    });
    socket.addEventListener("close", () => {
      setConnectionState("Stream Deckとの接続が切れました", "error");
      setSaveState("未接続", "error");
    });
  };
})();
