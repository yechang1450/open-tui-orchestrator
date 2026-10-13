# -*- coding: utf-8 -*-
"""orch-level-check.py — orch（open-tui-orchestrator）的 L1/L2 机判门禁（仓外工具，随仓归档在 tools/）。

注：仓内的一键门禁是 `node scripts/gate.mjs --all`（0.9.4 起，覆盖 L1/L2a/L2b/L3/L4）；
本脚本是更早的独立机判，保留用于「不启动 Node 的交叉复核」与 L4 红例复跑
（见同目录 orch-level-check-redcase.py）。它只读取仓内文件，不改仓。

用法:
  python tools/orch-level-check.py --log D:/temp/orch-level/L1-suite.log   # 判已跑过的套件日志
  python tools/orch-level-check.py --run                                   # 现跑套件（约 3 分钟）
  python tools/orch-level-check.py --doctor                                # 只跑 doctor
  python tools/orch-level-check.py --canary                                # L2b 反例必须能红
  python tools/orch-level-check.py --verify-missing                        # L3 未知 run 的干净诊断
  python tools/orch-level-check.py --consistency                           # L4 版本/封印/文档/套件互相对账

判据（每条带 命令 / 期望 / 实际）:
  L1：套件 pass>0 且 fail==0 且 skipped==0 且 exit==0
  L2a：doctor 的 hostError 为 null（codex 宿主可用）
  L2b：反例必须能红 —— 见 --canary（放临时坏用例，要求 fail==1 且退出码非 0，跑完删除）
  L3：未知 run 必须 fail-closed 且只回一行（含「Run not found」、无栈帧、退出码非 0）
  L4：CORE_VERSION / 封印 / 三处文档写死的版本与数字 / 套件总数互相对账；协调器目录无过期锁票
      （超龄票先按引擎同一语义回收，只对「回收后仍残留」的判红）
未知即失败：日志里缺 pass/fail/exit 任一项 ⇒ FAIL。
"""
from __future__ import annotations
import os
import re
import subprocess
import sys
import shutil
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # 2026-10-11: 自定位——本工具随仓归档（<repo>/tools/），检查的就是它所在的仓；旧写死 ~/.tools 布局已撤
def _resolve_node_bin() -> Path:
    """node 所在目录，运行时解析。

    写死 C:\\Program Files\\nodejs 会让 patrol 在任何 node 来自别处的机器上报 node-missing
    并整体转 RED（2026-10-08 重装后实测：新系统无系统 node，node 随 Hermes 自带，
    两条 patrol 判据因此失败）。优先级：ORCH_NODE_BIN -> PATH 上的 node -> 旧常量兜底
    （真的没有 node 时仍旧报 node-missing，保持 fail-closed）。
    """
    override = os.environ.get("ORCH_NODE_BIN", "").strip()
    if override:
        return Path(override)
    found = shutil.which("node")
    if found:
        return Path(found).parent
    return Path(r"C:\Program Files\nodejs")


NODE_BIN = _resolve_node_bin()  # 2026-10-08: 不再写死；说明见 _resolve_node_bin
# vendor 目录随仓归档；从 REPO 推导，避免写死用户名路径（公开前身份清理）
_CODEX_VENDOR = (REPO / "scripts" / "node_modules" / "@openai" / "codex-win32-x64"
                 / "vendor" / "x86_64-pc-windows-msvc" / "bin")
CODEX_BIN = str(_CODEX_VENDOR)
SUITE_CMD = (f"ORCH_AGENT=codex PATH='{NODE_BIN.as_posix()}:{_CODEX_VENDOR.as_posix()}:$PATH "
             f"node --test --test-concurrency=3 test/*.test.mjs")
DEFAULT_LOG = Path("D:/temp/orch-level/L1-suite.log")
LOG_PATH = DEFAULT_LOG
LOG_EXPLICIT = False
# 证据必须新鲜（档位表 §六.2）：超过这个分钟数的日志不得当「本轮实况」用。
LOG_FRESH_MINUTES = float(os.environ.get("ORCH_LOG_FRESH_MINUTES", "30"))


def _native(p: str) -> str:
    m = re.match(r"^/([a-zA-Z])/(.*)$", p)
    return f"{m.group(1).upper()}:/{m.group(2)}" if m else p


def parse_log(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    out = {"file": str(path)}
    for key in ("pass", "fail", "skipped", "cancelled", "todo"):
        m = re.search(rf"^ℹ {key} (\d+)$", text, re.M)
        out[key] = int(m.group(1)) if m else None
    m = re.search(r"^exit=(\d+)$", text, re.M)
    out["exit"] = int(m.group(1)) if m else None
    m = re.search(r"^repo=(\S+) HEAD=(\S+)", text, re.M)
    out["head"] = m.group(2) if m else None
    out["dirty"] = None
    m = re.search(r"树脏=(\S+)", text, re.M)
    if m:
        out["dirty"] = m.group(1)
    return out


def verdict(log: dict) -> int:
    missing = [k for k in ("pass", "fail", "skipped", "exit") if log.get(k) is None]
    print(f"  L1 判据: 命令 `{SUITE_CMD}`")
    print(f"    期望: pass>0 / fail==0 / skipped==0 / exit==0")
    if missing:
        print(f"    实际: 缺字段 {missing} ⇒ **FAIL（未知即失败）**")
        return 1
    print(f"    实际: pass={log['pass']} fail={log['fail']} skipped={log['skipped']} exit={log['exit']}"
          f"  HEAD={log.get('head')} 树脏={log.get('dirty')}")
    ok = log["pass"] > 0 and log["fail"] == 0 and log["skipped"] == 0 and log["exit"] == 0
    print(f"    → L1 {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def run_suite(out_log: Path) -> int:
    out_log.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["ORCH_AGENT"] = "codex"
    env["ORCH_SPAWN_MODE"] = "headless"  # 非交互自动化显式钉 headless：判据不得随本壳变色（零弹窗）
    env["PATH"] = str(NODE_BIN) + os.pathsep + CODEX_BIN + os.pathsep + env.get("PATH", "")
    node = str(NODE_BIN / "node.exe") if os.name == "nt" else "node"
    files = [str(p) for p in sorted(REPO.glob("test/*.test.mjs"))]
    head = subprocess.run(["git", "-C", str(REPO), "log", "-1", "--format=%h"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
    print(f"  跑套件: {len(files)} 个文件…")
    p = subprocess.run([node, "--test", "--test-concurrency=3", *files], capture_output=True, text=True, env=env, cwd=str(REPO))
    body = p.stdout + p.stderr
    out_log.write_text(f"repo={REPO} HEAD={head} 树脏={'0' if not dirty else '非0'}\n命令: {SUITE_CMD}\n--- 输出 ---\n{body}\nexit={p.returncode}\n", encoding="utf-8")
    print(f"  写出 {out_log}（exit={p.returncode}）")
    return p.returncode


def canary() -> int:
    tmp = REPO / "test" / "zzz-level-check-canary.test.mjs"
    node = str(NODE_BIN / "node.exe") if os.name == "nt" else "node"
    tmp.write_text("import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                   "test('canary', () => { assert.equal(1, 2); });\n", encoding="utf-8")
    try:
        p = subprocess.run([node, "--test", str(tmp)], capture_output=True, text=True, cwd=str(REPO))
        red = p.returncode != 0 and re.search(r"^ℹ fail 1$", p.stdout, re.M) is not None
        print(f"  L2b 反例: 期望 fail==1 且退出码≠0；实际 exit={p.returncode} → {'PASS（判据能红）' if red else 'FAIL'}")
        return 0 if red else 1
    finally:
        tmp.unlink(missing_ok=True)


def doctor() -> int:
    node = str(NODE_BIN / "node.exe") if os.name == "nt" else "node"
    env = dict(os.environ)
    env["ORCH_SPAWN_MODE"] = "headless"  # 非交互自动化显式钉 headless：判据不得随本壳变色（零弹窗）
    env["PATH"] = str(NODE_BIN) + os.pathsep + CODEX_BIN + os.pathsep + env.get("PATH", "")
    p = subprocess.run([node, "cli.mjs", "--agent", "codex", "--doctor"], capture_output=True, text=True, env=env, cwd=str(REPO))
    body = p.stdout + p.stderr
    m = re.search(r'"hostError"\s*:\s*(null|"[^"]*")', body)
    print('  L2a 判据: `node cli.mjs --agent codex --doctor`')
    print('    期望: hostError 为 null')
    print(f"    实际: hostError={m.group(1) if m else '未取到'} (exit={p.returncode})")
    ok = bool(m) and m.group(1) == "null"
    print(f"    → L2a {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def verify_missing() -> int:
    """缺 run 时必须 fail-closed 且话术干净：非 0 退出 + 输出无栈帧。

    当前是「已知欠账」：核心件改动要走发布流程（repair.mjs），所以这条判据在改到冻结件之前必然红。
    红 = 记在案，不是脚本坏了。"""
    node = str(NODE_BIN / "node.exe") if os.name == "nt" else "node"
    env = dict(os.environ)
    env["ORCH_SPAWN_MODE"] = "headless"  # 非交互自动化显式钉 headless：判据不得随本壳变色（零弹窗）
    env["PATH"] = str(NODE_BIN) + os.pathsep + CODEX_BIN + os.pathsep + env.get("PATH", "")
    p = subprocess.run([node, "cli.mjs", "--verify-run", "nosuch-run-entj"], capture_output=True, text=True, env=env, cwd=str(REPO))
    out = p.stdout + p.stderr
    frames = len(re.findall(r"at (?:Object|Module|\.\.\/|file://)", out)) + len(re.findall(r"node:fs", out))
    clean = "Run not found" in out
    print('  L3 判据: `node cli.mjs --verify-run <不存在的 run>`')
    print('    期望: 退出码非 0 且输出无栈帧、含「Run not found」')
    print(f"    实际: exit={p.returncode} 栈帧行={frames} 含 Run not found={clean}")
    ok = p.returncode != 0 and frames == 0 and clean
    print(f"    → {'PASS' if ok else 'FAIL**GAP**（在账：core 改动需走发布流程 repair.mjs，不许裸改冻结件）'}")
    if not ok:
        print('    翻转例（把缺口补上它必须判绿）：dev 仓改 scripts/core/runner.mjs 的 verifyRun 缺件分支 → 重跑本判据，期望 exit=0 且「Run not found」在输出里')
        print('    不做翻转的理由（2026-09-13 ENTJ 判）：一条纯话术改进不值得为它单独发一版冻结件（用户口径「先用简单方式、别因为小事先卡住」）——本条归入 **下一个真实 core 改动的随车项**，届时随那次发版一起翻转')
    return 0 if ok else 1


def consistency(log_path: Path = DEFAULT_LOG, log_explicit: bool = False) -> int:
    """L4：版本/封印/文档数字/套件总数互相对账，且协调器目录没有过期锁票残留。

    交叉口径：contracts.mjs 的 CORE_VERSION == release.json.coreVersion；README/README-zh/
    release-policy 里写死的核心版本、封印文件数与回归总数必须等于当下实况（过期数字按缺陷算）。"""
    import json as _json
    ok = True
    core = re.search(r"CORE_VERSION\s*=\s*'([^']+)'", (REPO / "scripts" / "core" / "contracts.mjs").read_text(encoding="utf-8")).group(1)
    seal = _json.loads((REPO / "release.json").read_text(encoding="utf-8"))
    files = len(seal.get("files", {}))
    runtime = len(seal.get("runtimeFiles", {}))
    print("  L4 判据: 版本/封印/文档口径互相对账")
    print(f"    实况: core={core} sealCore={seal.get('coreVersion')} files={files} runtime={runtime}")
    if seal.get("coreVersion") != core:
        print(f"    → 封印核心版本 {seal.get('coreVersion')} != contracts {core} ⇒ FAIL")
        ok = False

    # 每处口径行：正则 + 命中的组下标 (核心版本, 回归总数分子, 分母)——release-policy 的 43/62 是
    # 封印计数，不是回归总数，早年写法在这里把两组混过（2026-09-14 判据自身修）。
    # 版本号可能带 `-N` 后缀（现行核心是 `0.9.22-1`）：旧模式写死 `([\d.]+)` 时三处口径行
    # 全部"未找到"⇒ 在一个完全对账的仓上判 FAIL（2026-09-23 实测）。与 scripts/gate.mjs 的
    # `([\d.]+(?:-\d+)?)` 对齐，钉住两种版本写法。
    V = r"([\d.]+(?:-\d+)?)"
    sources = {
        "README.md": (r"core is " + V + r", with (\d+)/(\d+) offline tests passing", 0, 1, 2),
        "README-zh.md": (r"当前通用核心为 " + V + r"，离线回归为 (\d+)/(\d+) 通过", 0, 1, 2),
        "docs/release-policy.md": (r"当前源码封印记录通用核心 " + V + r"、(\d+) 个核心文件和 (\d+) 个运行时文件。最新离线回归为 (\d+)/(\d+) 通过", 0, 3, 4),
    }
    counts = set()
    for rel, (pattern, ci, pi, ti) in sources.items():
        m = re.search(pattern, (REPO / rel).read_text(encoding="utf-8"))
        if not m:
            print(f"    {rel}: 未找到口径行 ⇒ FAIL")
            ok = False
            continue
        g = m.groups()
        if g[ci] != core:
            print(f"    {rel} 核心版本 {g[ci]} != {core} ⇒ FAIL")
            ok = False
        counts.add(g[pi] + "/" + g[ti])
        if g[pi] != g[ti]:
            print(f"    {rel} 回归总数不是全绿 {g[pi]}/{g[ti]} ⇒ FAIL")
            ok = False
    if len(counts) > 1:
        print(f"    三处回归总数不一致 {sorted(counts)} ⇒ FAIL")
        ok = False
    if counts:
        print(f"    三处回归总数一致: {next(iter(counts))}")

    policy = re.search(sources["docs/release-policy.md"][0], (REPO / "docs" / "release-policy.md").read_text(encoding="utf-8"))
    if policy and (int(policy.group(2)), int(policy.group(3))) != (files, runtime):
        print(f"    文档封印计数 {policy.group(2)}/{policy.group(3)} != {files}/{runtime} ⇒ FAIL")
        ok = False

    if log_path.exists():
        age_min = (time.time() - log_path.stat().st_mtime) / 60.0
        if age_min > LOG_FRESH_MINUTES:
            note = f"STALE_LOG: {log_path} 是 {age_min:.0f} 分钟前的证据（新鲜阈值 {LOG_FRESH_MINUTES:.0f} 分钟）"
            if log_explicit:
                print(f"    {note} ⇒ FAIL（显式点名的证据必须新鲜：先 `--run` 生成再判，或用 `--run --consistency` 一次跑）")
                ok = False
            else:
                print(f"    {note} —— 与文档总数的交叉核对跳过（不拿旧证据冒充本轮；本轮证据用 `--run`，或走仓内 `node scripts/gate.mjs --all`）")
        else:
            logged = parse_log(log_path)
            if logged.get("pass") is not None:
                claimed = next(iter(counts), None)
                if claimed and claimed != f"{logged['pass']}/{logged['pass']}":
                    print(f"    文档回归总数 {claimed} != 套件实况 {logged['pass']} ⇒ FAIL")
                    ok = False
                else:
                    print(f"    文档回归总数与套件实况一致: {logged['pass']}")
    else:
        print(f"    （没有本轮套件日志 `{log_path}`，与文档总数的交叉核对跳过）")

    coordinator = Path("D:/temp/orchestrator/coordinator")
    stale = []
    if coordinator.is_dir():
        # 先按引擎同一套语义回收一次：判据只对「回收后仍残留」判红，
        # 免得把「等着下次入口回收」的票当成泄漏（2026-09-15 修：此前会假红）。
        # 2026-09-16 再修两处（当日实测假红）：
        # ① 回收调用固定从判据自己的常驻仓导入 leases.mjs，不再从被检查树 REPO 导入——
        #    红例复跑用最小树（只含文档/数据文件，没有 scripts/core/leases.mjs），
        #    import 必失败、调用结果被丢弃 ⇒ 回收静默 no-op，任何超龄票都被当残留判红。
        # ② 「超龄资格」在回收前定案、只认「回收后仍在」的票——回收是子进程调用（有 ~0.2s 间隔），
        #    资格与残留分两次取样会让恰好跨过 TTL 边界的票被误判。
        import json as _json
        canonical = Path(__file__).resolve().parent.parent  # 判据常驻仓（红例里仍指向真仓）
        try:
            ttl_ms = float(os.environ.get("ORCH_MUTEX_TICKET_TTL_MS", "600000"))
        except ValueError:
            ttl_ms = 600000.0
        if not ttl_ms >= 0:
            ttl_ms = 600000.0
        cutoff = time.time() - ttl_ms / 1000.0
        eligible = [p for p in coordinator.glob("lock-*") if p.stat().st_mtime < cutoff]
        sweep = (
            "import('file:///" + canonical.as_posix() + "/scripts/core/leases.mjs')"
            ".then(m => m.sweepStaleMutexTickets(" + _json.dumps(coordinator.as_posix()) + "))"
            ".catch(e => { console.error(e.message); process.exit(1); })"
        )
        try:
            sweep_rc = subprocess.run(["node", "-e", sweep], capture_output=True, text=True, timeout=60).returncode
        except OSError:
            sweep_rc = None
        if sweep_rc != 0:
            print(f"    （引擎按龄回收不可用 rc={sweep_rc}，回退本地按龄回收）")
            for p in eligible:
                try:
                    p.unlink()
                except OSError:
                    pass
        stale = [p.name for p in eligible if p.exists()]
    if stale:
        print(f"    协调器目录有过期锁票 {len(stale)} 个（超龄（>{ttl_ms / 60000:g} 分钟），按龄回收后仍残留）⇒ FAIL: {stale[:5]}")
        ok = False
    else:
        print("    协调器目录无过期锁票（先按龄回收，再核对残留）")
    print(f"    → L4 {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def main() -> int:
    global LOG_PATH, LOG_EXPLICIT
    args = [_native(a) for a in sys.argv[1:]]
    rc = 0
    # 判据不得随壳变色：本壳的用户级 ORCH_SPAWN_MODE 只报告、不继承（子进程一律钉 headless）。
    print(f"  本壳 ORCH_SPAWN_MODE={os.environ.get('ORCH_SPAWN_MODE') or '(unset)'} ⇒ 子进程钉 headless、零弹窗")
    if "--run" in args:
        out = DEFAULT_LOG
        rc |= 1 if run_suite(out) != 0 else 0
    if "--log" in args:
        nxt = args[args.index("--log") + 1] if len(args) > args.index("--log") + 1 else None
        # 只有显式给了非旗标参数才当路径；否则 --log --doctor 会把 --doctor 吞成路径（2026-09-14 ENTJ 修）
        LOG_EXPLICIT = bool(nxt and not nxt.startswith("--"))
        LOG_PATH = Path(nxt) if LOG_EXPLICIT else DEFAULT_LOG
        print(f"读日志: {LOG_PATH}")
        if not LOG_PATH.exists():
            # 显式点名的日志不存在：干净判 FAIL（判据工具的失败也要可读，不许抛栈帧）（2026-09-16 修）
            print(f"    MISSING_LOG: 日志不存在 `{LOG_PATH}`（显式点名必判；先 `--run` 生成再判）⇒ FAIL")
            rc |= 1
        else:
            rc |= verdict(parse_log(LOG_PATH))
    if "--doctor" in args:
        rc |= doctor()
    if "--canary" in args:
        rc |= canary()
    if "--verify-missing" in args:
        rc |= verify_missing()
    if "--consistency" in args:
        rc |= consistency(LOG_PATH, LOG_EXPLICIT)
    if not any(f in args for f in ("--run", "--log", "--doctor", "--canary", "--verify-missing", "--consistency")):
        print(__doc__)
        return 0
    print(f"ORCH_LEVEL_CHECK: {'PASS' if rc == 0 else 'FAIL'}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
