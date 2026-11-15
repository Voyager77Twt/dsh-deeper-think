// 检索判断的纯函数：不碰宿主状态，便于单测。
// 设计原则：机械只产"提示"；是否搜、搜多深由模型在 SEARCH_PLAN 里判断。

export const SEARCH_TOOL_RE = /^web_(call|search|fetch)$|^web_.*(search|fetch|read)/i;
export const PURPOSES = ['orientation', 'targeted', 'cross-check', 'gap', 'saturation'];

export function isSearchTool(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (n === 'web_index') return false; // 只列动作，不算检索
  if (n === 'web_call' || n === 'web_search' || n === 'web_fetch') return true;
  return /^web_.*(search|fetch|read)/.test(n);
}

function callAction(args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  return String((a && (a.action || a.group)) || '').toLowerCase();
}

/** 一次“检索查询”（返回结果列表），不是打开一篇文章。 */
export function isQueryTool(name, args) {
  const n = String(name || '').toLowerCase();
  if (n === 'web_search') return true;
  if (n === 'web_call') {
    const act = callAction(args);
    if (!act) return true; // 未知动作按查询计，避免绕过预算
    return act.startsWith('search') || act.startsWith('web.search');
  }
  return /^web_.*search/.test(n);
}

/** 一次“打开来源/抓取”（一篇文章、一个 URL）。 */
export function isFetchTool(name, args) {
  const n = String(name || '').toLowerCase();
  if (n === 'web_fetch') return true;
  if (n === 'web_call') {
    const act = callAction(args);
    return act.startsWith('read') || act.startsWith('fetch') || act.startsWith('web.read');
  }
  return /^web_.*(fetch|read)/.test(n);
}

/** 从文本里取最后一条 SEARCH_PLAN {...}；解析失败返回 null。 */
export function parsePlan(text) {
  const s = String(text || '');
  let candidate = null;
  // 单行形式最常见：SEARCH_PLAN {"need":"yes",...}
  for (const line of s.split(/\r?\n/)) {
    const i = line.indexOf('SEARCH_PLAN');
    if (i < 0) continue;
    const tail = line.slice(i + 'SEARCH_PLAN'.length).trim().replace(/^[:：]\s*/, '');
    if (!tail.startsWith('{')) continue;
    try { candidate = JSON.parse(tail); } catch (e) {}
  }
  // 兜底：跨行 JSON（非贪婪，足够应付扁平计划）
  if (!candidate) {
    const m = s.match(/SEARCH_PLAN\s*[:：]?\s*(\{[\s\S]*?\})/);
    if (m) { try { candidate = JSON.parse(m[1]); } catch (e) {} }
  }
  if (!candidate || typeof candidate !== 'object') return null;

  const needRaw = String(candidate.need || '').toLowerCase();
  const modeRaw = String(candidate.mode || '').toLowerCase();
  const mode = modeRaw === 'research-first' ? 'research-first'
    : modeRaw === 'build-first' ? 'build-first'
      : null;
  const need = needRaw === 'yes' || needRaw === 'no'
    ? needRaw
    : mode === 'research-first' ? 'yes'
      : mode === 'build-first' ? 'no' : null;
  if (!mode && need === 'yes') return { need, mode: 'research-first', budget: 4, depth: null, why: '', raw: candidate };
  if (!mode && need === 'no') return { need, mode: 'build-first', budget: 1, depth: null, why: '', raw: candidate };
  if (!mode) return null;

  let budget = Number(candidate.budget);
  if (!Number.isFinite(budget)) budget = null;
  if (budget != null) budget = Math.max(1, Math.min(20, Math.round(budget)));

  const depth = PURPOSES.includes(String(candidate.depth || '')) ? String(candidate.depth) : null;
  const why = String(candidate.why || '').slice(0, 200);
  return { need, mode, budget, depth, why, raw: candidate };
}

/** 小而可维护的启发式：只用来提示，不做最终判决。 */
export function classifyHint(text) {
  const s = String(text || '');
  if (/不用搜|别搜|不要搜索|直接做|只改本地|不用查|无需检索/.test(s)) {
    return { kind: 'off', reason: '用户明确不搜' };
  }
  if (/论文|研究|综述|最新|2025|2026|版本|发布|对比|选型|benchmark|现有实现|最佳实践|政策|价格|查一下|搜一下/i.test(s)) {
    return { kind: 'strong', reason: '研究/外部事实信号' };
  }
  if (/实现|开发|搭建|接入|写一个|做一个|迁移|重构/.test(s)) {
    if (/([A-Za-z]:\\|\/|这个文件|当前代码|已有代码|基于现有|只改)/.test(s)) {
      return { kind: 'local', reason: '实现信号但有本地上下文' };
    }
    return { kind: 'implementation', reason: '实现新目标' };
  }
  if (/([A-Za-z]:\\|\/|这个文件|当前代码|只改|重命名|格式化|跑一下)/.test(s)) {
    return { kind: 'local', reason: '本地改动' };
  }
  return { kind: 'none', reason: '' };
}

/** 词表格式：关键词=关联词1,关联词2（与 kw-search-mode 自定义词表兼容）。 */
export function parseLexicon(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const vals = t.slice(i + 1).split(',').map((x) => x.trim()).filter(Boolean);
    if (k && vals.length) map.set(k, vals);
  }
  return map;
}

/** 命中的词表提示（最多 4 个），模型自行取舍。 */
export function lexiconHints(text, map) {
  if (!map || !map.size) return [];
  const s = String(text || '');
  const out = [];
  for (const [k, vals] of map) {
    if (s.includes(k)) out.push(...vals);
  }
  return [...new Set(out)].slice(0, 4);
}

/** 未收录的专名/版本号提示（最多 2 个）；只是提醒，不是规则。 */
export function unknownEntityHints(text) {
  const s = String(text || '');
  const common = new Set(['API', 'URL', 'JSON', 'HTTP', 'HTTPS', 'README', 'DSH', 'AI', 'MCP']);
  const tokens = s.match(/\b[A-Z][A-Za-z0-9_.+-]{2,}\b|\bv?\d+\.\d+(?:\.\d+)?\b/g) || [];
  const out = [];
  for (const t of tokens) {
    if (common.has(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 2) break;
  }
  return out;
}

/** 组装第一段给模型看的检索提示。 */
export function buildPrompt({ hint, lexicon = [], unknown = [] } = {}) {
  const lines = [
    '[检索判断] 动手前先输出一行计划（≤80 tokens），再决定要不要搜：',
    'SEARCH_PLAN {"need":"yes|no","mode":"research-first|build-first","budget":1-8,"depth":"orientation|targeted|cross-check|gap|saturation","why":"一句话"}',
    '- research-first：先搜再做；宿主会等你至少 1 次真实搜索后，才放行写产物。',
    '- build-first：沿用已有先做，收尾补搜。',
    '- 本机/任务完全不需要外部信息：need=no，并写理由。',
  ];
  if (hint && hint.kind !== 'none') {
    lines.push('提示：' + hint.reason + (hint.kind === 'strong' || hint.kind === 'implementation' ? '，建议考虑搜索；最终由你判断。' : '。'));
  }
  if (lexicon.length) lines.push('词表候选（自行判断）：' + lexicon.join('、'));
  if (unknown.length) lines.push('未收录的专名/版本（建议先确认）：' + unknown.join('、'));
  return lines.join('\n');
}

/** 深度提示：根据上一次账本的 purpose / not_covered 给一句建议（不强迫）。 */
export function depthHint(searches) {
  const list = Array.isArray(searches) ? searches : [];
  if (!list.length) return '';
  const last = list[list.length - 1] || {};
  const purpose = String(last.purpose || '');
  if (purpose === 'saturation') return '';

  const gap = String(last.not_covered || '').trim();
  if (gap && gap !== '无') {
    return '模型自报未覆盖：' + gap.slice(0, 80) + '；预算允许时可补搜这个缺口。';
  }

  if (purpose === 'orientation') {
    return '已摸清地形；下一步可进入 targeted：打开官方文档/论文原文。';
  }

  if (purpose === 'targeted') {
    const opened = String(last.opened || '');
    const payload = String(last.payload || '');
    const samePayload = payload && list.slice(0, -1).some((x) => String((x || {}).payload || '') === payload);
    if (!/https?:\/\//.test(opened) && !/fetch|read|open/i.test(opened)) {
      return '只拿到搜索摘要：建议用 web_fetch 打开主来源，拿到可引用的原文。';
    }
    if (samePayload) {
      return '同一判据已有两个来源：可做 cross-check，记录一致或分歧。';
    }
    return '已锁定对象；如有冲突或缺口，可做 cross-check 或 gap。';
  }

  if (purpose === 'gap') {
    return '缺口已清空；如再搜没有新术语/新来源，可标 saturation 收尾。';
  }

  if (purpose === 'cross-check') {
    return '已交叉验证；若仍有未覆盖，做 gap；否则可标 saturation。';
  }
  return '';
}
