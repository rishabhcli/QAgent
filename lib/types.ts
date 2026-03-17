/**
 * QAgent Core Type Definitions
 */

// ============================================================================
// Test Types
// ============================================================================

export interface TestSpec {
  id: string;
  name: string;
  url: string;
  steps: TestStep[];
  timeout?: number;
}

export interface TestStep {
  action: string;
  expected?: string;
  timeout?: number;
}

export interface TestResult {
  passed: boolean;
  duration: number;
  failureReport?: FailureReport;
}

// ============================================================================
// Failure Types
// ============================================================================

export interface FailureReport {
  testId: string;
  timestamp: Date;
  step: number;
  error: {
    message: string;
    stack: string;
    type: string;
  };
  context: {
    url: string;
    screenshot: string;
    domSnapshot: string;
    consoleLogs: ConsoleLog[];
  };
}

export interface ConsoleLog {
  type: 'log' | 'error' | 'warn' | 'uncaught';
  message: string;
  timestamp: number;
}

// ============================================================================
// Diagnosis Types
// ============================================================================

export type FailureType =
  | 'UI_BUG'
  | 'BACKEND_ERROR'
  | 'TEST_FLAKY'
  | 'DATA_ERROR'
  | 'UNKNOWN';

export interface DiagnosisReport {
  failureId: string;
  failureType: FailureType;
  rootCause: string;
  localization: {
    file: string;
    startLine: number;
    endLine: number;
    codeSnippet: string;
  };
  similarIssues: SimilarIssue[];
  suggestedFix: string;
  confidence: number;
}

export interface SimilarIssue {
  id: string;
  similarity: number;
  fix: string;
  diff?: string;
}

export interface FailedAttempt {
  patch: Patch;
  diagnosis: DiagnosisReport;
  verificationError: string;
  iteration: number;
  timestamp: Date;
}

// ============================================================================
// Patch Types
// ============================================================================

export interface Patch {
  id: string;
  diagnosisId: string;
  file: string;
  diff: string;
  description: string;
  metadata: {
    linesAdded: number;
    linesRemoved: number;
    llmModel: string;
    promptTokens: number;
  };
}

export interface PatchResult {
  success: boolean;
  patch?: Patch;
  error?: string;
}

// ============================================================================
// Verification Types
// ============================================================================

export interface VerificationResult {
  success: boolean;
  deploymentUrl?: string;
  testResult?: TestResult;
  error?: string;
}

export interface DeploymentStatus {
  state: 'PENDING' | 'BUILDING' | 'READY' | 'ERROR';
  url?: string;
  error?: string;
}

// ============================================================================
// Orchestrator Types
// ============================================================================

export interface OrchestratorConfig {
  maxIterations: number;
  testSpecs: TestSpec[];
  targetUrl: string;
}

export interface OrchestratorResult {
  success: boolean;
  iterations: number;
  totalDuration: number;
  patches: Patch[];
  finalTestResult?: TestResult;
}

// ============================================================================
// Redis Knowledge Base Types
// ============================================================================

export interface FailureTrace {
  id: string;
  embedding: number[];
  errorMessage: string;
  stackTrace: string;
  file: string;
  line: number;
  failureType: FailureType;
  fix: {
    patchId: string;
    description: string;
    diff: string;
    success: boolean;
  };
  createdAt: Date;
}

// ============================================================================
// Agent Interfaces
// ============================================================================

export interface TesterAgent {
  runTest(spec: TestSpec): Promise<TestResult>;
}

export interface TriageAgent {
  diagnose(failure: FailureReport): Promise<DiagnosisReport>;
}

export interface FixerAgent {
  generatePatch(diagnosis: DiagnosisReport): Promise<PatchResult>;
}

export interface VerifierAgent {
  verify(patch: Patch, testSpec: TestSpec): Promise<VerificationResult>;
}

export interface Orchestrator {
  run(config: OrchestratorConfig): Promise<OrchestratorResult>;
}

// ============================================================================
// Dashboard Types
// ============================================================================

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';
export type AgentType = 'tester' | 'triage' | 'fixer' | 'verifier';

export interface Run {
  id: string;
  ownerId?: number;
  repoId: string;
  repoName: string;
  status: RunStatus;
  currentAgent: AgentType | null;
  iteration: number;
  maxIterations: number;
  testSpecs: TestSpec[];
  patches: Patch[];
  testResults: TestResult[];
  startedAt: Date;
  completedAt?: Date;
  sessionId?: string; // Browserbase session ID for live viewing
}

export type RunEventType =
  | 'status'
  | 'agent'
  | 'test'
  | 'patch'
  | 'complete'
  | 'error'
  | 'activity'
  | 'diagnostics';

export interface RunEvent {
  type: RunEventType;
  timestamp: Date;
  runId: string;
  data: unknown;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface Session {
  user: GitHubUser | null;
  accessToken: string | null;
  repos: GitHubRepo[];
}

/** JWT payload shape for session tokens */
export interface SessionPayload {
  user: GitHubUser;
  accessToken: string;
  repos?: GitHubRepo[];
  expiresAt?: string;
  jti?: string;
}

// ============================================================================
// Activity Log Types
// ============================================================================

export type ActivityAction =
  | 'started'
  | 'completed'
  | 'failed'
  | 'llm_call'
  | 'test_step'
  | 'diagnosis'
  | 'patch'
  | 'deploy'
  | 'screenshot'
  | 'navigation';

export interface LLMCallDetails {
  model: string;
  prompt: string;
  response: string;
  tokens: number;
  duration?: number;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  agent: AgentType;
  action: ActivityAction;
  message: string;
  details?: {
    llmCall?: LLMCallDetails;
    error?: { message: string; stack?: string };
    testStep?: { step: number; action: string; passed?: boolean };
    screenshot?: string;
    url?: string;
  };
}

// ============================================================================
// Agent Execution State Types
// ============================================================================

export interface AgentExecutionState {
  agent: AgentType;
  status: AgentStatus;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  currentAction?: string;
  progress?: number;
  inputs?: unknown;
  outputs?: unknown;
  error?: string;
}

// ============================================================================
// Diagnostics Types
// ============================================================================

export interface TestFailureDiagnostics {
  screenshotUrl?: string;
  domSnapshot?: string;
  consoleLogs: ConsoleLog[];
  errorMessage: string;
  failedStep?: number;
  url?: string;
}

export interface TriageDiagnostics {
  diagnosis?: DiagnosisReport;
  reasoning: string;
  confidenceBreakdown: { category: string; score: number }[];
  similarIssuesCount: number;
}

export interface PatchDiagnostics {
  beforeCode: string;
  afterCode: string;
  filePath: string;
  llmReasoning?: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface VerificationDiagnostics {
  deploymentUrl?: string;
  deploymentStatus: 'pending' | 'building' | 'ready' | 'error';
  buildLogs?: string[];
  retestPassed?: boolean;
  retestDuration?: number;
}

export interface DiagnosticsData {
  testFailure?: TestFailureDiagnostics;
  triage?: TriageDiagnostics;
  patch?: PatchDiagnostics;
  verification?: VerificationDiagnostics;
}

// ============================================================================
// Extended Run Event Types
// ============================================================================

export interface ActivityEvent extends RunEvent {
  type: 'activity';
  data: ActivityLogEntry;
}

export interface DiagnosticsEvent extends RunEvent {
  type: 'diagnostics';
  data: Partial<DiagnosticsData>;
}

// ============================================================================
// Monitoring Types
// ============================================================================

export type MonitoringSchedule = 'hourly' | 'daily' | 'weekly' | 'on_push';

export interface MonitoringConfig {
  repoId: string;
  repoFullName: string;
  enabled: boolean;
  schedule: MonitoringSchedule;
  testSpecs: TestSpec[];
  webhookSecret?: string;
  webhookId?: number;
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type QueuedRunPriority = 'high' | 'normal' | 'low';
export type QueuedRunTrigger = 'webhook' | 'cron' | 'manual';

export interface QueuedRun {
  id: string;
  repoId: string;
  repoFullName: string;
  priority: QueuedRunPriority;
  trigger: QueuedRunTrigger;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  runId?: string; // Reference to the actual run once started
  metadata?: {
    commitSha?: string;
    branch?: string;
    pusher?: string;
    prNumber?: number;
  };
}

export type MetricsPeriod = 'day' | 'week' | 'month';

export interface ImprovementMetrics {
  repoId: string;
  period: MetricsPeriod;
  periodKey: string; // e.g., "2026-01-31" for day, "2026-W05" for week
  passRate: number;
  avgTimeToFix: number; // in milliseconds
  totalRuns: number;
  totalPatches: number;
  successfulPatches: number;
  failedPatches: number;
  totalTests: number;
  passedTests: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// GitHub Webhook Types
// ============================================================================

export interface GitHubPushEvent {
  ref: string;
  before: string;
  after: string;
  repository: {
    id: number;
    full_name: string;
    default_branch: string;
  };
  pusher: {
    name: string;
    email: string;
  };
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string };
  }>;
}

export interface GitHubPullRequestEvent {
  action: 'opened' | 'synchronize' | 'reopened' | 'closed';
  number: number;
  pull_request: {
    id: number;
    number: number;
    title: string;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  repository: {
    id: number;
    full_name: string;
  };
  sender: {
    login: string;
  };
}

// ============================================================================
// Git Clone Types
// ============================================================================

import type { ChildProcess } from 'child_process';

export interface ClonedRepo {
  repoPath: string;           // Temp directory with cloned repo
  devServerPort: number;      // Port dev server runs on
  devServerUrl: string;       // e.g., http://localhost:3456
  devServerProcess: ChildProcess;
  cleanup: () => Promise<void>;
}
