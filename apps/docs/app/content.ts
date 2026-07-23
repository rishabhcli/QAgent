export type CalloutTone = 'info' | 'warning' | 'success';

interface DocumentSection {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
  code?: string;
  table?: { headers: string[]; rows: string[][] };
  callout?: { tone: CalloutTone; text: string };
}

interface DocumentPage {
  title: string;
  category: string;
  summary: string;
  sections: DocumentSection[];
}

export const navigation = [
  {
    label: 'Start',
    items: [
      { slug: 'installation', title: 'Installation' },
      { slug: 'quickstart', title: 'Five-minute quickstart' },
      { slug: 'windows', title: 'Windows setup' },
    ],
  },
  {
    label: 'Understand',
    items: [
      { slug: 'architecture', title: 'Architecture' },
      { slug: 'providers', title: 'Provider matrix' },
      { slug: 'data-policy', title: 'Telemetry and data' },
      { slug: 'threat-model', title: 'Threat model' },
    ],
  },
  {
    label: 'Extend',
    items: [
      { slug: 'adapters', title: 'Adapter guide' },
      { slug: 'migration', title: 'Migrate from v0.1' },
      { slug: 'governance', title: 'Governance' },
      { slug: 'roadmap', title: 'Roadmap' },
      { slug: 'troubleshooting', title: 'Troubleshooting' },
    ],
  },
];

export const documents: Record<string, DocumentPage> = {
  installation: {
    title: 'Installation',
    category: 'Start',
    summary: 'Install the beta desktop app or the same engine as a command-line tool.',
    sections: [
      {
        id: 'requirements',
        title: 'Requirements',
        bullets: [
          'macOS 13 or later on Apple silicon or Intel',
          'Windows 10 22H2 or later on x64',
          'A current x64 Linux distribution with a desktop keyring',
          'Git 2.39 or later and a local Chrome, Edge, or Chromium browser',
          'One configured OpenAI, Anthropic, Google, Ollama, or compatible model endpoint',
        ],
      },
      {
        id: 'desktop',
        title: 'Desktop beta',
        paragraphs: [
          'Download the artifact for your operating system from the GitHub release and verify its SHA-256 checksum before opening it. Unsigned beta builds are labeled UNSIGNED and do not receive automatic updates.',
        ],
        code: 'shasum -a 256 QAgent-*.zip\n# Compare the result with SHA256SUMS.txt',
      },
      {
        id: 'source',
        title: 'Build from source',
        code: 'corepack enable\ncorepack prepare pnpm@11.15.1 --activate\npnpm install --frozen-lockfile\npnpm build\npnpm package',
        callout: {
          tone: 'info',
          text: 'QAgent pins Node 24 and pnpm 11.15.1. Other major Node versions are outside the supported build matrix.',
        },
      },
      {
        id: 'cli',
        title: 'CLI and MCP',
        code: 'pnpm qagent doctor\npnpm qagent --json project list\npnpm mcp',
      },
    ],
  },
  quickstart: {
    title: 'Five-minute quickstart',
    category: 'Start',
    summary:
      'Run a grounded repair without handing QAgent your active checkout or any cloud infrastructure.',
    sections: [
      {
        id: 'open',
        title: '1. Choose and trust a repository',
        paragraphs: [
          'Open QAgent, choose a Git repository, inspect the detected commands, and grant workspace trust. Trust applies only to that registered canonical path and can be revoked in Settings.',
        ],
      },
      {
        id: 'configure',
        title: '2. Confirm .qagent.yml',
        paragraphs: [
          'QAgent detects common stacks but never guesses an ambiguous command at runtime. Commit a configuration with structured executable and argument arrays.',
        ],
        code: 'version: 1\ntest:\n  commands:\n    - executable: pnpm\n      args: [test]\nmodel:\n  provider: openai\n  model: gpt-5-mini\npublish:\n  provider: local',
      },
      {
        id: 'connect',
        title: '3. Connect a model',
        paragraphs: [
          'Use the onboarding connection test. Credentials are encrypted with the operating-system key store when available; environment and session credentials remain alternatives. No provider means a visible blocked state, never a mock response.',
        ],
      },
      {
        id: 'doctor',
        title: '4. Run Doctor',
        code: 'qagent doctor\nqagent --json doctor',
        paragraphs: [
          'Doctor reports each dependency as available, unavailable, or unconfigured with its source and observation time.',
        ],
      },
      {
        id: 'run',
        title: '5. Start and inspect a run',
        code: 'qagent project add /absolute/path/to/repository --trust\nqagent run start <project-id>\nqagent run show <run-id>',
        callout: {
          tone: 'success',
          text: 'A successful local run ends on a qagent/<run>-<slug> branch. The original checkout is never changed.',
        },
      },
    ],
  },
  windows: {
    title: 'Windows setup',
    category: 'Start',
    summary: 'Prepare Git, a browser, credentials, and signing expectations on Windows.',
    sections: [
      {
        id: 'prerequisites',
        title: 'Prerequisites',
        steps: [
          'Install Git for Windows and enable long paths.',
          'Install Chrome or Edge for all users, or use QAgent managed Chromium.',
          'Install the x64 QAgent beta package.',
          'Run Doctor before trusting a project.',
        ],
        code: 'git config --global core.longpaths true\nqagent doctor',
      },
      {
        id: 'credentials',
        title: 'Credential storage',
        paragraphs: [
          'Electron safeStorage uses Windows DPAPI. QAgent stores encrypted values under its user-data directory and never copies credentials into worktrees, artifacts, events, or exports.',
        ],
      },
      {
        id: 'unsigned',
        title: 'Unsigned beta packages',
        callout: {
          tone: 'warning',
          text: 'An unsigned beta may trigger Windows SmartScreen. Release files are named and documented as unsigned; verify checksums and provenance before running them.',
        },
      },
    ],
  },
  architecture: {
    title: 'Architecture',
    category: 'Understand',
    summary: 'One durable engine serves the sandboxed desktop, CLI, and MCP interfaces.',
    sections: [
      {
        id: 'processes',
        title: 'Process boundaries',
        table: {
          headers: ['Process', 'Authority', 'Boundary'],
          rows: [
            ['Renderer', 'Display and user input', 'Sandboxed; no Node.js'],
            ['Electron main', 'Windows, protocol, credential bridge', 'Validated narrow IPC'],
            ['UtilityProcess', 'QAgent engine and SQLite', 'No renderer globals'],
            ['Target browser', 'Web application interaction', 'Separate Chrome/Chromium process'],
          ],
        },
      },
      {
        id: 'state',
        title: 'Durable state machine',
        code: 'preflight -> discover -> test -> triage -> patch -> verify\n          -> publish -> wait_checks -> merge -> postverify\n          -> learn -> complete',
        paragraphs: [
          'Failed, cancelled, and policy-blocked are explicit terminal outcomes. Ordered events and leases make restarts resumable and prevent concurrent mutation runs for one project.',
        ],
      },
      {
        id: 'data',
        title: 'Local persistence',
        bullets: [
          'SQLite in WAL mode stores projects, trust, tests, runs, events, diagnoses, patches, verification, provider calls, integrations, knowledge, and leases.',
          'Checksummed files beneath Electron userData store logs, diffs, screenshots, DOM evidence, and exports.',
          'Every event carries a schema version, UUID, run ID, monotonic sequence, timestamp, provenance, and artifact references.',
        ],
      },
      {
        id: 'interfaces',
        title: 'Shared public interfaces',
        code: 'const handle = await engine.startRun(request);\nfor await (const event of handle.events) {\n  // RunEvent is shared by desktop, CLI, and MCP.\n}\nconst result = await handle.result;',
      },
    ],
  },
  providers: {
    title: 'Provider matrix',
    category: 'Understand',
    summary: 'Know what is built in, what requires configuration, and what v0.2 certifies.',
    sections: [
      {
        id: 'models',
        title: 'Models',
        table: {
          headers: ['Adapter', 'Local-only', 'Structured output', 'Status'],
          rows: [
            ['OpenAI', 'No', 'Responses JSON Schema', 'Built in'],
            ['Anthropic', 'No', 'Validated JSON', 'Built in'],
            ['Google Gemini', 'No', 'Response JSON Schema', 'Built in'],
            ['OpenAI-compatible / Ollama', 'Can be', 'Validated JSON', 'Built in'],
          ],
        },
      },
      {
        id: 'runtime',
        title: 'Runtime services',
        table: {
          headers: ['Service', 'Default', 'Purpose', 'Certification'],
          rows: [
            ['SQLite', 'Required local', 'Durable state and provenance', 'End-to-end'],
            ['Chrome / Chromium', 'Required local', 'Browser execution and evidence', 'End-to-end'],
            ['GitHub', 'Optional', 'PR, checks, merge', 'Certified publisher'],
            ['Browserbase', 'Optional', 'Remote browser', 'Adapter available'],
            ['Weave', 'Optional opt-in', 'Redacted traces', 'Adapter available'],
            ['Redis', 'Migration only', 'Legacy repair import', 'Importer available'],
            [
              'Vercel / Daytona',
              'Optional',
              'External deployment or workspace',
              'Not certified in v0.2',
            ],
          ],
        },
      },
      {
        id: 'health',
        title: 'Health labels',
        bullets: [
          'Unconfigured: no credential or endpoint is present.',
          'Configured: required settings are present but no live test has completed.',
          'Healthy: a bounded connection test succeeded recently.',
          'End-to-end verified: a scheduled credential-backed workflow completed.',
        ],
        callout: {
          tone: 'info',
          text: 'A missing or failed provider is never converted to a zero metric, simulated result, or silent local fallback.',
        },
      },
    ],
  },
  'data-policy': {
    title: 'Telemetry and data policy',
    category: 'Understand',
    summary: 'Local operation is complete; remote tracing is disclosed, redacted, and optional.',
    sections: [
      {
        id: 'local',
        title: 'What stays local',
        bullets: [
          'Repository source and uncommitted checkout state',
          'Raw screenshots, DOM snapshots, logs, and patch artifacts',
          'Model and GitHub credentials',
          'SQLite run history and imported legacy knowledge',
        ],
      },
      {
        id: 'weave',
        title: 'Weave tracing',
        paragraphs: [
          'Tracing activates only after credentials are connected and the user accepts the disclosure. QAgent redacts tokens, authorization headers, environment values, and secret-like text before supported operation post-processing sends a trace. Weave failure never blocks a run.',
        ],
        bullets: [
          'Disabled: no trace work is attempted.',
          'Local: a trace exists only in local run events.',
          'Queued: redacted delivery is pending.',
          'Synced: Weave acknowledged delivery.',
          'Failed: delivery failed and local execution continued.',
        ],
      },
      {
        id: 'artifacts',
        title: 'Artifact uploads',
        callout: {
          tone: 'warning',
          text: 'Source files, screenshots, and raw artifacts are excluded from Weave unless the user enables the separate artifact-upload option.',
        },
      },
      {
        id: 'retention',
        title: 'Retention and export',
        paragraphs: [
          'Retention removes expired artifact files and their addressable metadata together. Exports verify SHA-256 integrity before copying data to the requested destination.',
        ],
      },
    ],
  },
  'threat-model': {
    title: 'Threat model',
    category: 'Understand',
    summary:
      'QAgent treats repositories, web pages, model output, and provider responses as untrusted input.',
    sections: [
      {
        id: 'assets',
        title: 'Protected assets',
        bullets: [
          'The developer active checkout and Git history',
          'Provider credentials and environment values',
          'Files outside a registered trusted project',
          'Publication permissions and protected branches',
          'Integrity of run events and evidence',
        ],
      },
      {
        id: 'controls',
        title: 'Primary controls',
        bullets: [
          'Repository commands require explicit canonical-path trust.',
          'All mutations occur in a new Git worktree under QAgent userData.',
          'Symlinks are resolved and command working directories are contained.',
          'Patch paths exclude .git, secret-like paths, traversal, and absolute paths.',
          'Renderer sandbox, context isolation, CSP, blocked navigation, and validated IPC reduce desktop attack surface.',
          'High-risk changes may open a PR but never auto-merge.',
        ],
      },
      {
        id: 'limits',
        title: 'Known limits',
        paragraphs: [
          'A trusted repository command can execute arbitrary code with the current user account. QAgent is not a container sandbox. Model-generated patches can be wrong even when tests pass, and repository policy remains the final authority for publication.',
        ],
        callout: {
          tone: 'warning',
          text: 'Trust only repositories you would run manually. Review the captured diff and executed verification before expanding autonomy.',
        },
      },
    ],
  },
  adapters: {
    title: 'Adapter guide',
    category: 'Extend',
    summary: 'Add providers at typed boundaries without creating a second domain model.',
    sections: [
      {
        id: 'principles',
        title: 'Adapter principles',
        bullets: [
          'Consume and return @qagent/contracts types.',
          'Validate external responses at the boundary.',
          'Record provider calls with source, timestamp, status, and unavailable values as null.',
          'Never substitute deterministic doubles outside tests.',
          'Keep credentials out of events, errors, and artifacts.',
        ],
      },
      {
        id: 'model',
        title: 'Model adapters',
        code: 'interface ModelProvider {\n  readonly provider: string;\n  readonly model: string;\n  complete<T>(request: ModelRequest<T>): Promise<ModelCompletion<T>>;\n}',
        paragraphs: [
          'The completion value must pass the supplied Zod schema. A malformed response is a visible provider failure.',
        ],
      },
      {
        id: 'publishing',
        title: 'Publishing adapters',
        paragraphs: [
          'GitHub is the only certified v0.2 publishing adapter. Other repository hosts should first produce a verified local branch and must implement permissions, branch policy, checks, merge queues, conflict handling, and post-merge evidence before certification.',
        ],
      },
      {
        id: 'contribute',
        title: 'Contribution checklist',
        code: 'pnpm format:check\npnpm lint\npnpm typecheck\npnpm test:coverage\npnpm build',
      },
    ],
  },
  migration: {
    title: 'Migrate from v0.1',
    category: 'Extend',
    summary:
      'v0.2 is intentionally breaking and does not preserve operational Next.js API compatibility.',
    sections: [
      {
        id: 'removed',
        title: 'Removed surfaces',
        bullets: [
          'Hosted multi-user dashboard and operational Next routes',
          'Expo mobile client and its incompatible authentication path',
          'Marimo analytics, Remotion demo media, and hackathon simulations',
          'Process-local run state and duplicated API/domain types',
          'Redis as a runtime requirement',
        ],
      },
      {
        id: 'config',
        title: 'Create project configuration',
        code: 'qagent init /path/to/repository\nqagent project add /path/to/repository --trust\nqagent doctor',
      },
      {
        id: 'redis',
        title: 'Import legacy repair knowledge',
        code: 'qagent migrate redis --url redis://127.0.0.1:6379',
        paragraphs: [
          'The importer copies fix knowledge only, marks it with legacy-redis provenance, and never imports credentials. Keep a v0.1 backup until the reported import count is verified.',
        ],
      },
      {
        id: 'history',
        title: 'Historical release',
        paragraphs: [
          'The v0.1.0 tag and Git history remain available. Runtime compatibility, API compatibility, and old deployment behavior do not.',
        ],
      },
    ],
  },
  governance: {
    title: 'Governance',
    category: 'Extend',
    summary: 'QAgent uses an open, reviewable process for code, security, adapters, and releases.',
    sections: [
      {
        id: 'license',
        title: 'License and contributions',
        paragraphs: [
          'QAgent is AGPL-3.0. Contributions are accepted through GitHub pull requests under the same license, with Developer Certificate of Origin sign-off.',
        ],
      },
      {
        id: 'decisions',
        title: 'Decision process',
        bullets: [
          'Small fixes use normal pull-request review.',
          'Contract, storage, security, and publication changes require a written architecture decision record.',
          'Certified adapter status requires repeatable end-to-end evidence.',
          'Maintainers publish release criteria and unresolved known limitations.',
        ],
      },
      {
        id: 'conduct',
        title: 'Community standards',
        paragraphs: [
          'Participation follows the repository Code of Conduct. Security reports use the private process in SECURITY.md rather than public issues.',
        ],
      },
    ],
  },
  roadmap: {
    title: 'Roadmap',
    category: 'Extend',
    summary: 'The roadmap separates shipped behavior from planned work.',
    sections: [
      {
        id: 'beta',
        title: 'v0.2 beta',
        bullets: [
          'Local SQLite engine with resumable runs',
          'Electron desktop, CLI, and MCP sharing one contract',
          'Local Chrome and managed Chromium path',
          'GitHub publication policy and high-risk merge blocks',
          'Static open-source documentation and cross-platform packages',
        ],
      },
      {
        id: 'next',
        title: 'After beta evidence',
        bullets: [
          'Certify additional Git hosting providers',
          'Expand deterministic browser assertions',
          'Harden managed-browser checksum metadata and mirrors',
          'Add signed stable update channels',
          'Publish a stable adapter conformance kit',
        ],
      },
      {
        id: 'not-planned',
        title: 'Not a v0.2 goal',
        paragraphs: [
          'There is no hosted multi-user dashboard, benchmark corpus, or mandatory QAgent cloud. Local usefulness remains a release requirement.',
        ],
      },
    ],
  },
  troubleshooting: {
    title: 'Troubleshooting',
    category: 'Extend',
    summary:
      'Diagnose browser, model, Git, keyring, database, and publication failures without losing provenance.',
    sections: [
      {
        id: 'doctor',
        title: 'Start with Doctor',
        code: 'qagent --json doctor',
        paragraphs: [
          'Attach the JSON output when reporting a defect. It distinguishes missing, configured, healthy, and unavailable components.',
        ],
      },
      {
        id: 'browser',
        title: 'No browser found',
        bullets: [
          'Set browser.executablePath in .qagent.yml to a Chrome-compatible executable.',
          'Set QAGENT_BROWSER_PATH for the current session.',
          'Use the desktop managed-browser installer and verify the reported checksum/source.',
        ],
      },
      {
        id: 'model',
        title: 'Model connection fails',
        paragraphs: [
          'Confirm the selected provider, model identifier, endpoint, and credential. QAgent deliberately does not fall back to another provider or a fake result.',
        ],
      },
      {
        id: 'keyring',
        title: 'Linux basic_text keyring',
        callout: {
          tone: 'warning',
          text: 'When safeStorage reports the unencrypted basic_text backend, persistent credentials are disabled. Use environment or session credentials after configuring a supported desktop keyring.',
        },
      },
      {
        id: 'publication',
        title: 'Publication is policy-blocked',
        bullets: [
          'Clean the original checkout before a new publication run.',
          'Review high-risk files; they require human merge.',
          'Satisfy required reviews, checks, merge queue, and repository permissions.',
          'After one rebase conflict, resolve it manually and launch a new run.',
        ],
      },
      {
        id: 'recovery',
        title: 'Crash and restart recovery',
        paragraphs: [
          'Restart QAgent. Runs recorded as running are discovered from SQLite, leases are reacquired after expiry, and the persisted worktree is validated before resumption. Do not delete the worktree while a run is recoverable.',
        ],
      },
    ],
  },
};
