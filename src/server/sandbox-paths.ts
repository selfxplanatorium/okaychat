/**
 * Which sandbox files are results. Mirrors `visible()`/`snapshot()` in sandbox/runner.py, so outputs from an
 * older runner image, and those stored before the rule existed, are filtered the same way.
 * Installed packages and caches are not results: anything inside a dot directory (.local, .venv, .npm), a
 * dependency directory, or a virtualenv (marked by its pyvenv.cfg). Dotfiles themselves are kept.
 */
const DEPENDENCY_DIRS = new Set(["node_modules", "__pycache__", "site-packages", "dist-packages", "venv"]);

export function resultPaths(paths: readonly string[]): Set<string> {
  const envs = paths.filter((p) => p.endsWith("/pyvenv.cfg")).map((p) => p.slice(0, -"pyvenv.cfg".length));
  return new Set(
    paths.filter((p) => {
      const dirs = p.split("/").slice(0, -1);
      return !dirs.some((d) => d.startsWith(".") || DEPENDENCY_DIRS.has(d)) && !envs.some((env) => p.startsWith(env));
    }),
  );
}
