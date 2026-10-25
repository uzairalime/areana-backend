import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma';
import { PrismaTimeoutFilter } from './common/prisma-timeout.filter';

// Round 4, P-S2: every production boot guard used to be keyed on
// NODE_ENV === 'production' alone — one wrong env value (Compose
// overriding NODE_ENV, or `start:dev` on the box) silently disabled
// all of them at once. The rule is now: FAIL when NODE_ENV is
// 'production' or when it is set to an unrecognised value (an
// explicitly wrong value is a deploy misconfiguration, not local
// dev); WARN when it is unset or an explicit development/test.
// Local dev (NODE_ENV unset, system TZ Asia/Karachi, CORS '*') keeps
// booting for the CORS/SMTP guards — the guards bite on deploys,
// not on laptops. EXCEPTION (Round 5, D5-B8): the TZ guard fails on
// UNSET too, matching the docs/DEPLOY.md §6 table — a deploy that
// drops NODE_ENV must not boot in UTC on warnings alone. The
// his-Mac case still boots: the TZ check uses the EFFECTIVE zone
// (TZ env, else the host system zone), so a Pakistan laptop with
// NODE_ENV unset and system zone Asia/Karachi passes.
const NODE_ENV = process.env.NODE_ENV;
const KNOWN_ENVS = ['development', 'test', 'production'];
const bootMustFail =
  NODE_ENV === 'production' || (NODE_ENV !== undefined && !KNOWN_ENVS.includes(NODE_ENV));
// TZ (process + Postgres) fails on production, unset, or
// unrecognised — the DEPLOY §6 table rule. CORS/SMTP keep the
// narrower bootMustFail rule (warn on unset).
const tzMustFail = NODE_ENV !== 'development' && NODE_ENV !== 'test';

function bootGuard(message: string) {
  if (bootMustFail) throw new Error(`[BOOT] ${message}`);
  console.warn(`[BOOT WARNING] ${message}`);
}

function tzGuard(message: string) {
  if (tzMustFail) throw new Error(`[BOOT] ${message}`);
  console.warn(`[BOOT WARNING] ${message}`);
}

/**
 * Round 4, P-S3: TRUST_PROXY parsing had three traps — 'false' crashed
 * boot (Express rejects it as an IP), '0' silently pooled every visitor
 * under the proxy IP while skipping the warning (truthy string, trusts
 * nobody), and 'true'/'1' trust the leftmost X-Forwarded-For entry,
 * which a caller can spoof if the proxy appends rather than strips
 * inbound headers (buys OTP/throttle evasion, NOT session hijack —
 * refresh-token reuse detection is not IP-keyed). Accepted values:
 * unset (warn in production), a hop count >= 1, 'true' (all proxies,
 * with the spoofing warning), or a comma list of IPs/CIDRs. Anything
 * else — 'false', '0', garbage — fails boot with a clear message.
 */
function parseTrustProxy(raw: string): number | boolean | string {
  const v = raw.trim();
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 1) {
      // Round 5, D5-S33: an unbounded hop count is 'true' with no
      // warning — trusting 999 hops trusts every spoofed header.
      // More than 5 hops is implausible for this deployment.
      if (n > 5) {
        console.warn(
          `[BOOT WARNING] TRUST_PROXY=${n} trusts ${n} proxy hops — effectively trusting every X-Forwarded-For entry. Prefer TRUST_PROXY=1.`,
        );
      }
      return n;
    }
    throw new Error(
      '[BOOT] TRUST_PROXY=0 trusts no proxy — every visitor would share the proxy IP and pool rate limits. Set TRUST_PROXY=1 (one proxy hop) instead.',
    );
  }
  if (v === 'true') {
    console.warn(
      '[BOOT WARNING] TRUST_PROXY=true trusts every proxy hop — a caller can spoof X-Forwarded-For and evade per-IP OTP caps/throttling unless the proxy strips inbound X-Forwarded-For headers. Prefer TRUST_PROXY=1.',
    );
    return true;
  }
  // Round 5, D5-S33: the old regex accepted values Express rejects
  // at request time (octets like 999, CIDRs like /99) — boot passed,
  // then proxy-addr 500'd every request. Validate exactly what
  // Express accepts: IPv4 octets 0–255 with /0–32, IPv6 groups with
  // /0–128.
  const isIPv4 = (p: string): boolean => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/.exec(p);
    if (!m) return false;
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return false;
    if (m[5] !== undefined) {
      const cidr = Number(m[5]);
      if (cidr < 0 || cidr > 32) return false;
    }
    return true;
  };
  const isIPv6 = (p: string): boolean => {
    const m = /^([0-9a-fA-F:]+)(?:\/(\d+))?$/.exec(p);
    if (!m || !m[1].includes(':')) return false;
    if (!/^[0-9a-fA-F:]+$/.test(m[1])) return false;
    if (m[2] !== undefined) {
      const cidr = Number(m[2]);
      if (cidr < 0 || cidr > 128) return false;
    }
    return true;
  };
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => isIPv4(p) || isIPv6(p))) return v;
  throw new Error(
    `[BOOT] TRUST_PROXY=${raw} is not valid — use a hop count (1), 'true', or a comma list of proxy IPs/CIDRs. 'false' and '0' are rejected: the first crashes Express, the second silently pools all users under one IP.`,
  );
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  app.useGlobalFilters(new PrismaTimeoutFilter());

  // Every date helper in this codebase (startOfToday,
  // minutesSinceMidnight, PKT day bounds) assumes the process runs in
  // Asia/Karachi. A production process in any other TZ silently shifts
  // every play date, slot window, and billing boundary. The check uses
  // the EFFECTIVE timezone (TZ env, else the host's system zone via
  // Intl) so a laptop in Pakistan with TZ unset still passes, while a
  // container in UTC fails — including when NODE_ENV is unset (D5-B8).
  const effectiveTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (effectiveTz !== 'Asia/Karachi') {
    tzGuard(
      `TZ must be Asia/Karachi (effective: ${effectiveTz}) — all date math assumes Pakistan time.`,
    );
  }

  // CORS: the default origin is '*' (config.ts), which is fine for
  // local dev but must never ship — production requires an explicit,
  // env-driven origin list, or the API boots open to every site. The
  // list is already trimmed in config.ts, so a spaced '" *"' is now
  // caught here instead of slipping past the guard.
  const corsOrigin = config.get<string[]>('corsOrigin') ?? [];
  if (bootMustFail) {
    const open = corsOrigin.length === 0 || corsOrigin.includes('*');
    if (open) {
      throw new Error(
        '[BOOT] CORS_ORIGIN must list explicit origins in production (got * or unset) — refusing to boot open to every site.',
      );
    }
  } else if (corsOrigin.length === 0 || corsOrigin.includes('*')) {
    console.warn('[BOOT WARNING] CORS_ORIGIN is open (*) — fine for local dev, never for a deploy.');
  }

  // Round 4, P-B2 + P-S15: prod deploys must not silently fall back to
  // the Mailpit defaults — a forgotten SMTP_HOST used to mean OTP
  // codes sent to localhost:1025 (nothing listening) while Joi passed.
  // DATABASE_URL is already required by Joi; SMTP_HOST and CORS_ORIGIN
  // are now required explicitly in production too.
  if (bootMustFail) {
    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost || smtpHost === 'localhost') {
      throw new Error(
        '[BOOT] SMTP_HOST must be set to a real SMTP host in production (got unset/localhost) — the Mailpit default would silently swallow OTP codes.',
      );
    }
  } else {
    // Round 5, D5-S30: the SMTP check used to live ONLY inside the
    // fail branch, so unset NODE_ENV + forgotten SMTP_HOST booted
    // with localhost:1025 and no SMTP warning at all (TZ/CORS both
    // had else-warning branches). Warn here too.
    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost || smtpHost === 'localhost') {
      console.warn(
        '[BOOT WARNING] SMTP_HOST is unset/localhost — OTP codes go to Mailpit (localhost:1025) or nowhere. Set a real SMTP host for any deploy.',
      );
    }
  }

  // Behind a reverse proxy (production VPS: nginx/Caddy), Express must
  // trust X-Forwarded-For or every visitor shares the proxy's IP — which
  // would pool the rate limits and the per-IP OTP cap across all users.
  // Set TRUST_PROXY=1 in production only; off in local dev.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy !== undefined && trustProxy.trim() !== '') {
    app.set('trust proxy', parseTrustProxy(trustProxy));
  } else if (trustProxy !== undefined) {
    // Round 5, D5-S32: a whitespace-only value is a typo'd blank, not
    // "unset" — treating it as unset silently skipped the warning and
    // pooled every visitor under the proxy IP. Reject it like any
    // other invalid value.
    throw new Error(
      '[BOOT] TRUST_PROXY is blank — set TRUST_PROXY=1 (one proxy hop) or unset it entirely.',
    );
  } else if (bootMustFail) {
    // Round 5, D5-S32: the unset warning used to fire only for exact
    // NODE_ENV === 'production', so staging/unrecognised envs got no
    // warning at all. Warn whenever boot must fail and no valid
    // trust-proxy value was applied.
    // Without this, every visitor shares the proxy's IP and the
    // per-IP OTP caps + throttler pool across all users (audit A2).
    // Loud on purpose: this must be fixed in the deployment, not
    // discovered from a support ticket about OTP lockouts.
    console.warn(
      '[BOOT WARNING] TRUST_PROXY is not set — rate limits and per-IP OTP caps will pool behind the reverse proxy. Set TRUST_PROXY=1.',
    );
  }

  // Round 5, D5-S42 (code half): STORAGE_DRIVER=s3 is an accepted
  // value, but without the S3 set the app boots fine and fails only
  // at first upload. Fail on production-like envs, warn otherwise.
  if (config.get('storage.driver') === 's3') {
    const s3 = config.get('storage.s3') as Record<string, string | undefined>;
    const missing = ['bucket', 'region', 'endpoint', 'accessKey', 'secretKey'].filter(
      (k) => !s3[k],
    );
    if (missing.length > 0) {
      const msg =
        `STORAGE_DRIVER=s3 but S3_${missing.map((k) => k.toUpperCase()).join(', S3_')} missing — uploads will fail. ` +
        'Set the full S3 set or use STORAGE_DRIVER=local.';
      if (bootMustFail) throw new Error(`[BOOT] ${msg}`);
      console.warn(`[BOOT WARNING] ${msg}`);
    }
  }

  // Round 4, P-S15: log the effective (non-secret) configuration at
  // boot, so a stale `environment:` value silently winning over an
  // edited `.env` file is visible in the deploy log instead of
  // discovered from a support ticket. Secrets (JWT, SMTP creds, DB
  // password inside DATABASE_URL) are never logged.
  console.log(
    `[BOOT] config: NODE_ENV=${NODE_ENV ?? 'unset'} TZ=${effectiveTz} ` +
      `CORS=${corsOrigin.length > 0 ? corsOrigin.join(',') : '(none)'} ` +
      `SMTP=${config.get('smtp.host')}:${config.get('smtp.port')} ` +
      `FCM=${config.get('fcm.enabled') ? 'enabled' : 'disabled'} ` +
      `storage=${config.get('storage.driver')} TRUST_PROXY=${trustProxy ?? 'unset'}`,
  );

  // Round 4, P-S11: Postgres bakes its timezone at initdb — changing
  // the TZ env on an existing pgdata volume does NOT change the
  // cluster's setting, and the app never checked. Assert the DB
  // session timezone at boot. (A DB that is down at boot already
  // fails earlier, at Prisma $connect in onModuleInit; this check's
  // warn path covers a DB that drops between connect and here, and
  // /api/health reports the outage to the orchestrator.)
  try {
    const prisma = app.get(PrismaService);
    const rows = await prisma.$queryRaw<{ TimeZone: string }[]>`SHOW timezone`;
    const dbTz = rows[0]?.TimeZone;
    if (dbTz && dbTz !== 'Asia/Karachi') {
      tzGuard(
        `Postgres timezone is ${dbTz}, not Asia/Karachi — @db.Date play-date handling diverges from the configuration the audits verified. ` +
          `Fix with ALTER DATABASE ... SET timezone = 'Asia/Karachi' (then reconnect) or re-initialise the pgdata volume.`,
      );
    }
  } catch (e) {
    console.warn(`[BOOT WARNING] Could not check Postgres timezone: ${(e as Error).message}`);
  }

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.enableCors({ origin: config.get<string[]>('corsOrigin') });

  // Serve locally stored uploads (venue images) in dev.
  if (config.get('storage.driver') === 'local') {
    app.useStaticAssets(join(process.cwd(), config.get('storage.dir')), { prefix: '/uploads/' });
  }

  const swagger = new DocumentBuilder()
    .setTitle('Areana API')
    .setDescription('Sports arena booking platform — courts, fields, turfs')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('health', 'Service and database health checks')
    .addTag('auth', 'Player OTP login, owner/staff/admin email+password, token refresh')
    .addTag('users', 'Player profile and account management')
    .addTag('search', 'Venue discovery and slot search')
    .addTag('venues', 'Venue listings, details and images')
    .addTag('courts', 'Courts and grounds inside a venue')
    .addTag('availability', 'Schedules, slots and booking windows')
    .addTag('bookings', 'Booking lifecycle: create, approve, reschedule, check-in')
    .addTag('game-posts', 'Find-players board and curated games')
    .addTag('favorites', 'Player favorite venues')
    .addTag('reviews', 'Player reviews and owner replies')
    .addTag('referrals', 'Promo codes and referral rewards')
    .addTag('disputes', 'Booking disputes and resolutions')
    .addTag('suggestions', 'Suggest-a-turf lead queue')
    .addTag('deeplinks', 'Shareable venue and booking links')
    .addTag('owner · dashboard', 'Owner home: KPIs, today\u2019s bookings, revenue snapshot')
    .addTag('owner · venues & courts', 'Manage venues, courts, images and submit for approval')
    .addTag('owner · calendar blocks', 'Block off courts for maintenance or private use')
    .addTag('owner · bookings', 'Booking approvals, walk-ins, check-in and no-shows')
    .addTag('owner · reschedules', 'Player reschedule requests')
    .addTag('owner · staff', 'Staff accounts and per-venue role assignment')
    .addTag('owner · customers', 'Customer list')
    .addTag('owner · reviews', 'Reviews and owner replies')
    .addTag('admin · analytics', 'Layered analytics: overview, trends, breakdowns, drill-downs')
    .addTag('admin · users', 'Player and account management, strikes')
    .addTag('admin · approvals', 'Owner signups and venue submissions')
    .addTag('admin · roles & permissions', 'Data-driven staff roles and permission keys')
    .addTag('admin · promos', 'Promo code management')
    .addTag('admin · badges', 'Arena badge series and grants')
    .addTag('admin · disputes', 'Dispute center')
    .addTag('admin · audit logs', 'Audit trail of admin actions')
    .addTag('admin · broadcasts & banners', 'Broadcasts and app banner CMS')
    .addTag('admin · suggestions', 'Suggest-a-turf lead queue')
    .addTag('admin · game curation', 'Curate and moderate game posts')
    .addTag('admin · moderation', 'Review moderation')
    .addTag('admin · booking support', 'Support interventions on bookings')
    .addTag('admin · settings', 'Platform settings')
    .addTag('banners', 'App banners and broadcasts')
    .build();
  // Round 4, Swagger trivial: /api/docs used to be served
  // unconditionally, leaking the full API surface (including admin
  // routes and schemas) in production. Gated behind SWAGGER_ENABLED
  // (on by default outside production, off in production).
  if (config.get('docsEnabled')) {
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));
  }

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  console.log(
    `Areana API listening on :${port}${config.get('docsEnabled') ? ' — docs at /api/docs' : ' — docs disabled'}`,
  );
}
bootstrap();
