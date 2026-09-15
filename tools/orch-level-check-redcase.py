# -*- coding: utf-8 -*-
"""orch-level-check.py 的 L4 红例复跑：判据必须能红，也必须不乱红。

做法：把 L4 依赖的 5 个文件复制成最小树，先跑一遍（必须 PASS），再分别篡改三处（README 数字、
封印版本、封印计数）各跑一遍（必须 FAIL）。不碰真仓库一个字节。

用法: python tools/orch-level-check-redcase.py
"""
from __future__ import annotations
import importlib.util
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parent / "orch-level-check.py"
SOURCE = Path(os.path.expanduser("~")) / ".tools" / "open-tui-orchestrator"
FILES = ["scripts/core/contracts.mjs", "release.json", "package.json", "README.md", "README-zh.md", "docs/release-policy.md"]


def load_gate(repo: Path):
    spec = importlib.util.spec_from_file_location("orch_gate_under_test", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.REPO = repo  # 指向最小树
    return module


def build_tree(root: Path) -> Path:
    repo = root / "open-tui-orchestrator"
    for rel in FILES:
        dst = repo / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / rel, dst)
    return repo


class MutationNotApplied(RuntimeError):
    """红例的篡改没有真的落到文件上（文档措辞一变、字面替换就静默失效）。"""


def mutate(path: Path, pattern: str, repl: str) -> None:
    before = path.read_text(encoding="utf-8")
    after, n = re.subn(pattern, repl, before, count=1)
    if n != 1 or after == before:
        raise MutationNotApplied(f"{path.name}: /{pattern}/ 没匹配上或改不动 ⇒ 红例失效")
    path.write_text(after, encoding="utf-8")


def run_case(name: str, repo: Path, mutate=None) -> int:
    if mutate:
        mutate(repo)
    module = load_gate(repo)
    print(f"--- 红例: {name} ---")
    rc = module.consistency(Path("D:/temp/orch-level/__nonexistent__.log"))
    print(f"    {'PASS' if rc == 0 else 'FAIL'} (rc={rc})")
    return rc


def main() -> int:
    failures = []
    # (标题, 备份目录名, 篡改文件, 匹配式, 替换式, 未抓到时记的账)
    cases = [
        ("README 回归总数被改成 999/999（必须 FAIL）", "bad-count", "README.md",
         r"(with )\d+/\d+( offline tests passing)", r"\g<1>999/999\g<2>", "回归总数篡改未被抓到"),
        ("README-zh 核心版本被改成 9.9.9（必须 FAIL）", "bad-core", "README-zh.md",
         r"当前通用核心为 [\d.]+", "当前通用核心为 9.9.9", "核心版本篡改未被抓到"),
        ("release-policy 封印计数被改成 44/62（必须 FAIL）", "bad-seal", "docs/release-policy.md",
         r"\d+ 个核心文件", "44 个核心文件", "封印计数篡改未被抓到"),
    ]
    with tempfile.TemporaryDirectory(prefix="orch-l4-redcase-") as tmp:
        root = Path(tmp)

        repo = build_tree(root / "green")
        if run_case("未篡改（必须 PASS）", repo) != 0:
            failures.append("未篡改的最小树居然判红")

        for title, sub, rel, pattern, repl, miss in cases:
            repo = build_tree(root / sub)

            def tamper(r, rel=rel, pattern=pattern, repl=repl):
                mutate(r / rel, pattern, repl)

            try:
                rc = run_case(title, repo, tamper)
            except MutationNotApplied as error:
                # 篡改没落地就没证明任何东西——按失败记账，不许当成「抓到了」。
                print(f"    MUTATION_NOT_APPLIED: {error}")
                failures.append(f"{miss}（红例自身已失效：{error}）")
                continue
            if rc == 0:
                failures.append(miss)

    if failures:
        print("L4 红例复跑: FAIL")
        for f in failures:
            print("  - " + f)
        return 1
    print("L4 红例复跑: 4/4 符合预期（1 绿 + 3 红）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
