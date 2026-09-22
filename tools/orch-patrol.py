#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""orch patrol — L10「机器化」第一件：定时巡逻 + 提交即判（本机，无网络依赖）。

背景：GitHub Actions 弃用（用户令 2026-09-15）后，「每级 CI 绿」的口径落在本机等价门禁
`node scripts/gate.mjs --all`（仓内，5 条判据）。但「机器化」还差一步：判定要由机器按时跑、
结论要绑在每个提交上，而不是等人自觉。本脚本就是这一步，挂进 Windows 计划任务
`orch-level-patrol`（每 15 分钟、隐藏窗口、执行结果进任务历史；安装件
`tools/orch-patrol-install.ps1`，抄 83 patrol.py + VBS 隐藏窗形态）。

- 定时巡逻（每个 tick，非侵入）：
  ① 仓库：HEAD / 分支 / 脏树计数；② node24 运行时就位（判不了=红，不静默）；
  ③ 在跑的判定进程探测（gate.mjs / 套件 / 机判 / 恢复演练）——在跑则本轮推迟
     （记 defer:judge-running），防与人工/其它判定抢占（套件对负载敏感；BOSS 独立复跑同理）。
  产物：logs/patrol/state.json（最新态）+ logs/patrol/patrol-<date>.jsonl（逐 tick 追加）。
- 提交即判（发现新 HEAD 且树干净）：自动跑 `node scripts/gate.mjs --all`（子进程显式钉
  headless、ORCH_AGENT=codex，零弹窗），结论绑到该提交：logs/patrol/judged-<sha12>.json
  （判卷明细 + `_patrol` 元数据）＋ logs/patrol/gate-<sha12>.log（门禁原文）。
  脏树不判（如实记 dirty-tree，等下一个干净提交；不跳过、不静默）。
- 能红的反例（本 tick 默认复跑 --self-red 的纯函数部分；端到端红例 = --red-demo）：
  --self-red 把坏输入喂进**同一批谓词**（判卷解析 / 判前资格），必须全部判红＋正例对照；
  --red-demo 克隆本仓、喂真坏输入（缺测试 + 文档篡改）、提交后对副本判卷——必须判红、绑提交、
  不假绿（副本留在 D:/temp/orch-patrol-reddemo-<ts>/ 供复核）。

用法：
  python tools/orch-patrol.py                 # 一个 tick（观测 + 必要时提交即判）
  python tools/orch-patrol.py --status        # 打印最近状态（人读）
  python tools/orch-patrol.py --self-red [--json F]   # 红例：坏输入 -> 同一批谓词必须全红
  python tools/orch-patrol.py --red-demo      # 端到端红例（克隆 + 篡改 + 判红）
  python tools/orch-patrol.py --no-gate       # 只观测，不跑提交即判
  python tools/orch-patrol.py --force-judge   # 忽略已判记录，重跑提交即判
  python tools/orch-patrol.py --repo D:/temp/x   # 对副本跑（演练用）

退出码：0 = 本轮绿/跳过；1 = 本轮红；2 = 内部错误（红/错误都要在任务历史里看得见）。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_DIR = r'C:\Program Files\nodejs'  # 2026-09-22: node24-fresh tree removed; system node
NODE_EXE = os.path.join(NODE_DIR, 'node.exe')
CODEX_BIN = r'C:\Users\<user>\.tools\open-tui-orchestrator\scripts\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin'  # 2026-09-22: repo-local codex vendor (was under the removed node24-fresh)
GATE_TIMEOUT = 1500          # 门禁全量（含 296 条套件）的宽限；任务侧 ExecutionTimeLimit 30min
LOCK_STALE_MIN = 40          # 锁超过这个分钟数视为遗留（任务 15 分钟一跑）
OTHER_PROCS = r'gate\.mjs|\.test\.mjs|orch-level-check|l5-recovery-drill|orch-suite'
GATE_LINE = re.compile(r'ORCH_GATE: (PASS|FAIL)(?: \(([^)]*)\))? — (\d+) criteria')
SUITE_LINE = re.compile(r'actual: pass=(\d+) fail=(\d+) skipped=(\d+) cancelled=(\d+) exit=(\d+)')
SUITE_REDS_LINE = re.compile(r'\[gate\] suite reds \((\d+)\): (.*)')


def now_str():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# ---- predicates: the tick and --self-red call the SAME functions ----

def parse_gate(text):
    """判卷行解析：`ORCH_GATE: PASS — N criteria` / `ORCH_GATE: FAIL (L1, L4) — N criteria`。
    取最后一条（门禁输出尾部才是结论）；一条都没有 = UNKNOWN（未知不得当绿）。"""
    for ln in reversed((text or '').splitlines()):
        m = GATE_LINE.search(ln)
        if m:
            return m.group(1), int(m.group(3)), (m.group(2) or '')
    return 'UNKNOWN', None, ''


def parse_suite_reds(text):
    """门禁 L1 红名单解析（2026-09-17 起 gate 必打）：`[gate] suite reds (N): name @ at | …`。
    取最后一条；`unparsed`/计数 0 = 名单缺失（如实记 0，不编造名字）；无该行 = None。"""
    for ln in reversed((text or '').splitlines()):
        m = SUITE_REDS_LINE.search(ln)
        if not m:
            continue
        named = []
        body = m.group(2).strip()
        if body and body != 'unparsed':
            for part in body.split(' | '):
                part = part.strip()
                if part and not part.startswith('…'):
                    named.append(part)
        return {'count': int(m.group(1)), 'named': named}
    return None


def p_gate_ok(rc, text):
    """绿 = 退出码 0 ∧ 结论行 PASS；非零退出/FAIL 行/缺行/畸形一律不绿（未知即失败）。"""
    verdict, _, _ = parse_gate(text)
    return rc == 0 and verdict == 'PASS'


def p_judge_eligible(head, dirty_count, last_judged_head, force):
    """判前资格：有 HEAD ∧ 树干净（dirty==0）∧（强制 或 该 HEAD 未判过）。脏树/无头不判。"""
    return bool(head) and dirty_count == 0 and (bool(force) or head != last_judged_head)


def p_self_red_cases():
    return {
        'gate_rc_nonzero': not p_gate_ok(1, 'ORCH_GATE: PASS — 5 criteria'),
        'gate_fail_line': not p_gate_ok(0, 'ORCH_GATE: FAIL (L1, L4) — 5 criteria'),
        'gate_missing_line': not p_gate_ok(0, 'no marker here'),
        'gate_malformed': not p_gate_ok(0, 'ORCH_GATE: PASS — five criteria'),
        'judge_dirty_tree': not p_judge_eligible('a' * 40, 2, None, False),
        'judge_empty_head': not p_judge_eligible('', 0, None, False),
        'suite_reds_no_marker_no_claim': parse_suite_reds('✖ a failure without the gate marker') is None,
    }


def p_self_red_positives():
    return {
        'gate_pass_ok': p_gate_ok(0, 'ORCH_GATE: PASS — 5 criteria'),
        'judge_new_clean_head': p_judge_eligible('b' * 40, 0, None, False),
        'judge_already_judged_skips': not p_judge_eligible('b' * 40, 0, 'b' * 40, False),
        'judge_force_overrides': p_judge_eligible('b' * 40, 0, 'b' * 40, True),
        'suite_reds_parses': (parse_suite_reds('  [gate] suite reds (2): red one @ test/a.test.mjs:1:1 | red two @ test/b.test.mjs:2:1') or {}).get('named') == ['red one @ test/a.test.mjs:1:1', 'red two @ test/b.test.mjs:2:1'],
        'suite_reds_unparsed_keeps_names_empty': (parse_suite_reds('  [gate] suite reds (2): unparsed') or {}).get('named') == [],
    }


# ---- helpers ----

def git_in(repo, *args):
    p = subprocess.run(['git', '-C', repo] + list(args), capture_output=True)
    return p.stdout.decode('utf-8', 'replace').strip()


def other_judge_running():
    """其它判定/演练进程在跑？——本轮不抢（套件对负载敏感；BOSS 独立复跑、人工跑同理）。
    83 的教训：不加 Name 过滤会把「自己」数进去 ⇒ 永远 defer；这里只数 node*/python*，
    且模式串不含本脚本名（orch-patrol.py）。WMI 慢/退化时宁可照跑（except → False）。"""
    ps = ("$n=(Get-CimInstance Win32_Process | Where-Object {($_.Name -like 'node*' -or $_.Name -like 'python*') "
          "-and $_.CommandLine -match '%s'} | Measure-Object).Count; $n" % OTHER_PROCS)
    try:
        p = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, timeout=30)
        return int((p.stdout or b'').decode('utf-8', 'replace').strip() or '0') > 0
    except Exception:
        return False


# ---- commit gate ----

def run_gate(repo, state_dir):
    head = git_in(repo, 'rev-parse', 'HEAD')
    os.makedirs(state_dir, exist_ok=True)
    out_json = os.path.join(state_dir, 'judged-%s.json' % head[:12])
    out_log = os.path.join(state_dir, 'gate-%s.log' % head[:12])
    env = dict(os.environ)
    env['ORCH_AGENT'] = 'codex'
    env['ORCH_SPAWN_MODE'] = 'headless'      # 非交互自动化一律显式钉 headless：零弹窗、判据不随壳变色
    env.pop('ORCH_CLI', None)
    env.pop('ORCH_MAINTENANCE_LOCK', None)
    env['PATH'] = os.pathsep.join([NODE_DIR, CODEX_BIN, env.get('PATH', '')])
    t0 = time.time()
    rc, text = 125, ''
    marker = os.path.join(state_dir, 'gate.running')
    try:
        with open(marker, 'w', encoding='utf-8') as fh:
            fh.write('%s %s\n' % (os.getpid(), now_str()))
        try:
            p = subprocess.run([NODE_EXE, os.path.join('scripts', 'gate.mjs'), '--all'],
                               capture_output=True, timeout=GATE_TIMEOUT, cwd=repo, env=env)
            rc = p.returncode
            text = (p.stdout or b'').decode('utf-8', 'replace') + (p.stderr or b'').decode('utf-8', 'replace')
        except subprocess.TimeoutExpired:
            rc, text = 124, 'TIMEOUT'
        except Exception as e:  # noqa: BLE001
            rc, text = 125, repr(e)
    finally:
        try:
            os.remove(marker)
        except Exception:
            pass
    with open(out_log, 'w', encoding='utf-8') as fh:
        fh.write(text)
    verdict, criteria, failed_ids = parse_gate(text)
    suite = None
    m = SUITE_LINE.search(text)
    if m:
        suite = {'pass': int(m.group(1)), 'fail': int(m.group(2)), 'skipped': int(m.group(3)),
                 'cancelled': int(m.group(4)), 'exit': int(m.group(5))}
    suite_reds = parse_suite_reds(text)
    tail = [ln.strip() for ln in text.splitlines() if ln.strip()][-10:]
    ok = p_gate_ok(rc, text)
    meta = {'head': head, 'at': now_str(), 'rc': rc, 'secs': round(time.time() - t0, 1),
            'gate': verdict if verdict != 'UNKNOWN' else 'FAIL', 'criteria': criteria,
            'failed_ids': failed_ids, 'suite': suite, 'suite_reds': suite_reds, 'log': os.path.basename(out_log),
            'file': os.path.basename(out_json), 'tail': tail, 'ok': ok}
    with open(out_json, 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    return meta


# ---- tick ----

def do_tick(args, state_dir):
    state = {}
    sp = os.path.join(state_dir, 'state.json')
    if os.path.exists(sp):
        try:
            state = json.load(open(sp, encoding='utf-8'))
        except Exception:
            state = {}
    reds = []
    obs = {}
    # 判据自身的纯函数部分每 tick 默认复跑（毫秒级）：判卷解析/资格判定被改坏必须现形。
    cases, positives = p_self_red_cases(), p_self_red_positives()
    self_red_ok = all(cases.values()) and all(positives.values())
    obs['self_red'] = {'ok': self_red_ok, 'reds': '%d/%d' % (sum(cases.values()), len(cases)),
                       'positives': '%d/%d' % (sum(positives.values()), len(positives))}
    if not self_red_ok:
        reds.append('self-red')
    node_ok = os.path.exists(NODE_EXE)
    obs['node'] = {'exe': NODE_EXE, 'ok': node_ok}
    if not node_ok:
        reds.append('node-missing')
    head = branch = ''
    dirty = None
    try:
        head = git_in(args.repo, 'rev-parse', 'HEAD')
        branch = git_in(args.repo, 'rev-parse', '--abbrev-ref', 'HEAD')
        dirty = len([l for l in git_in(args.repo, 'status', '--porcelain').splitlines() if l.strip()])
        obs['repo'] = {'head': head, 'branch': branch, 'dirty': dirty}
    except Exception as e:  # noqa: BLE001
        obs['repo'] = {'err': repr(e)}
        reds.append('repo:exc')

    last_judged = state.get('last_judged') or {}
    gate = {'head': head, 'skipped': 'not-run'}
    if args.no_gate:
        gate = {'head': head, 'skipped': 'no-gate(flag)'}
    elif p_judge_eligible(head, dirty, last_judged.get('head'), args.force_judge) and node_ok and self_red_ok:
        if other_judge_running():
            gate = {'head': head, 'skipped': 'defer:judge-running'}
        else:
            gate = run_gate(args.repo, state_dir)
            if not gate.get('ok'):
                reds.append('commit-gate:%s' % head[:12])
    elif head and dirty:
        gate = {'head': head, 'skipped': 'dirty-tree'}
    elif head:
        gate = {'head': head, 'skipped': 'already-judged'}

    if gate.get('gate') in ('PASS', 'FAIL'):
        state['last_judged'] = {'head': gate['head'], 'at': gate['at'], 'gate': gate['gate'],
                                'criteria': gate.get('criteria'), 'file': gate.get('file')}
        hist = state.get('judged_history') or []
        hist.append({'head': gate['head'][:12], 'gate': gate['gate'], 'at': gate['at'], 'secs': gate.get('secs')})
        state['judged_history'] = hist[-10:]
    state.update({
        'updated_at': now_str(),
        'tick_seq': int(state.get('tick_seq') or 0) + 1,
        'head': head, 'branch': branch, 'dirty': dirty, 'repo': args.repo,
        'verdict': 'OK' if not reds else 'RED', 'reds': reds,
        'last_judged': state.get('last_judged'),
        'checks': obs,
        'gate': gate,
        'tool': 'tools/orch-patrol.py',
    })
    os.makedirs(state_dir, exist_ok=True)
    with open(sp, 'w', encoding='utf-8') as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    line = {'at': state['updated_at'], 'tick_seq': state['tick_seq'], 'head': (head or '')[:12],
            'dirty': dirty, 'verdict': state['verdict'], 'reds': reds,
            'gate': {k: gate.get(k) for k in ('gate', 'skipped') if gate.get(k) is not None}}
    with open(os.path.join(state_dir, 'patrol-%s.jsonl' % datetime.date.today().isoformat()),
              'a', encoding='utf-8') as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + '\n')

    print('PATROL_TICK: %s seq=%s head=%s dirty=%s gate=%s reds=%s'
          % (state['verdict'], state['tick_seq'], (head or '?')[:12], dirty,
             gate.get('gate') or gate.get('skipped'), reds))
    for r in reds:
        print('PATROL_RED: %s' % r)
    for name in (gate.get('suite_reds') or {}).get('named', []):
        print('PATROL_GATE_RED: %s' % name)
    return 0 if not reds else 1


# ---- self-red / red-demo ----

def do_self_red(args):
    cases, positives = p_self_red_cases(), p_self_red_positives()
    reds_ok, pos_ok = all(cases.values()), all(positives.values())
    print('PATROL_RED: %s (reds %d/%d, positives %d/%d)'
          % ('OK' if (reds_ok and pos_ok) else 'FAIL',
             sum(cases.values()), len(cases), sum(positives.values()), len(positives)))
    if args.json:
        try:
            with open(args.json, 'w', encoding='utf-8') as fh:
                json.dump({'at': now_str(), 'cases': cases, 'positive': positives,
                           'all_red': reds_ok, 'positives_ok': pos_ok}, fh, ensure_ascii=False, indent=1)
        except Exception as e:  # noqa: BLE001
            print('PATROL_RED: json-write-failed %r' % e)
    return 0 if (reds_ok and pos_ok) else 1


def do_red_demo(args):
    """端到端红例：克隆本仓 -> 喂真坏输入（缺测试 + 文档篡改）-> 提交 -> 对副本判卷。
    期望：判卷 FAIL、绑提交、退出码非 0、不假绿；副本留盘供复核。"""
    base = 'D:/temp/orch-patrol-reddemo-%s' % datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    clone = os.path.join(base, 'clone')
    r = subprocess.run(['git', 'clone', '--quiet', args.repo, clone], capture_output=True)
    if r.returncode != 0:
        print('PATROL_RED_DEMO: FAIL (clone rc=%s %s)' % (r.returncode, r.stderr.decode('utf-8', 'replace')[:200]))
        return 2
    removed = 0
    testdir = os.path.join(clone, 'test')
    if os.path.isdir(testdir):
        for name in os.listdir(testdir):
            if name.endswith('.test.mjs'):
                os.remove(os.path.join(testdir, name))
                removed += 1
    if removed == 0:
        print('PATROL_RED_DEMO: FAIL (no suite files removed - mutation not applied?)')
        return 1
    readme = os.path.join(clone, 'README.md')
    s = open(readme, encoding='utf-8').read()
    s2 = re.sub(r'(with )\d+/\d+( offline tests passing)', r'\g<1>999/999\g<2>', s, count=1)
    if s2 == s:
        print('PATROL_RED_DEMO: FAIL (README mutation not applied - MUTATION_NOT_APPLIED)')
        return 1
    with open(readme, 'w', encoding='utf-8', newline='') as fh:
        fh.write(s2)
    add = subprocess.run(['git', '-C', clone, 'add', '-A'], capture_output=True)
    com = subprocess.run(['git', '-C', clone, '-c', 'user.name=orch-patrol', '-c', 'user.email=patrol@local',
                          'commit', '-m', 'red-demo: tampered tree (suite files removed + README total broken)'],
                         capture_output=True)
    if add.returncode != 0 or com.returncode != 0:
        print('PATROL_RED_DEMO: FAIL (drill commit rc=%s/%s)' % (add.returncode, com.returncode))
        return 2
    state_dir = os.path.join(clone, 'logs', 'patrol')
    meta = run_gate(clone, state_dir)
    judged_ok = os.path.exists(os.path.join(state_dir, meta['file']))
    no_fake_green = (meta.get('gate') == 'FAIL') and meta.get('rc') != 0
    ok = no_fake_green and judged_ok
    print('PATROL_RED_DEMO: %s (clone=%s head=%s gate=%s rc=%s secs=%s judged=%s)'
          % ('OK' if ok else 'FAIL', base, meta['head'][:12], meta.get('gate'), meta.get('rc'),
             meta.get('secs'), meta.get('file') if judged_ok else 'MISSING'))
    if not ok:
        print('  tail: %s' % ' | '.join(meta.get('tail') or [])[:400])
    return 0 if ok else 1


def do_status(args, state_dir):
    sp = os.path.join(state_dir, 'state.json')
    if not os.path.exists(sp):
        print('PATROL_STATUS: no state yet (%s)' % sp)
        return 1
    st = json.load(open(sp, encoding='utf-8'))
    age = ''
    try:
        dt = datetime.datetime.strptime(st['updated_at'], '%Y-%m-%d %H:%M:%S')
        age = '%.1fmin' % ((datetime.datetime.now() - dt).total_seconds() / 60.0)
    except Exception:
        pass
    print('PATROL_STATUS: verdict=%s updated=%s age=%s tick=%s'
          % (st.get('verdict'), st.get('updated_at'), age, st.get('tick_seq')))
    print('  head=%s dirty=%s repo=%s' % ((st.get('head') or '?')[:12], st.get('dirty'), st.get('repo')))
    print('  last_judged=%s reds=%s' % (json.dumps(st.get('last_judged'), ensure_ascii=False), st.get('reds')))
    for h in (st.get('judged_history') or [])[-5:]:
        print('  hist: %s %s %s %ss' % (h.get('head'), h.get('gate'), h.get('at'), h.get('secs')))
    return 0


def main():
    ap = argparse.ArgumentParser(description='orch patrol: tick / self-red / red-demo / status')
    ap.add_argument('--state-dir', default='')
    ap.add_argument('--repo', default=ROOT)
    ap.add_argument('--self-red', action='store_true')
    ap.add_argument('--red-demo', action='store_true')
    ap.add_argument('--status', action='store_true')
    ap.add_argument('--no-gate', action='store_true', help='只观测，不跑提交即判')
    ap.add_argument('--force-judge', action='store_true', help='忽略已判记录，重跑提交即判')
    ap.add_argument('--json', default='')
    args = ap.parse_args()
    args.repo = os.path.abspath(args.repo)
    state_dir = args.state_dir or os.path.join(args.repo, 'logs', 'patrol')
    if args.self_red:
        return do_self_red(args)
    if args.red_demo:
        return do_red_demo(args)
    if args.status:
        return do_status(args, state_dir)
    os.makedirs(state_dir, exist_ok=True)
    lock = os.path.join(state_dir, '.lock')

    def _acquire():
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, b'%d %s' % (os.getpid(), now_str().encode()))
        os.close(fd)

    try:
        _acquire()
    except FileExistsError:
        try:
            txt = open(lock, encoding='utf-8').read().split()
            t0 = datetime.datetime.strptime(txt[1] + ' ' + txt[2], '%Y-%m-%d %H:%M:%S')
            if (datetime.datetime.now() - t0).total_seconds() < LOCK_STALE_MIN * 60:
                print('PATROL_TICK: skip=locked (%s)' % ' '.join(txt))
                return 0
        except Exception:
            pass
        try:
            os.remove(lock)
            _acquire()
        except Exception as e:  # noqa: BLE001
            print('PATROL_TICK: skip=locked-race (%r)' % e)
            return 0
    try:
        return do_tick(args, state_dir)
    except Exception as e:  # noqa: BLE001
        print('PATROL_TICK: internal-error %r' % e)
        return 2
    finally:
        try:
            os.remove(lock)
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
