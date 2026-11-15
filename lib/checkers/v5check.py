"""v5 校验器：读结构化块（v5.json），不再依赖工作区文件。

用法:
  python v5check.py <目录或 v5.json> [--json]

设计要点：
- 与 v4 的可比规则（B1/B2/B3/T1/T3/T4/TOL/N1/N2/N3/S1/R1/X1）判定口径一致；
- 新增防欺骗规则：CE1 声称有事件 / DE1 演示有具体输出 / SR1 来源形状 / CH1 空转 / ORD1 顺序；
- 字段缺失时"跳过"而不是判失败（便于和 v4 做逐规则等价对照）。
"""
import sys, os, json, re

res = []

def add(ok, code, msg, detail=''):
    res.append({'ok': bool(ok), 'code': code, 'msg': msg, 'detail': detail})

DIMS = ['范围', '量词', '例外', '优先级', '格式', '单位', '口径', '隐含依赖']

def load(path):
    p = path
    if os.path.isdir(path):
        p = os.path.join(path, 'v5.json')
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception as e:
        print('  v5.json 解析失败: %s' % e)
        return None

def src_kind(s):
    s = str(s or '')
    if re.search(r'https?://', s):
        return 'url'
    if '未核' in s:
        return 'unverified'
    if re.search(r'推导|公式|计算|\d\s*[×x*]\s*\d|=', s):
        return 'derived'
    return 'other'

def num(x):
    m = re.search(r'[-+]?\d+(?:\.\d+)?', str(x or ''))
    return float(m.group(0)) if m else None

def as_dicts(x):
    return [i for i in x if isinstance(i, dict)] if isinstance(x, list) else []

def check(block, mode=None):
    b = block if isinstance(block, dict) else {}
    bd = b.get('boundary')
    if not isinstance(bd, dict):
        bd = {}
    dims_hit = [d for d in DIMS if d in bd]
    add(len(dims_hit) >= 6, 'B1', '八维覆盖 %d/8' % len(dims_hit), '命中: ' + ' '.join(dims_hit))

    amb = bd.get('ambiguity') if isinstance(bd.get('ambiguity'), list) else []
    amb_ok = [a for a in amb if isinstance(a, dict) and a.get('read_a') and a.get('read_b')
              and (a.get('pick') or a.get('delta')) and a.get('why')]
    if amb:
        add(len(amb_ok) == len(amb), 'B2', '歧义 %d 组（合格 %d）' % (len(amb), len(amb_ok)),
            '' if len(amb_ok) == len(amb) else '有歧义缺 读法/差异/采用/依据')
    else:
        add(False, 'B2', '没有歧义记录', '')

    ext = bd.get('extensions') if isinstance(bd.get('extensions'), list) else []
    if ext:
        bad = [e for e in ext if not (isinstance(e, dict) and e.get('name') and e.get('why'))]
        add(not bad, 'B3', '扩展维度 %d 条' % len(ext), '' if not bad else '缺理由: %d' % len(bad))
    else:
        add(True, 'B3', '跳过（无扩展维度）', '')

    # A3 清点：源→产物集合（或写明不适用）
    inv = b.get('inventory') if isinstance(b.get('inventory'), list) else []
    if inv:
        bad_inv = [i for i in inv if not (isinstance(i, dict) and (
            str(i.get('na') or '').strip() or (i.get('from') is not None and i.get('to') is not None)))]
        add(not bad_inv, 'A3-1', '清点条目 %d 条（合格 %d）' % (len(inv), len(inv) - len(bad_inv)),
            '' if not bad_inv else '缺 from/to 或 na 原因')
    else:
        add(False, 'A3-1', '没有清点（inventory）', '给 源→产物 集合，或 {"na":"原因"}')

    # A5 变质：变换 T + 关系 R + 实测
    invr = b.get('invariants') if isinstance(b.get('invariants'), list) else []
    if invr:
        bad_iv = [i for i in invr if not (isinstance(i, dict) and (
            str(i.get('na') or '').strip() or (i.get('transform') and i.get('relation')
                                               and str(i.get('actual') or '').strip())))]
        add(not bad_iv, 'A5-1', '变质关系 %d 条（合格 %d）' % (len(invr), len(invr) - len(bad_iv)),
            '' if not bad_iv else '缺 transform/relation/actual 或 na 原因')
    else:
        add(False, 'A5-1', '没有变质关系（invariants）', '给 变换T+关系R+实测，或 {"na":"原因"}')

    # A4 跨产物一致：两处表示对账
    cons = b.get('consistency') if isinstance(b.get('consistency'), list) else []
    if cons:
        bad_c = [i for i in cons if not (isinstance(i, dict) and (
            str(i.get('na') or '').strip() or (i.get('a') and i.get('b') and ('same' in i))))]
        add(not bad_c, 'A4-1', '跨产物一致 %d 条（合格 %d）' % (len(cons), len(cons) - len(bad_c)),
            '' if not bad_c else '缺 a/b/same 或 na 原因')
    else:
        add(False, 'A4-1', '没有跨产物一致（consistency）', '给两份表示对账，或 {"na":"原因"}（单产物）')

    crit_raw = b.get('criteria')
    crit = as_dicts(crit_raw)
    if isinstance(crit_raw, list) and len(crit_raw) != len(crit):
        add(False, 'T1', '判据含非对象条目', '')
    elif not crit:
        add(False, 'T1', '没有判据', '')
    else:
        no_ref = [c.get('id', '?') for c in crit if not str(c.get('ref') or '').strip()]
        add(not no_ref, 'T1', '判据 %d 条，%d/%d 有引用' % (len(crit), len(crit) - len(no_ref), len(crit)),
            '' if not no_ref else ','.join(no_ref))

    KINDS = ('清点', '变质', '一致', '边界')
    if crit:
        bad_kind = [c.get('id', '?') for c in crit if c.get('kind') not in KINDS]
        add(not bad_kind, 'INV1', '判据类型 %d/%d 合法' % (len(crit) - len(bad_kind), len(crit)),
            '' if not bad_kind else '缺失/非法: ' + ','.join(bad_kind[:6]))
        kinds = {c.get('kind') for c in crit}
        have = [k for k in ('清点', '变质', '一致') if k in kinds]
        add(len(have) >= 2, 'KIND1', '三类必要条件覆盖 %d/3' % len(have),
            '' if len(have) >= 2 else '至少覆盖两类（现有: %s）' % ','.join(have))

    if crit:
        bad_src = [(c.get('id', '?'), str(c.get('source') or '')[:24]) for c in crit
                   if src_kind(c.get('source')) == 'other']
        add(not bad_src, 'T4', '来源合规 %d/%d' % (len(crit) - len(bad_src), len(crit)),
            '' if not bad_src else '; '.join('%s=%s' % (i, src) for i, src in bad_src[:4]))

    if crit:
        loose = []
        for c in crit:
            v = num(c.get('tol'))
            if v is None:
                loose.append(c.get('id', '?') + '(缺容差)')
            elif v > 5:
                loose.append('%s(%s)' % (c.get('id', '?'), c.get('tol')))
        add(not loose, 'TOL', '容差 %d/%d 合规' % (len(crit) - len(loose), len(crit)),
            '' if not loose else ','.join(loose[:6]))

    demos = as_dicts(b.get('demos'))
    if crit:
        ids = {c.get('id') for c in crit}
        covered = {d.get('id') for d in demos}
        missing = sorted(ids - covered)
        add(not missing, 'T3', '演示覆盖 %d/%d' % (len(ids & covered), len(ids)),
            '' if not missing else '缺: ' + ','.join(missing[:6]))

    if demos:
        crash_rx = r'Traceback|Exception|Segmentation'
        no_fail = [d.get('id', '?') for d in demos
                   if 'FAIL' not in str(d.get('actual') or '').upper()
                   and not re.search(crash_rx, str(d.get('actual') or ''))]
        add(not no_fail, 'N1', '演示含 FAIL %d/%d' % (len(demos) - len(no_fail), len(demos)),
            '' if not no_fail else ','.join(no_fail[:6]))
        crashed = [d.get('id', '?') for d in demos
                   if re.search(r'Traceback|Exception|Segmentation', str(d.get('actual') or ''))]
        add(not crashed, 'N2', '崩溃伪装失败 0 处' if not crashed else '崩溃 %d 处' % len(crashed),
            ','.join(crashed[:6]))
        empty = [d.get('id', '?') for d in demos if not re.search(r'\d|Error|错误码|E\d{3}', str(d.get('actual') or ''))]
        add(not empty, 'DE1', '演示有具体输出 %d/%d' % (len(demos) - len(empty), len(demos)),
            '' if not empty else '只写"报错了": ' + ','.join(empty[:6]))
        bad_mut = [d.get('id', '?') for d in demos if not str(d.get('mutate') or '').strip()]
        add(not bad_mut, 'N3', '改坏有落点 %d/%d' % (len(demos) - len(bad_mut), len(demos)),
            '' if not bad_mut else ','.join(bad_mut[:6]))
        green = not no_fail and not crashed
        if green and len(demos) < 3:
            add(False, 'S1', '全绿但演示只有 %d 条' % len(demos), '首轮全绿需强制抽验 ≥3')
        else:
            add(True, 'S1', '抽验条件满足', '')

    bad_src_shape = []
    for c in crit:
        k = src_kind(c.get('source'))
        s = str(c.get('source') or '')
        if k == 'url' and not re.search(r'https?://[^\s，。]+', s):
            bad_src_shape.append(c.get('id', '?'))
        if k == 'derived' and not re.search(r'\d', s):
            bad_src_shape.append(c.get('id', '?'))
    if crit:
        add(not bad_src_shape, 'SR1', '来源形状 %d/%d' % (len(crit) - len(bad_src_shape), len(crit)),
            '' if not bad_src_shape else '可疑: ' + ','.join(bad_src_shape[:6]))

    reqs = as_dicts(b.get('requirements'))
    if reqs:
        ids = {c.get('id') for c in crit}
        bad = []
        for r in reqs:
            owns = r.get('criteria') or []
            if not owns or any(o not in ids for o in owns):
                bad.append(r.get('id', '?'))
        covered = {o for r in reqs for o in (r.get('criteria') or [])}
        orphan = sorted(ids - covered)
        add(not bad and not orphan, 'A1', '需求点 %d 条，认领 %d/%d' % (len(reqs), len(covered & ids), len(ids)),
            ('未认领: ' + ','.join(orphan[:5]) if orphan else '') + (' 无效认领: ' + ','.join(bad[:5]) if bad else ''))
    else:
        add(True, 'A1', '跳过（无 requirements）', '')

    searches_raw = b.get('searches')
    searches = as_dicts(searches_raw)
    if isinstance(searches_raw, list) and searches_raw:
        bad = [x for x in searches_raw
               if not (isinstance(x, dict) and x.get('query') and x.get('opened') and x.get('excerpt') and x.get('payload'))]
        add(not bad, 'D1', '检索账本 %d 条' % len(searches_raw),
            '' if not bad else '缺检索式/摘录/载荷性或非对象: %d' % len(bad))
    else:
        add(True, 'D1', '跳过（无 searches）', '')

    # D2/D3：检索账本的必填与质量（由宿主 --mode 决定是否强制）
    entries = searches
    if mode == 'research-first':
        add(bool(entries), 'D2', '研究型检索账本 %d 条' % len(entries),
            '' if entries else '至少 1 条 searches（query/purpose/opened/excerpt/payload/not_covered）')
    if entries:
        purposes = ('orientation', 'targeted', 'cross-check', 'gap', 'saturation')
        bad_se = []
        seen_q = set()
        for x in entries:
            q = str(x.get('query') or '').strip()
            pu = str(x.get('purpose') or '').strip()
            op = str(x.get('opened') or '').strip()
            ex = str(x.get('excerpt') or '').strip()
            pay = str(x.get('payload') or '').strip()
            nc = str(x.get('not_covered') or '').strip()
            tag = q[:18] or '?'
            if len(q) < 4 or q in seen_q:
                bad_se.append(tag + '(query 太短/重复)')
            seen_q.add(q)
            if pu not in purposes:
                bad_se.append(tag + '(purpose 非法)')
            if not op:
                bad_se.append(tag + '(缺 opened)')
            if len(ex) < 10 or len(ex) > 300:
                bad_se.append(tag + '(excerpt 长度)')
            if not pay:
                bad_se.append(tag + '(缺 payload)')
            if not nc:
                bad_se.append(tag + '(缺 not_covered)')
        add(not bad_se, 'D3', '检索账本质量 %d 条（问题 %d 处）' % (len(entries), len(bad_se)),
            '' if not bad_se else '; '.join(bad_se[:5]))

    scoped = [c for c in crit if 'scope' in c]
    if scoped:
        vague = re.compile(r'^(全部|所有|整个文件|整体|全部元素)$')
        bad = [c.get('id', '?') for c in scoped
               if not str(c.get('scope') or '').strip() or vague.match(str(c.get('scope')).strip())]
        add(not bad, 'V1', '定义域 %d/%d' % (len(scoped) - len(bad), len(scoped)),
            '' if not bad else '含糊: ' + ','.join(bad[:6]))
    else:
        add(True, 'V1', '跳过（无 scope 字段）', '')

    out = b.get('outside')
    if isinstance(out, dict):
        hit = [k for k in ('使用者', '对抗者', '维护者') if out.get(k)]
        add(len(hit) == 3, 'X1', '表外三问 %d/3' % len(hit), '')
    else:
        add(True, 'X1', '跳过（无 outside 字段）', '')

    unc_raw = b.get('uncovered')
    rep = b.get('repair')
    rep = rep if isinstance(rep, list) else []
    if unc_raw is None:
        add(True, 'R5', '跳过（无 uncovered）', '')
    elif not isinstance(unc_raw, list):
        add(False, 'R5', 'uncovered 不是数组', '')
    else:
        unc = as_dicts(unc_raw)
        bad_type = len(unc_raw) != len(unc)
        kinds = [u.get('kind') for u in unc]
        bad_kind = [u.get('text', '?') for u in unc if u.get('kind') not in ('可修', '不可修', '需外部')]
        if bad_type:
            bad_kind.append('非对象')
        bad_reason = [u.get('text', '?') for u in unc
                      if u.get('kind') in ('不可修', '需外部') and not u.get('reason')]
        fixable = [u for u in unc if u.get('kind') == '可修']
        need_repair = bool(fixable) and not rep
        ok = not bad_kind and not bad_reason and not need_repair
        detail = ''
        if bad_kind:
            detail += '未分类 %d ' % len(bad_kind)
        if bad_reason:
            detail += '不可修缺原因 %d ' % len(bad_reason)
        if need_repair:
            detail += '可修未修 %d ' % len(fixable)
        add(ok, 'R5', '未覆盖 %d 条 / 修复 %d 条' % (len(unc), len(rep)), detail.strip())

    ordv = b.get('order')
    if isinstance(ordv, dict) and 'criteria_before_artifact' in ordv:
        add(bool(ordv['criteria_before_artifact']), 'ORD1', '判据先于产物',
            '' if ordv['criteria_before_artifact'] else '判据在产物之后声明（事后补）')
    else:
        add(True, 'ORD1', '跳过（无 order 字段）', '')

    m = b.get('metrics')
    if isinstance(m, dict) and m.get('steps') and m.get('claims'):
        ratio = m['steps'] / max(1, m['claims'])
        add(ratio <= 5, 'CH1', '步数/断言 = %.1f' % ratio, '' if ratio <= 5 else '空转嫌疑')
    else:
        add(True, 'CH1', '跳过（无 metrics）', '')

    claims_measured = any('实测' in str(c.get('claim') or '') for c in crit)
    if claims_measured:
        add(bool(demos), 'CE1', '实测声称有演示对应', '' if demos else '声称实测但没有演示记录')

    blob = json.dumps(block, ensure_ascii=False)
    self_claim = re.search(r'我已验证|已全部通过|全部验证通过|无任何问题', blob)
    if self_claim:
        covered = len(b.get('demos') or [])
        add(covered >= len(crit), 'SS1', '禁止自我打分',
            '' if covered >= len(crit) else '自称已全部通过，但演示只覆盖 %d/%d' % (covered, len(crit)))

    score = len(dims_hit) * 2 + len(ext) * 2 + len(amb) + len(crit)
    return score

def main(path, as_json=False, mode=None):
    block = load(path)
    if block is None:
        print('  找不到 v5.json：%s' % path)
        return 2
    score = check(block, mode)
    passed = sum(1 for r in res if r['ok'])
    out = {'path': path, 'score': score, 'checks': res,
           'result': 'PASS' if passed == len(res) else 'FAIL'}
    if as_json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        for r in res:
            print('  [%s] %-5s %-26s %s' % ('PASS' if r['ok'] else 'FAIL', r['code'], r['msg'], r['detail']))
        print('  ---')
        print('  得分=%d ｜ 通过 %d/%d ｜ RESULT: %s' % (score, passed, len(res), out['result']))
    return 0 if out['result'] == 'PASS' else 1

if __name__ == '__main__':
    p = sys.argv[1] if len(sys.argv) > 1 else '.'
    mode = None
    if '--mode' in sys.argv:
        i = sys.argv.index('--mode')
        mode = sys.argv[i + 1] if i + 1 < len(sys.argv) else None
    sys.exit(main(p, '--json' in sys.argv, mode))
