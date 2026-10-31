#!/usr/bin/env bun
// pool-router.ts
// Local A2A Load Balancer / Worker Pool Router for Port 9900
// Dispatches incoming A2A calls to the first available/idle HAgent worker (9901, 9902, 9903).

const PORT = parseInt(process.env.ROUTER_PORT || '9900', 10);
const HOST = process.env.ROUTER_HOST || '0.0.0.0';
const WORKER_PORTS = (process.env.WORKER_PORTS || '9901,9902,9903')
  .split(',')
  .map((p) => parseInt(p.trim(), 10))
  .filter((p) => !isNaN(p));

interface WorkerHealth {
  port: number;
  online: boolean;
  active: number;
  max: number;
  agentId?: string;
  agentName?: string;
}

async function checkWorker(port: number): Promise<WorkerHealth> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { port, online: false, active: 999, max: 0 };
    }
    const data = (await res.json()) as any;
    const slots = data.slots || { active: 0, max: 1 };
    return {
      port,
      online: true,
      active: Number(slots.active ?? 0),
      max: Number(slots.max ?? 1),
      agentId: data.agentId,
      agentName: data.agent,
    };
  } catch {
    return { port, online: false, active: 999, max: 0 };
  }
}

async function selectBestWorker(): Promise<WorkerHealth | null> {
  const healths = await Promise.all(WORKER_PORTS.map(checkWorker));
  const onlineWorkers = healths.filter((w) => w.online);

  if (onlineWorkers.length === 0) {
    return null;
  }

  // 1. Look for idle worker (active == 0)
  const idle = onlineWorkers.filter((w) => w.active === 0);
  if (idle.length > 0) {
    return idle[0];
  }

  // 2. Otherwise pick worker with lowest active count
  onlineWorkers.sort((a, b) => a.active / a.max - b.active / b.max);
  return onlineWorkers[0];
}

console.log(`🧭 Starting HAgent Pool Router on http://${HOST}:${PORT}...`);
console.log(`🎯 Routing pool across workers: [${WORKER_PORTS.join(', ')}]`);

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-ID, X-Agent-Name',
        },
      });
    }

    // Health check of the pool router itself
    if (method === 'GET' && (path === '/health' || path === '/status')) {
      const workers = await Promise.all(WORKER_PORTS.map(checkWorker));
      const totalActive = workers.reduce((acc, w) => acc + (w.online ? w.active : 0), 0);
      const totalMax = workers.reduce((acc, w) => acc + (w.online ? w.max : 0), 0);
      return new Response(
        JSON.stringify(
          {
            status: 'healthy',
            role: 'pool-router',
            port: PORT,
            totalWorkers: WORKER_PORTS.length,
            onlineWorkers: workers.filter((w) => w.online).length,
            totalSlots: { active: totalActive, max: totalMax },
            workers,
          },
          null,
          2
        ),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // Agent Card discovery
    if (method === 'GET' && (path === '/.well-known/agent.json' || path === '/agent.json' || path === '/.well-known/agent-card.json')) {
      const workers = await Promise.all(WORKER_PORTS.map(checkWorker));
      const firstOnline = workers.find((w) => w.online);
      if (firstOnline) {
        try {
          const cardRes = await fetch(`http://127.0.0.1:${firstOnline.port}/.well-known/agent.json`);
          if (cardRes.ok) {
            const card = (await cardRes.json()) as any;
            const totalActive = workers.reduce((acc, w) => acc + (w.online ? w.active : 0), 0);
            const totalMax = workers.reduce((acc, w) => acc + (w.online ? w.max : 0), 0);
            card.slots = { active: totalActive, max: totalMax };
            return new Response(JSON.stringify(card, null, 2), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
          }
        } catch {}
      }
    }

    // Dispatch request to best available worker
    const bestWorker = await selectBestWorker();
    if (!bestWorker) {
      return new Response(
        JSON.stringify({
          error: 'No HAgent workers available in pool',
          worker_ports: WORKER_PORTS,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Router] ${method} ${path} -> forwarding to port ${bestWorker.port} (active: ${bestWorker.active}/${bestWorker.max})`);

    const targetUrl = `http://127.0.0.1:${bestWorker.port}${url.pathname}${url.search}`;

    try {
      const headers = new Headers(req.headers);
      headers.set('X-Forwarded-For', req.headers.get('x-forwarded-for') || req.headers.get('host') || '127.0.0.1');
      headers.set('X-Router-Port', String(PORT));

      const forwardRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.body,
        // @ts-ignore
        duplex: 'half',
      });

      return new Response(forwardRes.body, {
        status: forwardRes.status,
        statusText: forwardRes.statusText,
        headers: forwardRes.headers,
      });
    } catch (err: any) {
      console.error(`[Router Error] Forwarding to port ${bestWorker.port} failed:`, err.message);
      return new Response(
        JSON.stringify({
          error: `Forwarding failed to worker on port ${bestWorker.port}`,
          details: err.message,
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
});
