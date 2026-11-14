// v5 实现（无文件留痕）：
// 1) 开关状态"按回合粘滞"：turn/start 快照，回合中途关闭不影响本轮，下一轮才生效；
// 2) 校验前移：每个 step/end 若有结构化块立即跑 v5check，失败在同一回合内注入修正要求；
// 3) 回合末兜底：没有结构化块或仍失败时，把结论带到下一轮。
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REMINDER = [
  '[dsh-deeper-think] v5 纪律（无文件留痕；留痕只进回答，产物照常落盘）：',
  '没有 oracle 时用必要条件证伪：清点（源⊆产物且产物⊆源）、变质（变换 T 后关系 R 成立）、一致（两处表示相等）。',
  '块格式：{"boundary":{"范围":"…","量词":"…","例外":"…","优先级":"…","格式":"…","单位":"…","口径":"…","隐含依赖":"…","ambiguity":[{"read_a":"…","read_b":"…","delta":"…","pick":"…","why":"…"}]},"outside":{"使用者":"…","对抗者":"…","维护者":"…"},"inventory":[{"from":"源项","to":"产物项","ok":true}],"invariants":[{"transform":"变换T","relation":"关系R","actual":"PASS 12/12"}],"consistency":[{"a":"表示A","b":"表示B","same":true,"diff":"无"}],"criteria":[{"id":"L1-1","kind":"清点","claim":"…","ref":"#…","source":"推导 1 处…","tol":"±0"}],"demos":[{"id":"L1-1","mutate":"…","expect":"FAIL","actual":"FAIL 具体值","restored":"sha256 …"}],"uncovered":[{"text":"…","kind":"不可修","reason":"…"}],"repair":[]}',
  '硬规则：criteria[].id 与 demos[].id 一一对应；kind ∈ {清点,变质,一致,边界}，至少覆盖清点/变质/一致中的两类；source 必须写成“推导 …=…”或“公式 …=…”（裸数字会判 T4 失败）；demos[].actual 必须以“FAIL”开头并带具体值（写“PASS”或只写“报错了”会判 N1/DE1 失败）。',
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

const runV5CheckImpl = (obj, pythonPath, pluginDir) => {
  const script = path.join(pluginDir, 'checkers', 'v5check.py');
  const file = path.join(tmpdir(), 'dsh-deeper-think-v5-' + Date.now() + '.json');
  try {
    writeFileSync(file, JSON.stringify(obj), 'utf8');
    const pythons = pythonPath ? [pythonPath] : ['python', 'py', 'python3'];
    for (const bin of pythons) {
      try {
        const r = spawnSync(bin, [script, file, '--json'], {
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

export function installV5(ctx, opts) {
  const { seatOn, sidOf, dbg, pluginDir, pythonPath } = opts;
  const runCheck = opts.runCheck || ((obj) => runV5CheckImpl(obj, pythonPath, pluginDir));

  const turnOn = new Map();      // 本回合粘滞的开关状态
  const lastText = new Map();    // 最近一条助手正文
  const pending = new Map();     // 下一轮/下一步要注入的结论或修正要求
  const checked = new Map();     // 防重复校验同一段文本

  const active = (sid) => (turnOn.has(sid) ? turnOn.get(sid) : seatOn(sid));

  const checkText = (sid, text, where) => {
    const obj = extractBlock(text);
    if (!obj) return null;
    const key = String(String(text).length) + ':' + String(text).slice(-80);
    if (checked.get(sid) === key) return null;
    checked.set(sid, key);
    const res = runCheck(obj);
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
          dbg('turn start sid=' + sid + ' on=' + turnOn.get(sid));
          return;
        }
        if (event.type === 'assistant/message') {
          const content = (event.data && event.data.message && event.data.message.content) || [];
          const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
          if (text) lastText.set(sid, text);
          return;
        }
        if (event.type === 'step/end') {
          if (!active(sid)) return;
          const res = checkText(sid, lastText.get(sid) || '', 'step');
          if (res && !res.ok) {
            pending.set(sid, '⚠ 本步骤结构化块未通过：' + res.text +
              ' 本轮结束前必须修正（补齐/改正后重新给出完整 json 块），不要只解释。');
          }
          return;
        }
        if (event.type === 'turn/end') {
          const wasOn = active(sid);
          turnOn.delete(sid);
          checked.delete(sid);
          if (!wasOn) return;
          const text = lastText.get(sid) || '';
          lastText.delete(sid);
          const res = checkText(sid, text, 'turn');
          pending.set(sid, res ? res.text : 'v5check：未找到结构化块（回答里需要 ```json 且含 boundary 字段）。');
          dbg('v5 turn-end: ' + pending.get(sid));
        }
      } catch (e) {}
    });
  } catch (e) {}

  try {
    ctx.on && ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      try {
        if (!decision || decision.kind === 'reject') return decision;
        const sid = sidOf(payload && payload.agent);
        if (!active(sid)) return decision;
        let text = REMINDER;
        const p = pending.get(sid);
        if (p) { text += '\n' + p; pending.delete(sid); }
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        return { ...decision, messages: messages.concat([mkMsg(text)]) };
      } catch (e) { return decision; }
    });
  } catch (e) {}

  try {
    ctx.on && ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const sid = sidOf(exec && exec.agent);
        if (!active(sid)) return next();
        const tool = String((exec && exec.name) || '');
        if (!['write', 'edit'].includes(tool)) return next();
        let args = (exec && exec.arguments) || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
        const target = args.file_path || args.path || args.filePath || '';
        if (isTrace(target)) {
          return {
            kind: 'deny',
            reason: 'v5 模式不建留痕文件：把 boundary/criteria/demos 写进回答的 ```json 结构化块，产物照常落盘。',
            info: { name: 'dsh-deeper-think', code: 'DSH_DEEPER_THINK_V5_NO_FILES' },
          };
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
        if (result && result.isError) return downstream;
        const tool = String((exec && exec.name) || '');
        if (['write', 'edit'].includes(tool)) {
          pending.set(sid, '产物已写出。下一步：逐条跑演示（改坏→FAIL 具体输出），把 demos/uncovered/repair 补进结构化块，并确保 step 结束时通过 v5check。');
        }
        return downstream;
      } catch (e) { return next(); }
    });
  } catch (e) {}
}
