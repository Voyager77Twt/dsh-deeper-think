// dsh-deeper-think 宿主：实现 v5 设计（无文件留痕）。
// 流程：每步注入 v5 纪律 → 回合末抽取回答里的结构化块 → 临时 v5.json → v5check → 下一轮注入失败码。
// 硬约束：不建 boundary.md / criteria.md / pre.md / acceptance.md / demo_runs.txt / settle.md。
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installV5 } from './v5.js';

export const name = 'dsh-deeper-think';
export const inject = ['connection'];

const PLUGIN_LIB = path.dirname(fileURLToPath(import.meta.url));
const DBG = path.join(tmpdir(), 'dsh-deeper-think-debug.log');
const dbg = (m) => { try { appendFileSync(DBG, new Date().toISOString() + '\t' + m + '\n', 'utf8'); } catch (e) {} };

const seats = new Map();
const seatOn = (sid) => seats.get(String(sid)) === true || seats.get('__global__') === true;
const sidOf = (agent) => String((agent && (agent.sessionId || agent.id)) || '__global__');

export function apply(ctx, config) {
  try { dbg('apply called'); } catch (e) {}
  if ((config || {}).host === false) return;

  // 开关状态通道：HTTP 路由优先（只需 webServer），RPC 次之
  try {
    ctx.inject(['webServer'], (web) => {
      try {
        web.effect(() => web.webServer.register({
          kind: 'prefix',
          path: '/dsh-deeper-think',
          handler: async (req, res) => {
            try {
              const chunks = [];
              for await (const c of req) chunks.push(c);
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const sid = String(body.sessionId || '__global__');
              seats.set(sid, body.on === true);
              dbg('http set sid=' + sid + ' on=' + body.on);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, on: seats.get(sid) === true }));
            } catch (e) {
              try { res.writeHead(500); res.end('{}'); } catch (e2) {}
            }
          },
        }));
        dbg('http route registered');
      } catch (e) { dbg('http route throw: ' + e.message); }

      try {
        const conn = web.get ? web.get('connection') : undefined;
        if (conn && conn.rpc && typeof conn.rpc.handle === 'function') {
          const handler = async (endpoint, payload) => {
            const body = payload || {};
            const sid = String(body.sessionId || '__global__');
            if (endpoint === 'set') seats.set(sid, body.on === true);
            return { ok: true, on: seats.get(sid) === true };
          };
          conn.rpc.handle('/dsh-deeper-think', handler, { authority: 'trusted-host' });
          dbg('rpc registered');
        }
      } catch (e) { dbg('rpc throw: ' + e.message); }
    });
  } catch (e) { dbg('inject throw: ' + e.message); }

  installV5(ctx, {
    seatOn,
    sidOf,
    dbg,
    pluginDir: PLUGIN_LIB,
    pythonPath: (config && config.pythonPath) || process.env.DSH_DEEPER_THINK_PYTHON,
    runCheck: config && config.runCheck,
  });
}

export default { name, inject, apply };
