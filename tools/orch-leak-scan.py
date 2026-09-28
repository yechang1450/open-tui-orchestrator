# -*- coding: utf-8 -*-
"""orch-leak-scan.py — open-tui-orchestrator 公开前泄露扫描（仓外工具，随仓归档在 tools/）。

用途：把本仓转为 public 之前 / 每次发版前，扫工作树文本、git 历史、以及已发布的
npm 包内容，找凭据形态、本地身份残留、绝对路径、邮箱、敏感文件名。只读取，不改仓。

用法:
  python tools/orch-leak-scan.py                       # 扫本仓：工作树 + git 历史
  python tools/orch-leak-scan.py --no-history          # 只扫工作树
  python tools/orch-leak-scan.py <dir>                 # 扫别的目录（不含历史则需 --no-history）
  python tools/orch-leak-scan.py --identity <name>     # 显式指定要查的本地标识（默认取 %USERNAME%/$USER）
  python tools/orch-leak-scan.py --allow '<handle>'    # 额外豁免正则（可多次）

判据（公开前必须满足）:
  - 凭据形态 == 0 —— 硬门槛，出现任何一条即不可公开
  - 本地身份 == 0（工作树）
  - 工作树里的绝对路径 == 0；文档/示例中的示例路径需逐个判定豁免
  git 历史残留与提交身份只报告、不自动判红（改写历史是独立决策，且不可逆）。
未知即失败：扫描器自身抛错/目标不是目录 ⇒ 非 0 退出。
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# 凭据与身份形态（与仓内无关的通用规则；identity 在运行时按参数构建）
STATIC_PATTERNS = {
    "凭据形态": re.compile(
        r"(sk-[A-Za-z0-9_\-]{16,}"
        r"|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}"
        r"|github_pat_[A-Za-z0-9_]{20,}"
        r"|glpat-[A-Za-z0-9_\-]{16,}"
        r"|AIza[0-9A-Za-z_\-]{30,}"
        r"|xox[baprs]-[A-Za-z0-9\-]{10,}"
        r"|AKIA[0-9A-Z]{16}"
        r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
        r"|Bearer\s+[A-Za-z0-9_\-\.]{24,})"
    ),
    "Windows家目录": re.compile(r"[Cc]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9_.\-]+"),
    "MSYS家目录": re.compile(r"(?:/c/Users/|/mnt/c/Users/)[A-Za-z0-9_.\-]+"),
    "绝对路径": re.compile(r"[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.\-]+[\\/][A-Za-z0-9_.\-]+"),
    "邮箱": re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"),
}

SENSITIVE_FILE = re.compile(
    r"(\.env$|\.env\.|secret|credential|\.pem$|\.key$|\.p12$|token|password|\.npmrc|id_rsa)",
    re.I,
)

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "temp", "logs", ".pytest_cache"}


def default_identity() -> str:
    for key in ("USERNAME", "USER", "LOGNAME"):
        value = os.environ.get(key)
        if value:
            return value
    return ""


def build_patterns(identity: str, allow: list[str]) -> dict[str, re.Pattern]:
    patterns = dict(STATIC_PATTERNS)
    if identity:
        # 后缀边界：标识后紧跟 [A-Za-z0-9_-] 不算命中（自己的公开句柄不误报成隐私残留）
        patterns["本地身份"] = re.compile(re.escape(identity) + r"(?![A-Za-z0-9_\-])")
    if allow:
        patterns["额外豁免（应尽量为 0）"] = re.compile("|".join(allow))
    return patterns


def mask(text: str, limit: int = 72) -> str:
    text = text.strip()
    text = re.sub(
        r"(sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[a-z]*-|AKIA)[A-Za-z0-9_\-]+",
        r"\1[REDACTED]",
        text,
    )
    text = re.sub(r"(Bearer\s+)[A-Za-z0-9_\-\.]{8,}", r"\1[REDACTED]", text)
    return text[:limit]


def is_text(path: Path) -> bool:
    try:
        return b"\0" not in path.open("rb").read(4096)
    except OSError:
        return False


def scan_file(where: str, path: Path, patterns: dict, hits: list) -> None:
    if not is_text(path):
        return
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    for number, line in enumerate(lines, 1):
        for name, rx in patterns.items():
            for match in rx.finditer(line):
                hits.append((name, where, number, mask(match.group(0))))


def walk_tree(root: Path, patterns: dict, hits: list, sensitive: list) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for filename in filenames:
            path = Path(dirpath) / filename
            rel = str(path.relative_to(root)).replace("\\", "/")
            if SENSITIVE_FILE.search(filename):
                sensitive.append(rel)
            scan_file(rel, path, patterns, hits)


def scan_git_history(root: Path, patterns: dict, hits: list) -> None:
    """扫历史 diff 的新增行；附 commit 便于定位（历史残留需改写历史才能清除）。"""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "log", "--all", "-p", "--no-color", "--unified=0",
             "--pretty=format:@@COMMIT %h %ad %s", "--date=short"],
            capture_output=True, text=True, errors="replace", encoding="utf-8",
        ).stdout
    except OSError as exc:
        print(f"  [git 历史] 跳过: {exc}")
        return
    commit = "?"
    for line in out.splitlines():
        if line.startswith("@@COMMIT "):
            commit = line[len("@@COMMIT "):]
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        for name, rx in patterns.items():
            for match in rx.finditer(line):
                hits.append((name, f"history@{commit}", 0, mask(match.group(0))))


def git_authors(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "log", "--all", "--format=%an <%ae>"],
            capture_output=True, text=True, errors="replace", encoding="utf-8",
        ).stdout
    except OSError:
        return []
    return sorted({line.strip() for line in out.splitlines() if line.strip()})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="公开前泄露扫描（只读）")
    parser.add_argument("root", nargs="?", default=None,
                        help="要扫描的目录（默认：本脚本所在仓库根）")
    parser.add_argument("--identity", default=None,
                        help="要查的本地标识，默认取 %%USERNAME%%/$USER（空则不查这一项）")
    parser.add_argument("--allow", action="append", default=[], metavar="REGEX",
                        help="豁免正则，可多次；用于你自己的公开句柄（尽量保持 0 命中）")
    parser.add_argument("--no-history", dest="history", action="store_false", default=True,
                        help="只扫工作树，不扫 git 历史")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[1]
    if not root.is_dir():
        print(f"不是目录: {root}")
        return 2

    identity = default_identity() if args.identity is None else args.identity
    patterns = build_patterns(identity, args.allow)

    hits: list = []
    sensitive: list = []
    walk_tree(root, patterns, hits, sensitive)
    if args.history and (root / ".git").is_dir():
        scan_git_history(root, patterns, hits)

    print(f"== 扫描目标: {root}")
    print(f"== 本地标识: {identity or '(未指定，跳过)'}")
    print(f"== 命中总数: {len(hits)}\n")

    by_category: dict[str, list] = {}
    for name, where, number, frag in hits:
        by_category.setdefault(name, []).append((where, number, frag))

    for category, items in sorted(by_category.items(), key=lambda kv: -len(kv[1])):
        print(f"### {category}  ({len(items)})")
        seen = set()
        for where, number, frag in items:
            key = (where, frag)
            if key in seen:
                continue
            seen.add(key)
            print(f"  {where}:{number}  ->  {frag}" if number else f"  {where}  ->  {frag}")
        print()

    if sensitive:
        print(f"### 敏感文件名 ({len(sensitive)})")
        for name in sorted(set(sensitive)):
            print(f"  {name}")
        print()

    authors = git_authors(root)
    if authors:
        print("### git 提交身份（公开后会暴露）")
        for author in authors:
            print(f"  {author}")
        print()

    credentials = len(by_category.get("凭据形态", []))
    identity_items = by_category.get("本地身份", [])
    worktree_identity = [item for item in identity_items if not item[0].startswith("history@")]
    history_identity = len(identity_items) - len(worktree_identity)
    print("== 判据: 凭据形态 == %d（必须为 0 才可公开）；工作树本地身份 == %d；"
          "git 历史里的本地身份 == %d（需改写历史才可清除，独立决策）；"
          "绝对路径与邮箱仅报数，逐个判定。"
          % (credentials, len(worktree_identity), history_identity))
    return 0


if __name__ == "__main__":
    sys.exit(main())
