import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { execa } from 'execa';
import parseDiff from 'parse-diff';
import { assertPathContained, isSafeRelativePath, isSensitivePath } from './paths.js';

export interface RepositoryStatus {
  root: string;
  branch: string;
  headSha: string;
  dirty: boolean;
  origin: string | null;
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

export interface PatchInspection {
  files: string[];
  highRisk: boolean;
}

const HIGH_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /(^|\/)auth([/.]|$)/i,
  /(^|\/)migrations?\//i,
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/,
  /(^|\/)\.qagent\.ya?ml$/,
  /(^|\/)(security|permissions|policy)([/.]|$)/i,
];

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const result = await execa('git', args, { cwd, input, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export function inspectPatch(patch: string): PatchInspection {
  const files = parseDiff(patch).map((file) => {
    const candidate = file.to === '/dev/null' ? file.from : file.to;
    if (!candidate) throw new Error('Patch contains a file without a path');
    const normalized = candidate.replace(/^[ab]\//, '').replaceAll('\\', '/');
    if (!normalized || !isSafeRelativePath(normalized) || isSensitivePath(normalized)) {
      throw new Error(`Patch contains a forbidden path: ${candidate}`);
    }
    return normalized;
  });
  if (files.length === 0) throw new Error('Provider returned an empty patch');
  return {
    files: [...new Set(files)],
    highRisk: files.some((file) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(file))),
  };
}

export class GitRepository {
  async inspect(projectPath: string): Promise<RepositoryStatus> {
    const root = await realpath(await git(projectPath, ['rev-parse', '--show-toplevel']));
    const [branch, headSha, status, origin] = await Promise.all([
      git(root, ['branch', '--show-current']),
      git(root, ['rev-parse', 'HEAD']),
      git(root, ['status', '--porcelain=v1']),
      git(root, ['remote', 'get-url', 'origin']).catch(() => ''),
    ]);
    return { root, branch, headSha, dirty: status.length > 0, origin: origin || null };
  }

  async createWorktree(
    repository: RepositoryStatus,
    worktreesRoot: string,
    runId: string,
    slug: string
  ): Promise<Worktree> {
    const root = resolve(worktreesRoot);
    await mkdir(root, { recursive: true });
    const path = assertPathContained(root, runId);
    const branch = `qagent/${runId.slice(0, 8)}-${slugify(slug)}`;
    await git(repository.root, ['worktree', 'add', '-b', branch, path, repository.headSha]);
    return { path, branch, baseSha: repository.headSha };
  }

  async restoreWorktree(path: string, branch: string, baseSha: string): Promise<Worktree> {
    await realpath(path);
    const actualBranch = await git(path, ['branch', '--show-current']);
    if (actualBranch !== branch) throw new Error('Persisted worktree branch no longer matches');
    return { path, branch, baseSha };
  }

  async removeWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
    await git(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true });
      await git(repositoryRoot, ['worktree', 'prune']);
    });
  }

  async applyPatch(worktree: Worktree, patch: string, maxBytes: number): Promise<PatchInspection> {
    if (Buffer.byteLength(patch) > maxBytes)
      throw new Error('Patch exceeds the configured size limit');
    const inspection = inspectPatch(patch);
    await git(worktree.path, ['apply', '--check', '--whitespace=error-all', '-'], patch);
    await git(worktree.path, ['apply', '--whitespace=fix', '-'], patch);
    return inspection;
  }

  async commit(worktree: Worktree, files: string[], message: string): Promise<string> {
    for (const file of files) assertPathContained(worktree.path, file);
    await git(worktree.path, ['add', '--', ...files]);
    await git(worktree.path, [
      '-c',
      'user.name=QAgent',
      '-c',
      'user.email=qagent@localhost',
      'commit',
      '-m',
      message,
    ]);
    return git(worktree.path, ['rev-parse', 'HEAD']);
  }

  async push(worktree: Worktree): Promise<void> {
    await git(worktree.path, ['push', '--set-upstream', 'origin', worktree.branch]);
  }

  async rebaseOnce(worktree: Worktree, baseBranch: string): Promise<boolean> {
    const before = await git(worktree.path, ['rev-parse', 'HEAD']);
    await git(worktree.path, ['fetch', 'origin', baseBranch]);
    try {
      await git(worktree.path, ['rebase', `origin/${baseBranch}`]);
    } catch (error) {
      await git(worktree.path, ['rebase', '--abort']).catch(() => undefined);
      throw error;
    }
    const after = await git(worktree.path, ['rev-parse', 'HEAD']);
    return before !== after;
  }

  async checkoutMergedCommit(
    worktree: Worktree,
    baseBranch: string,
    mergeCommitSha: string
  ): Promise<void> {
    if (!/^[a-f0-9]{40}$/i.test(mergeCommitSha)) {
      throw new Error('GitHub returned an invalid merge commit SHA');
    }
    await git(worktree.path, ['fetch', 'origin', baseBranch]);
    await git(worktree.path, ['cat-file', '-e', `${mergeCommitSha}^{commit}`]);
    await git(worktree.path, ['checkout', '--detach', mergeCommitSha]);
  }

  async diff(worktree: Worktree): Promise<string> {
    return git(worktree.path, ['diff', '--no-ext-diff', '--binary', worktree.baseSha]);
  }

  async gatherContext(worktreePath: string, failureOutput: string): Promise<string> {
    const rawFiles = await git(worktreePath, ['ls-files', '-z']);
    const files = rawFiles.split('\0').filter(Boolean);
    const mentioned = files.filter((file) => failureOutput.includes(file));
    const manifests = files.filter((file) =>
      /(^|\/)(package\.json|pyproject\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle|.*\.csproj)$/.test(
        file
      )
    );
    const candidates = [...new Set([...mentioned, ...manifests])]
      .filter((file) => !isSensitivePath(file))
      .slice(0, 12);
    let budget = 60_000;
    const sections: string[] = [];
    for (const file of candidates) {
      const path = assertPathContained(worktreePath, file);
      const content = await readFile(path, 'utf8').catch(() => '');
      if (!content || Buffer.byteLength(content) > budget) continue;
      budget -= Buffer.byteLength(content);
      sections.push(`--- ${file} ---\n${content}`);
    }
    return sections.join('\n\n');
  }

  async changedFiles(worktree: Worktree): Promise<string[]> {
    const output = await git(worktree.path, ['diff', '--name-only', worktree.baseSha]);
    return output.split('\n').filter(Boolean);
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || basename(value) || 'repair';
}

export function relativeWorktreePath(root: string, path: string): string {
  return relative(resolve(root), resolve(path));
}
