/**
 * RecruitExport Worker (docs/05).
 *
 * Stateless; all state in Supabase and KV. Holds the only copies of the
 * enrichment key, the Supabase service key, the JWT secret and the Dodo webhook
 * secret — none of which ever reach the extension (docs/08 §1).
 */

import { Hono } from 'hono';
import type { HealthResponse } from '@recruitexport/shared';
import { VERSION, type Env } from './env';
import { errorResponse } from './lib/errors';
import { corsMiddleware, globalRateLimit, withDb, type App } from './lib/middleware';
import { authRoutes } from './routes/auth';
import { configRoutes } from './routes/config';
import { enrichRoutes } from './routes/enrich';
import { meRoutes } from './routes/me';
import { quotaRoutes } from './routes/quota';
import { telemetryRoutes } from './routes/telemetry';
import { webhookRoutes } from './routes/webhooks';

const app = new Hono<App>();

app.use('*', corsMiddleware());
app.use('*', withDb);

// The webhook endpoint is authenticated by signature, not by JWT, and Dodo's
// retry behaviour must not be shaped by our IP limiter — so it is mounted
// before the global rate limit.
app.route('/webhooks', webhookRoutes);

app.use('*', globalRateLimit);

app.get('/healthz', (c) => c.json<HealthResponse>({ ok: true, version: VERSION }));

app.route('/auth', authRoutes);
app.route('/me', meRoutes);
app.route('/config', configRoutes);
app.route('/quota', quotaRoutes);
app.route('/enrich', enrichRoutes);
app.route('/telemetry', telemetryRoutes);

app.notFound((c) => c.json({ error: 'not_found', message: 'No such endpoint.' }, 404));
app.onError((err, c) => errorResponse(c, err));

export default app satisfies { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };
