(() => {
  "use strict";

  const DEFAULT_GLOBALS = {
    accessibilityEnabled: true,
    pollIntervalMs: 2000
  };
  const POLL_INTERVALS = [1000, 2000, 5000, 10000, 30000];
  const ENCODER_RESULT_GUIDE = "On the Deck, a successful update keeps the selected value visible. X/N means some or all task syncs failed (0/N means all failed). Default means there were no target tasks and only the new-task defaults were saved. Pressing any Model, Reasoning, Speed, or Access dial uses the shared dictation control.";

  const agentRoles = Array.from({ length: 6 }, (_, index) => ({
    value: `agent-${index + 1}`,
    label: `Agent ${index + 1}`,
    summary: "Shows a Codex task and its current status.",
    operations: [
      ["Press once", "Open the task in the background"],
      ["Double-press quickly", "Open the task in the foreground"]
    ]
  }));

  const KEY_ROLES = [
    ...agentRoles,
    role("approve", "Approve (guarded)", "Approves only an actionable request while this key is lit. It cannot answer questions.", [["Press", "Approve the active request"]]),
    role("decline", "Decline (guarded)", "Declines only an actionable request while this key is lit. It cannot answer questions.", [["Press", "Decline the active request"]]),
    role("fast", "Fast Mode", "Toggles Fast Mode.", [["Press", "Toggle on or off"]]),
    role("submit", "Send Message", "Sends the current input to Codex.", [["Press", "Send the message"]]),
    role("new-chat", "New Task", "Opens an empty task immediately.", [["Press", "Create a new task"]]),
    role("fork", "Continue in New Task", "Continues the current conversation in a new task.", [["Press", "Continue in a new task"]]),
    role("ptt", "Push to Talk", "Records Codex dictation only while held, then inserts the transcript into the composer when released.", [["Hold", "Record"], ["Release", "Insert transcript"]]),
    role("voice-toggle", "Dictation Toggle", "Press once to start Codex dictation. Press again to transcribe and send the text.", [["Press once", "Start dictation"], ["Press again", "Transcribe and send"]]),
    role("interrupt", "Stop Generation", "Stops the running Codex response.", [["Press", "Stop the current response"]]),
    role("review", "Review", "Opens the Codex review view.", [["Press", "Open review"]]),
    role("skills", "Skills", "Opens the Codex skills view.", [["Press", "Open skills"]]),
    role("open-codex", "Open Codex", "Brings the Codex app to the foreground.", [["Press", "Open Codex"]]),
    role("refresh", "Refresh Status", "Refreshes Agent key status immediately.", [["Press", "Fetch the latest status"]])
  ];

  const ENCODER_ROLES = [
    role("model", "Model", "Saves the new-task default and syncs the same four settings to Agent tasks tracked on the Deck. Each task uses the change from its next turn; a turn already in progress does not change. Model automatically applies 80 ms after rotation stops. Codex normally does not need to restart.", [
      ["Rotate", "Choose a model (auto-applies after 80 ms)"], ["Press", "Start dictation / press again to transcribe and send"],
      ["Tap", "Reload current settings"], ["Hold", "Reset to the cached default and apply"]
    ]),
    role("reasoning", "Reasoning", "Saves the new-task default and syncs the same four settings to Agent tasks tracked on the Deck. Each task uses the change from its next turn; a turn already in progress does not change. Reasoning automatically applies 80 ms after rotation stops. Codex normally does not need to restart.", [
      ["Rotate", "Choose a reasoning level (auto-applies after 80 ms)"], ["Press", "Start dictation / press again to transcribe and send"],
      ["Tap", "Reload current settings"], ["Hold", "Reset to the model default and apply"]
    ]),
    role("speed", "Speed", "Saves the new-task default and syncs the same four settings to Agent tasks tracked on the Deck. Each task uses the change from its next turn; a turn already in progress does not change. Speed offers Standard and Fast, and automatically applies 80 ms after rotation stops. Codex normally does not need to restart.", [
      ["Rotate", "Choose a speed (auto-applies after 80 ms)"], ["Press", "Start dictation / press again to transcribe and send"],
      ["Tap", "Reload current settings"], ["Hold", "Reset to the default (Standard) and apply"]
    ]),
    role("approval", "Access", "Syncs Ask, Delegate, Full, or Custom to the new-task default and Agent tasks tracked on the Deck. Ask allows workspace writes with user approval. Delegate allows workspace writes with delegated approval. Full grants full access without confirmation. Access automatically applies 80 ms after rotation stops, including Full. Only Custom leaves config.toml unchanged and sends the current approval, reviewer, and sandbox settings to the tasks. Each task uses the change from its next turn; a turn already in progress does not change.", [
      ["Rotate", "Choose an Access mode (auto-applies to the next turn after 80 ms)"], ["Press", "Start dictation / press again to transcribe and send"],
      ["Tap", "Reload current settings and cancel pending auto-apply"], ["Hold", "Reset to Ask, apply, and cancel pending auto-apply"]
    ])
  ];

  const LEGACY_ENCODER_ROLES = [
    role("legacy-reasoning", "Legacy Layout: Reasoning", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Decrease / increase reasoning"], ["Press", "Reasoning menu"],
      ["Tap", "Fast Mode"], ["Hold", "Plan Mode"]
    ]),
    role("navigation", "Legacy Layout: Navigation", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Back / forward"], ["Press", "Sidebar"],
      ["Tap", "New task"], ["Hold", "Quick chat"]
    ]),
    role("skills", "Legacy Layout: Commands", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Choose a command"], ["Press", "Run the selected command"],
      ["Tap", "Skills"], ["Hold", "Review"]
    ]),
    role("composer", "Legacy Layout: Dictation and Send", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Move the cursor"], ["Hold", "Dictation"],
      ["Tap", "Send"], ["Touch and hold", "Continue in a new task"]
    ]),
    role("review", "Legacy Layout: Review", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Back / forward"], ["Press", "Open review"],
      ["Tap", "Open review"], ["Hold", "Open review"]
    ]),
    role("voice", "Legacy Layout: Dictation", "Preserves a previous custom control. To switch, choose one of the new four-dial roles.", [
      ["Rotate", "Move the cursor"], ["Hold", "Dictation"],
      ["Tap", "Send"], ["Touch and hold", "Continue in a new task"]
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
    setSaveState("Saving…", "saving");
    const timerName = kind === "action" ? "actionSaveTimer" : "globalSaveTimer";
    if (timerName === "actionSaveTimer") clearTimeout(actionSaveTimer);
    else clearTimeout(globalSaveTimer);

    const callback = () => {
      const sent = kind === "action"
        ? send("setSettings", settings)
        : send("setGlobalSettings", globals);
      if (!sent) {
        setSaveState("Disconnected", "error");
        return;
      }
      clearTimeout(savedFallbackTimer);
      savedFallbackTimer = setTimeout(() => {
        if (revision === saveRevision && !hasInputErrors()) setSaveState("Saved", "saved");
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
    $("action-heading").textContent = isEncoder() ? "Configure Dial" : "Configure Key";
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
    if (invalid) elements.threadIdHelp.textContent = "Check the Task ID format. This value has not been saved.";
    else if (!value && fixedAssignment) elements.threadIdHelp.textContent = "This key stays unassigned until you enter an ID.";
    else elements.threadIdHelp.textContent = "Paste the ID from the end of the Codex task URL.";
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
      ? "Check the format. Example: cmd+shift+r / escape"
      : "Supported keys: A–Z, numbers, arrows, Enter, and Escape";
    return activeInput ? validShortcut(activeInput.value.trim()) : !invalid;
  }

  function hasInputErrors() {
    return Boolean(document.querySelector('[aria-invalid="true"]'));
  }

  function showInputError() {
    saveRevision += 1;
    clearTimeout(actionSaveTimer);
    clearTimeout(savedFallbackTimer);
    setSaveState("Check Input", "error");
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
      setConnectionState("Could not read settings", "error");
      setSaveState("Read Error", "error");
    }

    render();
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ event: registerEvent, uuid }));
      send("getGlobalSettings", {});
      setConnectionState("Connected to Stream Deck", "connected");
      setSaveState("Ready");
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
          setSaveState("Saved", "saved");
        }
      } catch {
        setSaveState("Receive Error", "error");
      }
    });
    socket.addEventListener("close", () => {
      setConnectionState("Disconnected from Stream Deck", "error");
      setSaveState("Disconnected", "error");
    });
  };
})();
