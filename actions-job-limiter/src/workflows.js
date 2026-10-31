/**
 * Deciding which runs the app cares about.
 *
 * GitHub writes workflow paths in a few shapes:
 *   run.path                    ".github/workflows/build.yml@main" or "octo-org/octo-repo/.github/workflows/build.yml@main"
 *   referenced_workflows[].path "octo-org/central/.github/workflows/build.yml@v2" (or @<sha>)
 * Everything is normalized to "owner/repo/.github/workflows/file.yml" before matching.
 */

const WORKFLOW_FILE = /^(.*?\.ya?ml)(?:@(.*))?$/i;
const TARGET_SHAPE = /^[^/@\s]+\/[^/@\s]+\/\.github\/workflows\/[^@\s]+$/i;

/** Splits "path@ref" into its parts. Paths that aren't workflow files (like Dependabot's) are kept whole. */
export function splitWorkflowPath(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const trimmed = path.trim();
  const match = trimmed.match(WORKFLOW_FILE);
  return match ? { file: match[1], ref: match[2] || null } : { file: trimmed, ref: null };
}

/** Adds "owner/repo/" to a path that is relative to the repository. */
export function qualify(file, repo) {
  return repo && file.startsWith('.github/') ? `${repo}/${file}` : file;
}

/**
 * Turns TARGET_WORKFLOWS entries into matchers. An entry is
 * "owner/repo/.github/workflows/file.yml", where * matches any characters except "/".
 */
export function compileTargets(patterns) {
  return patterns.map((pattern) => {
    if (!TARGET_SHAPE.test(pattern)) {
      throw new Error(
        `TARGET_WORKFLOWS entries look like owner/repo/.github/workflows/file.yml, without @ref (got "${pattern}")`,
      );
    }
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return { pattern, regex: new RegExp(`^${source}$`, 'i') };
  });
}

/**
 * Whether a run is one of the target workflows, or calls one. With no targets, every run matches.
 * Also reports which version of the target ran, for the log.
 */
export function matchTarget(run, repo, targets) {
  const own = splitWorkflowPath(run?.path);
  const ownPath = own ? qualify(own.file, repo) : null;
  const miss = { matches: false, ownPath, calledWorkflow: null, calledWorkflowSha: null };
  if (!targets.length) return { ...miss, matches: true };

  const hits = (file) => targets.some((target) => target.regex.test(file));
  if (ownPath && hits(ownPath)) {
    return {
      matches: true,
      ownPath,
      calledWorkflow: own.ref ? `${ownPath}@${own.ref}` : ownPath,
      calledWorkflowSha: run.head_sha ?? null,
    };
  }
  for (const called of run?.referenced_workflows ?? []) {
    const parts = splitWorkflowPath(called?.path);
    if (parts && hits(qualify(parts.file, repo))) {
      return { matches: true, ownPath, calledWorkflow: called.path, calledWorkflowSha: called.sha ?? null };
    }
  }
  return miss;
}
