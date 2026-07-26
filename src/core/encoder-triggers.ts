import { encoderRole } from "../coordinator.js";
import type { DeckCoordinates, EncoderSettings } from "../types.js";

export type EncoderTriggerDescription = {
  rotate: string;
  push: string;
  touch: string;
  longTouch: string;
};

export function triggerDescriptionForRole(
  settings: EncoderSettings,
  coordinates: DeckCoordinates
): EncoderTriggerDescription {
  const role = encoderRole(settings, coordinates);
  const descriptions: Record<string, EncoderTriggerDescription> = {
    model: {
      rotate: "モデル候補を選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
      push: "音声入力を開始／もう一度押して文字起こし・送信",
      touch: "現在設定を再読み込み",
      longTouch: "既定モデルへ戻して適用"
    },
    reasoning: {
      rotate: "推論レベルを選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
      push: "音声入力を開始／もう一度押して文字起こし・送信",
      touch: "現在設定を再読み込み",
      longTouch: "既定の推論レベルへ戻して適用"
    },
    speed: {
      rotate: "速度を選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
      push: "音声入力を開始／もう一度押して文字起こし・送信",
      touch: "現在設定を再読み込み",
      longTouch: "標準速度へ戻して適用"
    },
    approval: {
      rotate: "アクセス候補を選び、停止80ミリ秒後に自動適用（音声入力中は無効）",
      push: "音声入力を開始／もう一度押して文字起こし・送信",
      touch: "現在設定を再読み込み・待機中の適用を中止",
      longTouch: "Askへ戻して適用・待機中の適用を中止"
    },
    "legacy-reasoning": {
      rotate: "推論レベルを上げる／下げる",
      push: "推論メニューを開く",
      touch: "高速モードを切り替える",
      longTouch: "プランモードを切り替える"
    },
    navigation: {
      rotate: "履歴を戻る／進む",
      push: "サイドバーを切り替える",
      touch: "新しいタスクを作る",
      longTouch: "クイックチャットを開く"
    },
    skills: {
      rotate: "コマンドを選ぶ",
      push: "選択コマンドを実行する",
      touch: "スキルを開く",
      longTouch: "レビューを開く"
    },
    composer: {
      rotate: "入力カーソルを移動する",
      push: "押している間、音声入力する",
      touch: "メッセージを送信する",
      longTouch: "新しいタスクで続ける"
    },
    voice: {
      rotate: "入力カーソルを移動する",
      push: "押している間、音声入力する",
      touch: "メッセージを送信する",
      longTouch: "新しいタスクで続ける"
    },
    review: {
      rotate: "履歴を戻る／進む",
      push: "レビューを開く",
      touch: "レビューを開く",
      longTouch: "レビューを開く"
    }
  };
  const description = descriptions[role] ?? descriptions.model!;
  return {
    ...description,
    ...(settings.counterClockwiseShortcut || settings.clockwiseShortcut
      ? { rotate: "カスタム操作を実行する" } : {}),
    ...(settings.pressShortcut
      && !["model", "reasoning", "speed", "approval"].includes(role)
      ? { push: "カスタム操作を実行する" } : {})
  };
}
