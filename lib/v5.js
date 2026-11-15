// v5 实现（无文件留痕）：
// 1) 开关状态"按回合粘滞"：turn/start 快照，回合中途关闭不影响本轮，下一轮才读新状态；
// 2) 校验前移：每个 step/end 若有结构化块立即跑 v5check，失败在同一回合内注入修正要求；
// 3) 回合末兜底：没有结构化块或仍失败时，把结论带到下一轮；
// 4) 检索判断：模型写 SEARCH_PLAN 决定 need/mode/budget/depth；宿主只提示、计量、在
//    research-first 时拦住"没搜就写"；词表只做提示，不替模型决定。
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isSearchTool,
  isQueryTool,
  isFetchTool,
  parsePlan,
  classifyHint,
  lexiconHints,
  unknownEntityHints,
  buildPrompt,
  depthHint,
} from './search-policy.js';

const REMINDER = [
  '[dsh-deeper-think] v5 纪律（无文件留痕；留痕只进回答，产物照常落盘）：',
  '没有 oracle 时用必要条件证伪：清点（源⊆产物且产物⊆源）、变质（变换 T 后关系 R 成立）、一致（两处表示相等）。',
  '块格式：{"boundary":{"范围":"…","量词":"…","例外":"…","优先级":"…","格式":"…","单位":"…","口径":"…","隐含依赖":"…","ambiguity":[{"read_a":"…","read_b":"…","delta":"…","pick":"…","why":"…"}]},"outside":{"使用者":"…","对抗者":"…","维护者":"…"},"inventory":[{"from":"源项","to":"产物项","ok":true}],"invariants":[{"transform":"变换T","relation":"关系R","actual":"PASS 12/12"}],"consistency":[{"a":"表示A","b":"表示B","same":true,"diff":"无"}],"searches":[{"query":"检索式","purpose":"targeted","opened":"web_call search.run","excerpt":"原文摘录","payload":"L1-1","not_covered":"没覆盖什么"}],"criteria":[{"id":"L1-1","kind":"清点","claim":"…","ref":"#…","source":"推导 1 处…","tol":"±0"}],"demos":[{"id":"L1-1","mutate":"…","expect":"FAIL","actual":"FAIL 具体值","restored":"sha256 …"}],"uncovered":[{"text":"…","kind":"不可修","reason":"…"}],"repair":[]}',
  '硬规则：criteria[].id 与 demos[].id 一一对应；kind ∈ {清点,变质,一致,边界}，至少覆盖清点/变质/一致中的两类；source 必须写成“推导 …=…”或“公式 …=…”（裸数字会判 T4 失败）；demos[].actual 必须以“FAIL”开头并带具体值（写“PASS”或只写“报错了”会判 N1/DE1 失败）。',
  '检索账本：有搜索时 searches 每条写 query/purpose/opened/excerpt/payload/not_covered；purpose ∈ {orientation,targeted,cross-check,gap,saturation}。research-first 回合宿主会要求至少 1 条。',
  '做不到的节写 {"na":"原因"}：源不可枚举写 inventory，单产物写 consistency，无不变性写 invariants。',
  '成本纪律：数据 <20 条时不要写额外验证脚本；演示 ≤3 条、一次批量跑完；正文 ≤120 行。',
  '不要创建 boundary.md / criteria.md / pre.md / acceptance.md / demo_runs.txt / settle.md。',
].join('\n');

const TRACE_FILES = ['boundary.md', 'criteria.md', 'pre.md', 'acceptance.md', 'demo_runs.txt', 'settle.md'];
const isTrace = (p) => TRACE_FILES.includes(String(p || '').split(/[\\/]/).pop().toLowerCase());
const mkMsg = (text) => ({
  role: 'user',
  id: 'dsh-deeper-think-v5-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
  source: { kind: 'dsh-deeper-think' },
  content: [{ type: 'text', text }],
});

const extractBlock = (text) => {
  const re = /```json\s*([\s\S]*?)```/g;
  let m;
  let found = null;
  while ((m = re.exec(String(text || ''))) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && obj.boundary) found = obj;
    } catch (e) {}
  }
  return found;
};

const runV5CheckImpl = (obj, pythonPath, pluginDir, mode) => {
  const script = path.join(pluginDir, 'checkers', 'v5check.py');
  const file = path.join(tmpdir(), 'dsh-deeper-think-v5-' + Date.now() + '.json');
  try {
    writeFileSync(file, JSON.stringify(obj), 'utf8');
    const pythons = pythonPath ? [pythonPath] : ['python', 'py', 'python3'];
    for (const bin of pythons) {
      try {
        const args = [script, file, '--json'];
        if (mode) args.push('--mode', mode);
        const r = spawnSync(bin, args, {
          encoding: 'utf8', timeout: 8000, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        if (r.error) continue;
        const out = String(r.stdout || '');
        const i = out.indexOf('{');
        if (i < 0) continue;
        const data = JSON.parse(out.slice(i));
        const checks = data.checks || [];
        const bad = checks.filter((c) => !c.ok);
        const fails = bad.map((c) => c.code);
        const detail = bad.slice(0, 2).map((c) => c.code + '[' + String(c.detail || c.msg || '').slice(0, 60) + ']').join(' ');
        return {
          ok: fails.length === 0,
          fails,
          text: fails.length === 0
            ? 'v5check：' + checks.length + '/' + checks.length + ' 通过。'
            : 'v5check：' + (checks.length - fails.length) + '/' + checks.length + ' 通过；失败 ' + fails.join(',') + (detail ? '；' + detail : '') + '。',
        };
      } catch (e) {}
    }
    return null;
  } finally {
    try { unlinkSync(file); } catch (e) {}
  }
};

const textOf = (m) => {
  const c = m && m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
};

const SYNTHETIC_SOURCES = new Set(['dsh-deeper-think', 'runtime-context', 'time-context', 'agent-instructions']);
const lastUserText = (messages) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m) continue;
    if (m.source && SYNTHETIC_SOURCES.has(m.source.kind)) continue;
    if (m.role === 'user') {
      const t = textOf(m).trim();
      if (t) return t;
    }
  }
  return '';
};

const newSearchState = (ceiling) => ({
  plan: null,
  calls: [],
  fetches: [],
  inflightQueries: 0,
  inflightFetches: 0,
  ceiling,
  ledger: false,
  lastSearches: null,
  denied: 0,
  planDenied: 0,
  prompted: false,
  newPart: false,
  newPartPrompted: false,
  searchFails: 0,
  depthFor: '',
  depthHintText: '',
  shownDepthFor: '',
  triggered: new Set(),
  lastText: '',
});

export function installV5(ctx, opts) {
  const { seatOn, sidOf, dbg, pluginDir, pythonPath } = opts;
  const runCheck = opts.runCheck || ((obj, mode) => runV5CheckImpl(obj, pythonPath, pluginDir, mode));
  const searchCfg = opts.search || {};
  const decisionOf = () => (searchCfg.decision === 'strict' ? 'strict' : 'model');
  const ceilingOf = () => Math.max(1, Math.min(20, Number(searchCfg.ceiling) || 8));
  const fetchCeilingOf = () => Math.max(1, Math.min(200, Number(searchCfg.fetchCeiling) || 24));
  const lexiconOf = () => (searchCfg.lexicon instanceof Map ? searchCfg.lexicon : new Map());
  const triggersOf = () => (Array.isArray(searchCfg.triggers) ? searchCfg.triggers.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 50) : []);

  const turnOn = new Map();      // 本回合粘滞的开关状态
  const lastText = new Map();    // 最近一条助手正文
  const pending = new Map();     // 下一轮/下一步要注入的结论或修正要求
  const checked = new Map();     // 防重复校验同一段文本
  const searchStates = new Map(); // 每回合的检索状态

  const active = (sid) => (turnOn.has(sid) ? turnOn.get(sid) : seatOn(sid));
  const stOf = (sid) => {
    if (!searchStates.has(sid)) searchStates.set(sid, newSearchState(ceilingOf()));
    return searchStates.get(sid);
  };
  const queue = (sid, msg) => {
    if (!msg) return;
    const old = pending.get(sid);
    pending.set(sid, old ? old + '\n' + msg : msg);
  };
  const effectiveCeiling = (st) => {
    const ceiling = ceilingOf();
    const own = st.plan && st.plan.budget ? st.plan.budget : ceiling;
    return Math.max(1, Math.min(ceiling, own));
  };
  const modeOf = (st) => (st.plan && st.plan.mode === 'research-first' ? 'research-first' : 'build-first');

  const checkText = (sid, text, where, mode, force) => {
    const obj = extractBlock(text);
    if (!obj) return null;
    const key = String(String(text).length) + ':' + String(text).slice(-80);
    if (!force && checked.get(sid) === key) return null;
    checked.set(sid, key);
    const res = runCheck(obj, mode);
    if (!res) return null;
    dbg('v5 check (' + where + '): ' + res.text);
    return res;
  };

  try {
    ctx.on && ctx.on('session/event', (session, event) => {
      try {
        if (!event) return;
        const sid = String((session && (session.sessionId || session.id)) || '__global__');
        if (event.type === 'turn/start') {
          turnOn.set(sid, seatOn(sid));
          lastText.delete(sid);
          checked.delete(sid);
          searchStates.set(sid, newSearchState(ceilingOf()));
          dbg('turn start sid=' + sid + ' on=' + turnOn.get(sid));
          return;
        }
        if (event.type === 'assistant/message') {
          const content = (event.data && event.data.message && event.data.message.content) || [];
          const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
          if (text) {
            lastText.set(sid, text);
            const st = stOf(sid);
            st.lastText = text;
            const plan = parsePlan(text);
            if (plan) {
              st.plan = plan;
              dbg('search plan sid=' + sid + ' mode=' + plan.mode + ' need=' + plan.need + ' budget=' + plan.budget + ' depth=' + plan.depth + ' why=' + plan.why);
            }
          }
          return;
        }
        if (event.type === 'step/end') {
          if (!active(sid)) return;
          const st = stOf(sid);
          const text = lastText.get(sid) || st.lastText || '';
          const obj = extractBlock(text);
          if (obj) {
            st.ledger = Array.isArray(obj.searches) && obj.searches.length > 0;
            st.lastSearches = Array.isArray(obj.searches) ? obj.searches : null;
            st.depthHintText = st.ledger ? (depthHint(obj.searches) || '') : '';
            st.depthFor = st.ledger ? JSON.stringify(obj.searches).slice(-120) : '';
          } else {
            st.ledger = false;
            st.lastSearches = null;
            st.depthHintText = '';
            st.depthFor = '';
          }
          st.inflightQueries = 0;
          st.inflightFetches = 0;
          if (st.plan && st.plan.mode === 'research-first' && !st.ledger) {
            queue(sid, '⚠ 研究型回合缺少检索账本：searches 至少 1 条（query/purpose/opened/excerpt/payload/not_covered），否则本轮结束前无法通过 D2。');
          }
          const res = checkText(sid, text, 'step', st.plan ? st.plan.mode : null);
          if (res && !res.ok) {
            queue(sid, '⚠ 本步骤结构化块未通过：' + res.text +
              ' 本轮结束前必须修正（补齐/改正后重新给出完整 json 块），不要只解释。');
          }
          return;
        }
        if (event.type === 'turn/end') {
          const wasOn = active(sid);
          const st = stOf(sid);
          turnOn.delete(sid);
          checked.delete(sid);
          if (!wasOn) { searchStates.delete(sid); return; }
          const text = lastText.get(sid) || st.lastText || '';
          lastText.delete(sid);
          const hasBlock = !!extractBlock(text);
          const res = checkText(sid, text, 'turn', st.plan ? st.plan.mode : null, true);
          st.inflightQueries = 0;
          st.inflightFetches = 0;
          const summary = '检索：' + (st.plan ? st.plan.mode + '/need=' + st.plan.need : '未写 SEARCH_PLAN') +
            '；查询 ' + st.calls.length + ' 次；来源 ' + st.fetches.length + ' 个；账本 ' + (st.ledger ? '有' : '无');
          const verdict = res ? res.text
            : hasBlock ? 'v5check：检查器未运行（缺少 Python 或脚本错误）。'
              : 'v5check：未找到结构化块（回答里需要 ```json 且含 boundary 字段）。';
          queue(sid, verdict + '；' + summary);
          dbg('v5 turn-end: ' + pending.get(sid));
          searchStates.delete(sid);
        }
      } catch (e) {}
    });
  } catch (e) {}

  try {
    ctx.on && ctx.on('agent/pre-step', async (payload, next) => {
      const decisionObj = await next();
      try {
        if (!decisionObj || decisionObj.kind === 'reject') return decisionObj;
        const sid = sidOf(payload && payload.agent);
        if (!active(sid)) return decisionObj;
        const st = stOf(sid);
        const messages = Array.isArray(decisionObj.messages) ? decisionObj.messages : [];
        const userText = lastUserText(messages) || lastUserText(payload && payload.messages);

        let add = REMINDER;
        if (!st.prompted) {
          st.prompted = true;
          const hint = userText ? classifyHint(userText) : { kind: 'none', reason: '' };
          const lex = userText ? lexiconHints(userText, lexiconOf()) : [];
          const unknown = userText ? unknownEntityHints(userText) : [];
          add += '\n' + buildPrompt({ hint, lexicon: lex, unknown });
          const trig = triggersOf().find((w) => userText && userText.includes(w) && !st.triggered.has(w));
          if (trig) {
            st.triggered.add(trig);
            add += '\n【自定义触发词】遇到「' + trig + '」：建议先搜一次再决定；是否搜仍由你判断。';
          }
          st.hint = hint;
          dbg('search hint sid=' + sid + ' kind=' + hint.kind + ' reason=' + hint.reason + ' userText=' + (userText ? 'yes' : 'no'));
        }
        if (st.plan) {
          const eff = effectiveCeiling(st);
          if (st.plan.mode === 'research-first' && (st.calls.length + st.fetches.length) === 0) {
            add += '\n【检索优先】本轮是 research-first：先调用 web_call/web_search 做至少 1 次真实检索，再写产物；宿主会在检索前拦住 write/edit。';
          }
          if (st.calls.length > 0 && st.calls.length >= Math.ceil(eff * 0.8)) {
            add += '\n【预算】真实搜索 ' + st.calls.length + '/' + eff + '：接近上限，优先补关键缺口，不要泛搜。';
          }
          if (st.depthHintText && st.depthFor && st.depthFor !== st.shownDepthFor) {
            add += '\n【深度】' + st.depthHintText;
            st.shownDepthFor = st.depthFor;
          }
        }
        if (st.newPart && !st.newPartPrompted) {
          st.newPartPrompted = true;
          add += '\n【新部件】检测到新文件/新依赖：先查有没有现成方案或官方文档，再继续写。';
        }
        if (decisionOf() === 'strict' && st.plan && st.plan.need === 'no' && st.hint && (st.hint.kind === 'strong' || st.hint.kind === 'implementation') && (st.calls.length + st.fetches.length) === 0) {
          add += '\n【strict】检测到强信号但计划为不搜：宿主会拦住第一次写，要求至少 1 次真实检索。';
        }
        const p = pending.get(sid);
        if (p) { add += '\n' + p; pending.delete(sid); }
        return { ...decisionObj, messages: messages.concat([mkMsg(add)]) };
      } catch (e) { return decisionObj; }
    });
  } catch (e) {}

  try {
    ctx.on && ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const sid = sidOf(exec && exec.agent);
        if (!active(sid)) return next();
        const st = stOf(sid);
        const tool = String((exec && exec.name) || '');
        let args = (exec && exec.arguments) || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
        const target = args.file_path || args.path || args.filePath || '';

        if (['write', 'edit'].includes(tool) && isTrace(target)) {
          return {
            kind: 'deny',
            reason: 'v5 模式不建留痕文件：把 boundary/criteria/demos 写进回答的 ```json 结构化块，产物照常落盘。',
            info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_V5_NO_FILES' },
          };
        }

        if (isQueryTool(tool, args)) {
          const eff = effectiveCeiling(st);
          if (st.calls.length + (st.inflightQueries || 0) >= eff) {
            return {
              kind: 'deny',
              reason: '检索查询预算已到上限（' + eff + ' 次）：停止泛搜，把未覆盖写进 uncovered 并收尾；确需再搜请在 SEARCH_PLAN 里提高 budget。',
              info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_SEARCH_BUDGET' },
            };
          }
          st.inflightQueries = (st.inflightQueries || 0) + 1;
          return next();
        }
        if (isFetchTool(tool, args)) {
          const feff = fetchCeilingOf();
          if (st.fetches.length + (st.inflightFetches || 0) >= feff) {
            return {
              kind: 'deny',
              reason: '来源抓取预算已到上限（' + feff + ' 个）：停止打开新来源，把未覆盖写进 uncovered 并收尾。',
              info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_FETCH_BUDGET' },
            };
          }
          st.inflightFetches = (st.inflightFetches || 0) + 1;
          return next();
        }

        if (['write', 'edit'].includes(tool)) {
          if (!st.plan && st.planDenied < 2) {
            st.planDenied += 1;
            return {
              kind: 'deny',
              reason: '先输出一行 SEARCH_PLAN（need/mode/budget/depth/why），再写产物；本轮由你判断要不要搜。',
              info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_NEED_PLAN' },
            };
          }
          if (st.plan && st.plan.mode === 'research-first' && (st.calls.length + st.fetches.length) === 0) {
            st.denied += 1;
            if (st.denied >= 4) {
              st.plan.mode = 'build-first';
              st.plan.need = 'no';
              queue(sid, '检索闸门连续拦住 4 次且没有搜索：已降级为 build-first，允许继续；uncovered 必须写明“未检索/工具不可用”。');
              return next();
            }
            return {
              kind: 'deny',
              reason: 'research-first 要求先搜索再动手：请先调用 web_call/web_search 做至少 1 次真实检索；若确实不需要，改写 SEARCH_PLAN 为 build-first 并写理由。',
              info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_SEARCH_FIRST' },
            };
          }
          if (decisionOf() === 'strict' && st.plan && st.plan.need === 'no' && st.hint && (st.hint.kind === 'strong' || st.hint.kind === 'implementation') && (st.calls.length + st.fetches.length) === 0) {
            st.denied += 1;
            return {
              kind: 'deny',
              reason: 'strict 模式：检测到强信号，至少做 1 次真实检索后再写。',
              info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_STRICT_SEARCH' },
            };
          }
          if (target && !isTrace(target) && !existsSync(target)) {
            st.newPart = true;
          }
        }
        return next();
      } catch (e) { return next(); }
    });
  } catch (e) {}

  try {
    ctx.on && ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        const downstream = await next();
        const sid = sidOf(exec && exec.agent);
        if (!active(sid)) return downstream;
        const st = stOf(sid);
        const tool = String((exec && exec.name) || '');
        let sargs = (exec && exec.arguments) || {};
        if (typeof sargs === 'string') { try { sargs = JSON.parse(sargs); } catch (e) { sargs = {}; } }
        if (isQueryTool(tool, sargs) || isFetchTool(tool, sargs)) {
          const q = isQueryTool(tool, sargs);
          if (q) {
            st.inflightQueries = Math.max(0, (st.inflightQueries || 0) - 1);
            st.calls.push(tool);
          } else {
            st.inflightFetches = Math.max(0, (st.inflightFetches || 0) - 1);
            st.fetches.push(tool);
          }
          if (result && result.isError) st.searchFails += 1;
          dbg('search call sid=' + sid + ' tool=' + tool + ' kind=' + (q ? 'query' : 'fetch') + ' q=' + st.calls.length + ' f=' + st.fetches.length + ' error=' + !!(result && result.isError));
          if (st.searchFails >= 2 && st.plan && st.plan.mode === 'research-first') {
            st.plan.mode = 'build-first';
            st.plan.need = 'no';
            queue(sid, '搜索工具连续失败，已降级为 build-first：允许继续，但 uncovered 必须写明“未检索/工具不可用”。');
          }
        }
        if (result && result.isError) return downstream;
        if (['write', 'edit'].includes(tool)) {
          queue(sid, '产物已写出。下一步：逐条跑演示（改坏→FAIL 具体输出），把 demos/uncovered/repair 补进结构化块，并确保 step 结束时通过 v5check。');
        }
        return downstream;
      } catch (e) { return next(); }
    });
  } catch (e) {}
}
