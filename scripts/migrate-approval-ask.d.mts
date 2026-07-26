export type ApprovalAskPatch = Readonly<{
  approvalPolicy: "on-request";
  approvalsReviewer: "user";
}>;

export type MigrationResult = {
  mode: "dry-run" | "apply";
  targetCount: number;
  updatedCount: number;
  globalChanged: boolean;
  globalWouldChange: boolean;
};

export type MigrationDependencies = {
  provider: {
    listRecentThreads(): Promise<Array<{ id: string }>>;
  };
  config: {
    read(): Promise<{ approval: string }>;
    applyControl(role: string, value: string): Promise<{ approval: string }>;
  };
  follower: {
    isConnected: boolean;
    start(): void;
    stop(): void;
    onChange(listener: () => void): () => void;
    setDesiredConversations(conversationIds: readonly string[]): void;
    updateThreadSettings(conversationId: string, patch: ApprovalAskPatch): Promise<void>;
  };
  appServer: {
    start(
      cliPath: string,
      options: { experimentalApi?: boolean }
    ): Promise<void>;
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
    stop(): Promise<void>;
  };
  resolveCliPath(): Promise<string>;
};

export const REQUIRED_TARGET_COUNT: 6;
export const DEFAULT_CONNECTION_TIMEOUT_MS: 8000;
export const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS: 15000;
export const DEFAULT_CODEX_CLI_CANDIDATES: readonly string[];
export const APPROVAL_ASK_PATCH: ApprovalAskPatch;

export function parseMigrationArgs(argv: string[]): {
  apply: boolean;
  help: boolean;
};

export function assertApprovalOnlyPatch(patch: unknown): ApprovalAskPatch;
export function exactRecentThreadIds(threads: Array<{ id?: unknown }>): string[];

export function waitForFollowerConnection(
  follower: MigrationDependencies["follower"],
  timeoutMs?: number
): Promise<void>;

export function resolveCodexCliPath(
  candidates?: readonly string[],
  canExecute?: (candidate: string) => Promise<boolean>
): Promise<string>;

export function updateThreadsViaAppServer(
  appServer: MigrationDependencies["appServer"],
  cliPath: string,
  conversationIds: readonly string[],
  options?: { requestTimeoutMs?: number }
): Promise<{
  updatedCount: number;
  failedIds: string[];
}>;

export function runApprovalAskMigration(
  dependencies: MigrationDependencies,
  options?: {
    apply?: boolean;
    connectionTimeoutMs?: number;
    appServerRequestTimeoutMs?: number;
    report?: (result: MigrationResult) => void;
  }
): Promise<MigrationResult>;

export function formatMigrationResult(result: MigrationResult): string;
