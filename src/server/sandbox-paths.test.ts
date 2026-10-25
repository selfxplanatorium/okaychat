import assert from "node:assert/strict";
import { test } from "node:test";
import { resultPaths } from "./sandbox-paths.js";

test("resultPaths drops installed packages and caches, keeps results and dotfiles", () => {
  const paths = [
    "chart.png",
    "out/report.csv",
    ".gitignore",
    ".local/bin/uv",
    ".local/lib/python3.12/site-packages/uv/__init__.py",
    "lib/site-packages/x.py",
    "app/node_modules/react/index.js",
    "src/__pycache__/m.cpython-312.pyc",
    "env/pyvenv.cfg",
    "env/bin/python",
    "venv/bin/python",
  ];
  assert.deepEqual([...resultPaths(paths)], ["chart.png", "out/report.csv", ".gitignore"]);
});
