# Areana on Oracle Cloud — staging deploy guide

Staging home for now (Oracle Always Free: 2 OCPU / 12 GB ARM VM).
When it's time for production, this same Compose stack moves to
Hetzner unchanged — see §11. The production move is a data move, not
a rebuild.

What lives where on the VM (all on branch `arena-phase-2`):

```
~/areana/areana-api        # this repo — Compose runs from here
~/areana/areana-web        # panels (:3001)
~/areana/areana-user-web   # player (:3002)
```

Public URLs on staging (no domain yet — plain http + ports):

```
API:    http://<VM-IP>:3000
Panels: http://<VM-IP>:3001
Player: http://<VM-IP>:3002
```

## 1. Your steps on oracle.com (only you can do these)

Oracle signup needs your details, a card, and phone verification —
nothing here can do that part for you.

1. Sign up at oracle.com/cloud/free (Individual account).
2. **Home region: Hyderabad (`ap-hyderabad-1`).** This choice is
   permanent and free ARM capacity in Mumbai is chronically
   exhausted, so don't pick Mumbai hoping to retry later.
3. Create the instance: Compute → Instances → Create Instance.
   - Image: Ubuntu 24.04, marked "Always Free Eligible".
   - Shape: `VM.Standard.A1.Flex`, dialled to **2 OCPUs / 12 GB** —
     that is the current Always Free limit (older guides saying
     4 / 24 are out of date since June 2026).
   - Boot volume: leave the default (or raise to 100 GB — both sit
     inside the 200 GB free allowance).
   - SSH key: paste your Mac's public key
     (`cat ~/.ssh/id_ed25519.pub`).
   - If creation fails with "Out of host capacity": retry later,
     try another availability domain, or upgrade the account to
     pay-as-you-go (Always Free resources stay free, and paid
     accounts usually get capacity priority).
4. If you haven't already: create a Resend account and an API key
   (SMTP for OTP codes). Without a verified sending domain, Resend
   only delivers to your own account email — fine for staging
   testing, not for real players.

## 2. Open the ports

Two firewalls stand between the internet and the VM — both need the
same rules (staging only; restrict SSH to your IP later if you want):

1. OCI console → Networking → your VCN's default security list →
   Ingress rules, source `0.0.0.0/0`, TCP ports **22, 3000, 3001,
   3002**.
2. On the VM itself, Oracle's Ubuntu image ships iptables rules that
   block everything except SSH. If a port doesn't answer after step
   1, this is the usual cause:

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3002 -j ACCEPT
sudo apt install -y iptables-persistent  # answer Yes: saves the rules
```

Verify from your Mac (after §6, or right now for SSH):

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<VM-IP>
```

## 3. Install Docker + Node 20 on the VM

```bash
sudo apt update && sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
docker compose version

# Node 20 is only for the first-install tooling below (prisma CLI +
# seeds run from the checkout); the containers use node:20-alpine
# regardless.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

## 4. Clone the three repos

```bash
mkdir -p ~/areana && cd ~/areana
git clone --branch arena-phase-2 https://github.com/uzairalime/areana-backend.git areana-api
git clone --branch arena-phase-2 https://github.com/uzairalime/areana-web.git areana-web
git clone --branch arena-phase-2 https://github.com/uzairalime/areana-user-web.git areana-user-web
```

The repos are private — when git asks for credentials, use a
fine-grained personal access token (or `gh auth login`).

## 5. Env file, then the first-install database sequence

This is the step people get wrong. The repo has **no baseline
migration**, so `migrate deploy` on an empty database creates only
the 12 hand-written objects and the API crashes on first query
(full detail: docs/DEPLOY.md §1). Run this sequence exactly once,
on the empty database:

```bash
cd ~/areana/areana-api
cp .env.prod.example .env
# Fill in .env now: <VM-IP> everywhere, POSTGRES_PASSWORD,
# DATABASE_URL password (must match POSTGRES_PASSWORD),
# JWT secrets (openssl rand -hex 32), ADMIN_PASSWORD, Resend key,
# NEXT_PUBLIC_* URLs. CORS_ORIGIN must be exactly
# http://<VM-IP>:3001,http://<VM-IP>:3002 — the API hard-fails on
# boot without explicit origins.

# Start Postgres only, with the host-local port published so the
# checkout's prisma CLI can reach it:
docker compose -f docker-compose.prod.yml -f docker-compose.prod.first-install.yml up -d db

# Checkout tooling (prisma CLI + ts-node for seeds):
npm install

# From here on, the exported DATABASE_URL (host localhost) overrides
# the .env value (host `db`, which only resolves inside containers):
export DATABASE_URL=postgresql://areana:<POSTGRES_PASSWORD>@localhost:5432/areana

# 1. Create the full schema from schema.prisma (NOT migrate deploy):
npx prisma db push
# 2. Mark ONLY the migrations db push already created as applied:
npx prisma migrate resolve --applied 20261025041600_idempotency_key
npx prisma migrate resolve --applied 20261025123000_round4_r2_court_weekly_hours_version
npx prisma migrate resolve --applied 20261025123200_round4_r2_waitlist_slot_minutes
npx prisma migrate resolve --applied 20261025140000_round4_r5b_broadcast_counts
npx prisma migrate resolve --applied 20261025143000_round5_r1_refresh_replaced_by
npx prisma migrate resolve --applied 20261025180000_round5_r5_review_reply_history
npx prisma migrate resolve --applied 20261025190000_reaudit_schema_drift
# 3. Let deploy create the rest (partial indexes + CHECK). Do NOT
#    resolve 20261025170000 — it is MIXED (columns created by db
#    push, indexes/CHECK not); resolving it would void those objects.
npx prisma migrate deploy
# 4. Pre-deploy checks + seeds:
node scripts/predeploy-check.js
npm run db:seed
npm run db:seed:demo   # optional: 7 demo venues for testing
```

Future deploys are plain `migrate deploy` — which the api
container's CMD already runs on every start.

## 6. Build + start everything

```bash
cd ~/areana/areana-api
# Base file only from here on (the first-install override is done).
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```

Wait for the api logs to settle, then verify:

```bash
curl http://<VM-IP>:3000/api/health
# expect {"ok":true,"db":"up",...}
```

Then open `http://<VM-IP>:3001` (panels — sign in with
ADMIN_EMAIL / ADMIN_PASSWORD) and `http://<VM-IP>:3002` (player —
request an OTP; it arrives via Resend).

## 7. Updating later

```bash
cd ~/areana/areana-api && git pull
cd ../areana-web && git pull
cd ../areana-user-web && git pull
cd ../areana-api
docker compose -f docker-compose.prod.yml up -d --build
```

Rules: changing any NEXT_PUBLIC_* URL means **rebuilding** the web
images (the values are baked at build time — a restart is not
enough). API migrations on later deploys run automatically at
container start; if the api container restart-loops, read its logs
and docs/DEPLOY.md §4 (failed `_prisma_migrations` rows need a
manual `migrate resolve`, never a blind `--applied`).

## 8. Backups (do this — Oracle may reclaim idle free instances)

```bash
cd ~/areana/areana-api
# Database dump (runs inside the db container, writes to the host):
docker compose -f docker-compose.prod.yml exec db pg_dump -U areana -d areana > ~/areana-backup-$(date +%F).sql
# Uploaded venue photos:
docker run --rm -v areana-api_uploads:/data -v ~/:/backup ubuntu tar czf /backup/areana-uploads-$(date +%F).tar.gz -C /data .
# And keep a copy of .env somewhere off the VM.
```

## 9. Known staging limitations (all fixed by a domain + HTTPS)

- **Geolocation ("Use my location") does not work on an http IP:**
  browsers only expose geolocation on secure contexts (https or
  localhost). Place search and manual location still work.
- **No TLS yet:** everything is plain http. Fine for staging, not
  for real players.
- **Resend without a verified domain** only delivers to your own
  email (see §1).

## 10. HTTPS later (free): DuckDNS + Caddy

1. Claim a free subdomain at duckdns.org pointing at `<VM-IP>`.
2. Put Caddy in front (ports 80/443, automatic Let's Encrypt),
   routing by host/path to the three services.
3. Update every URL in `.env` to `https://<subdomain>...`,
   set the Google Places key referrers to the new domain, and
   **rebuild the web images** (NEXT_PUBLIC_* is build-time).
4. TRUST_PROXY is already 1 via the compose default, so rate
   limits keep seeing real client IPs behind Caddy.

## 11. Production move (Hetzner, later)

Same Compose stack, new host: spin up the Hetzner box, clone the
three repos, copy `.env` (with new IPs/URLs), restore the pg_dump
and the uploads archive, run §6. Nothing in the app changes.

## 12. Troubleshooting

- **Api image build fails on `npm ci`:** the repo checkout is
  missing `package-lock.json` — run `npm install` in areana-api
  first (generates it), then rebuild.
- **Api container restart-loops:** read its logs; a failed
  `migrate deploy` blocks every retry until resolved
  (docs/DEPLOY.md §4). Never `--applied` blindly.
- **CORS errors in the browser:** CORS_ORIGIN must list the exact
  browser origins (`http://<VM-IP>:3001,http://<VM-IP>:3002`).
- **Health returns 503:** Postgres is down — check
  `docker compose -f docker-compose.prod.yml ps` and db logs.
- **OTP never arrives:** Resend key wrong, or sending to an
  address that isn't the account owner's while no domain is
  verified (see §1).
- **Ports unreachable from your Mac:** OCI security list first,
  then the VM's iptables (§2).
- **Site calls localhost:3000:** a web image was built before
  NEXT_PUBLIC_API_URL was set in `.env` — rebuild
  (`up -d --build`), a restart cannot fix build-time values.
