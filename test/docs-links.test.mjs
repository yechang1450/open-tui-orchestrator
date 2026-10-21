import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 三份对外文档：链接断了没有构建会报错，只有读者会撞见，所以用一台离线测试盯着。
// 新增对外文档时把路径加进来——这份清单就是覆盖范围本身。
export const DOCS = ['README.md', 'README-zh.md', 'docs/known-issues.md'];

// 只认行内链接 `[文字](目标)` 与图片 `![替代文字](目标)`。
// 参考式链接（`[文字][id]` + `[id]: 目标`）这三份文件当前都没用；将来要用得同步扩写本文件，
// 否则会静默漏检——这是刻意的范围声明，不是遗漏。跨行链接文字同样不支持（正则不吃换行）。
const LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

// 任何带 scheme 的目标都不是仓内相对路径：http: https: mailto: tel: data: …
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 逐行抽出链接；行号按匹配位置换算，所以一条长段落里的多个链接各自有正确行号。 */
export function collectLinks(text) {
  const links = [];
  for (const match of text.matchAll(LINK)) {
    const [, bang, label, rawTarget] = match;
    links.push({
      line: text.slice(0, match.index).split('\n').length,
      label,
      dest: rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget,
      image: bang === '!',
    });
  }
  return links;
}

/** 跳过外链、协议相对链接和纯锚点；剩下的一律按仓内相对路径校验。 */
export function isRelative(dest) {
  if (!dest) return false;
  if (dest.startsWith('#')) return false;
  if (dest.startsWith('//')) return false;
  if (SCHEME.test(dest)) return false;
  return true;
}

/** 去掉 ?query 与 #anchor 后解码，返回绝对目标；整条目标只剩锚点/查询时返回 null。 */
export function resolveTarget(root, file, dest) {
  let clean = dest.split('#')[0].split('?')[0];
  if (!clean) return null;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 非法百分号编码就按原样比对，让缺失路径自己红出来，不要在这里抛 TypeError
  }
  // 以 `/` 开头视为仓根绝对路径；其余按链接所在文件的目录解析（GitHub 渲染语义）。
  // README 在仓根，两种写法等价；docs/ 下的文件必须按 docs/ 解析，否则会把
  // `security-audit.md` 错认成 `<root>/security-audit.md`。
  const base = clean.startsWith('/') ? root : path.dirname(path.join(root, file));
  return path.resolve(base, clean.replace(/^\/+/, ''));
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 扫描 files（相对 root 的路径），返回可断言的账本。
 * 文件读不到直接抛 ENOENT——三份文档少一份都要红，不允许静默跳过。
 */
export function scanDocs(root, files) {
  const report = {files: [], links: 0, relative: 0, external: 0, anchors: 0, skipped: 0, checked: [], broken: []};
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const links = collectLinks(text);
    report.files.push({file, bytes: Buffer.byteLength(text), links: links.length});
    report.links += links.length;
    for (const link of links) {
      if (!isRelative(link.dest)) {
        if (link.dest.startsWith('#')) report.anchors++;
        else report.external++;
        continue;
      }
      const target = resolveTarget(root, file, link.dest);
      if (!target) {
        // 只剩查询串的目标（`[x](?raw=1)`）不是路径也不是外链，单独记一笔，别混进 relative
        report.skipped++;
        continue;
      }
      report.relative++;
      const entry = {file, line: link.line, label: link.label, dest: link.dest, target};
      if (!isInside(root, target)) report.broken.push({...entry, reason: 'outside-repo'});
      else if (!fs.existsSync(target)) report.broken.push({...entry, reason: 'missing'});
      else report.checked.push(entry);
    }
  }
  return report;
}

/** 断言消息里的唯一格式：文件:行号:链接。多断几条时逐行列出，方便直接跳过去改。 */
export function describeBroken(broken) {
  return broken.map((b) => `${b.file}:${b.line}:[${b.label}](${b.dest}) (${b.reason})`).join('\n');
}

test('README / README-zh / known-issues 的相对链接都能在仓内落地', (t) => {
  const report = scanDocs(ROOT, DOCS);

  // 覆盖闸门 1：三份文件都必须真的被读到（顺序也钉住，防止清单被悄悄改成只扫一份）。
  assert.deepEqual(report.files.map((f) => f.file), DOCS);
  // 覆盖闸门 2：空文件/被清空的文件不算扫过。
  for (const entry of report.files) assert.ok(entry.bytes > 0, `${entry.file} is empty — nothing was really scanned`);
  // 覆盖闸门 3：合计必须解析出足够多的链接。当前三份文件共 34 条（全部是 GitHub 绝对地址），
  // 下限取 10：文件被截断、正则写坏、读错路径都会先在这里红，而不是空跑通过。
  assert.ok(report.links >= 10, `only ${report.links} Markdown link(s) parsed from ${DOCS.join(', ')} — the scan is not really reading the docs`);

  // 现状说明（2026-10-21）：这三份文件里 relative=0——双语 README 的链接全部是 github.com
  // 绝对地址，known-issues 一条 Markdown 链接都没有。也就是说本用例今天对「相对链接断掉」
  // 其实是空跑；真正证明相对链接会被抓住的是下面那条夹具用例。等文档换回相对链接（或新增
  // 相对链接），本用例自动开始生效，不用改测试——diagnostic 里的 relative 计数就是水位。

  // 内部自洽：每条相对链接要么进 checked，要么进 broken。
  assert.equal(report.checked.length + report.broken.length, report.relative, 'relative links were dropped somewhere between parsing and checking');

  t.diagnostic(`scanned ${report.files.map((f) => `${f.file}(${f.links})`).join(' ')}; links=${report.links} relative=${report.relative} external=${report.external} anchors=${report.anchors} skipped=${report.skipped} broken=${report.broken.length}`);

  assert.deepEqual(report.broken, [], `broken relative link(s) in repo docs:\n${describeBroken(report.broken)}`);
});

test('the scanner itself fails on a missing relative target, in file:line:link form', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-links-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'), {recursive: true});
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# a\n');
    fs.writeFileSync(path.join(root, 'docs', 'pic.png'), '');
    fs.writeFileSync(path.join(root, 'README.md'), [
      '[ok](docs/a.md)',            // 1 存在
      '[dir](docs)',                // 2 目录也算存在
      '[anchor](docs/a.md#sec)',    // 3 锚点要剥掉
      '[query](docs/a.md?raw=1#x)', // 4 查询串要剥掉
      '[web](https://example.com/x.md)', // 5 外链跳过
      '[mail](mailto:a@b.c)',       // 6 非 http scheme 跳过
      '[top](#top)',                // 7 纯锚点跳过
      '[bad](docs/missing.md)',     // 8 缺失 → 必须红
      '[escape](../outside.md)',    // 9 跑出仓外 → 必须红
      '[rootpath](/docs/a.md)',     // 10 仓根绝对路径
      '![img](docs/pic.png)',       // 11 图片路径同样校验
      '[queryonly](?raw=1)',         // 12 只剩查询串：不是路径，跳过
      '',
    ].join('\n'));

    const report = scanDocs(root, ['README.md']);
    assert.equal(report.links, 12);
    assert.equal(report.relative, 8, 'ok/dir/anchor/query/bad/escape/rootpath plus the image must be treated as relative');
    assert.equal(report.external, 2, 'https and mailto must be skipped');
    assert.equal(report.anchors, 1, 'a bare #anchor must be skipped');
    assert.equal(report.skipped, 1, 'a query-only destination must be skipped instead of counted as a relative path');
    assert.equal(report.checked.length, 6, 'ok, dir, anchor, query, rootpath and the image must resolve');
    assert.deepEqual(report.broken.map((b) => `${b.file}:${b.line}:${b.dest}`), [
      'README.md:8:docs/missing.md',
      'README.md:9:../outside.md',
    ]);

    // 断言消息必须是 文件:行号:链接，且多断几条时逐行给出——这条锁住报错可读性。
    const message = describeBroken(report.broken);
    assert.match(message, /^README\.md:8:\[bad\]\(docs\/missing\.md\) \(missing\)$/m);
    assert.match(message, /^README\.md:9:\[escape\]\(\.\.\/outside\.md\) \(outside-repo\)$/m);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

// known-issues.md 的每条记录都靠反引号里的 `路径:行号` 说出处——这是它声称「可核对」的唯一凭据。
// Markdown 链接断了读者看得见，反引号路径写错没人看得见，所以单独钉一条。
// 只认带目录的文件路径（`docs/x.md:30`）：裸文件名（`guardian.json`）是指产物名不是仓内出处。
const REF = /`([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]*\.[A-Za-z]{1,5})(?::(\d+))?`/g;

export function collectRefs(text) {
  const refs = [];
  for (const match of text.matchAll(REF)) {
    refs.push({line: text.slice(0, match.index).split('\n').length, file: match[1], lineNo: match[2] ? Number(match[2]) : null});
  }
  return refs;
}

test('known-issues 的每个 `路径:行号` 出处都真实存在', () => {
  const doc = 'docs/known-issues.md';
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  const refs = collectRefs(text);
  // 覆盖闸门：出处少于 10 条说明解析坏了（当前 17 条），不是「文档没问题」。
  assert.ok(refs.length >= 10, `only ${refs.length} backticked path reference(s) parsed from ${doc} — parser or doc changed shape`);

  const problems = [];
  for (const ref of refs) {
    const target = path.resolve(ROOT, ref.file);
    if (!isInside(ROOT, target)) { problems.push(`${doc}:${ref.line}:${ref.file} (outside-repo)`); continue; }
    if (!fs.existsSync(target)) { problems.push(`${doc}:${ref.line}:${ref.file} (missing)`); continue; }
    if (ref.lineNo === null) continue;
    const total = fs.readFileSync(target, 'utf8').split('\n').length;
    if (ref.lineNo < 1 || ref.lineNo > total) problems.push(`${doc}:${ref.line}:${ref.file}:${ref.lineNo} (line ${ref.lineNo} > ${total})`);
  }
  assert.deepEqual(problems, [], `stale 出处 in ${doc}:\n${problems.join('\n')}`);
});

