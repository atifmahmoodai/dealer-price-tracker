# Competitor price tracker: production version

The production build of the price tracker in the parent folder. The original runs from the command line and a GitHub Action, keeps its data in files, and publishes a static dashboard anyone with the link can open. This version is a server with a PostgreSQL database, logins, a daily schedule and email alerts, so a dealership can run it for years without touching a terminal.

| | Original (parent folder) | Production (this folder) |
|---|---|---|
| Data | JSON files in the repo | PostgreSQL: competitors, daily snapshots, scrape runs, your stock, activity log |
| Who sees it | Anyone with the dashboard URL (competitor intelligence in the open) | Sign-in required. **Admin**: competitors, scrapes, stock, settings, users. **Viewer**: dashboard and exports |
| Adding competitors | Edit `config/competitors.json` | A form, with a **Test first page** button that shows what the scraper finds before you save |
| Scheduling | GitHub Action commits results | Built-in daily schedule at the time you choose; **Scrape now** button; one scrape at a time even with several app instances; a crashed run is detected and closed |
| Alerts | — | Daily digest email: biggest price cuts, new and sold cars, your cars priced above market, and scrape problems |
| Your stock | `config/my-inventory.csv` | Upload your DMS / spreadsheet CSV (Excel UTF-8 files included); download it back |
| Exports | CSV files on disk | Download `listings.csv`, `events.csv`, `daily.csv` from the dashboard (Excel / Power BI) |
| Safety | — | The scraper refuses private and internal network addresses (see Security) |
| Deployment | Static files | Docker image, `docker-compose.yml`, health checks, CI with a real database |

The scraping and change-detection logic is the same code as the original (robots.txt, polite delays, JSON-LD and CSS selectors, "a broken page never marks cars as sold"), now fed by the database.

## Run it with Docker

```bash
cp .env.example .env              # set POSTGRES_PASSWORD, PUBLIC_URL, TIMEZONE (and SMTP_URL for the digest)
docker compose up -d --build
docker compose exec app node dist/cli/create-admin.js --email you@yourdealer.com --name "Your Name"
```

Open http://localhost:8080 and sign in. Then:

1. **Competitors → Add competitor:** paste the dealer's inventory page. Press **Test first page**. If it finds 0 cars, switch to CSS selectors and fill in the card, title and price selectors (inspect a car card in your browser).
2. **Scrapes → Scrape all now** for a first baseline. After that it runs by itself every day at the time set under **Settings**.
3. **My stock → Upload stock CSV** with `StockNo,Year,Make,Model,Mileage,Price`, to see where your prices sit against the market.
4. **Settings & users:** add the digest recipients and viewer logins for your sales team.

Demo data (three simulated competitors, 60 days of history, a demo stock list) is optional:

```bash
docker compose exec -e ALLOW_DEMO_SEED=1 app node dist/cli/seed-demo.js
# Logins: admin@demo.local (admin), viewer@demo.local (viewer) … password: demo-password-1
```

The demo history is produced by the real scraper against simulated websites. To try adding a competitor and scraping it live without touching anyone's site, run `node dist/cli/demo-sites.js` (serves the simulated dealers on port 4190) and start the server with `SCRAPER_ALLOW_PRIVATE=1`, **on your own machine only**.

## Development

Requirements: Node 22+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env    # set DATABASE_URL, NODE_ENV=development, COOKIE_SECURE=false
npm run migrate
npm run seed:demo       # optional
npm run dev             # API on :8080, app with hot reload on :5173
```

## Tests

```bash
npm run typecheck
npm test                        # change detection and parsing, scraper, API integration tests on a real PostgreSQL, web client
npm run build && npm run smoke  # whole stack in Chromium: fresh database, real server, a real scrape of simulated sites
```

`TEST_DATABASE_URL` (default `…/tracker_test`) and `SMOKE_DATABASE_URL` (default `…/tracker_smoke`) are **dropped and recreated** on each run. The tests refuse to run unless the database name contains `test` or `smoke`.

What the tests prove:

- **Scraping and history:** every car, price and VIN is captured across pages and site formats; the demo day a site was down is skipped instead of marking its cars sold; a re-scrape that finds nothing never wipes a good result from earlier the same day.
- **Runs:** only one scrape runs at a time (a second request gets a clear "already running"); the daily schedule runs once a day however many instances ask; a run left behind by a crashed server is closed as failed; the digest email goes out after a run.
- **Scraper safety:** loopback, private, link-local (cloud metadata), and mapped IPv6 addresses are refused, including via DNS names and redirects; pages over the size cap are refused; the **Test** button reports a refused address rather than fetching it.
- **Access:** everything needs a login; viewers can't change competitors, stock, settings or start scrapes; every change needs a CSRF token; disabled users are signed out; there is always an active admin.
- **Stock upload:** Excel UTF-8 CSVs (byte-order mark, quoted `"$21,500"` prices) work; files with missing columns, short rows or duplicate stock numbers are rejected with a clear message and change nothing.
- **Exports:** CSVs are Excel-friendly and protected against formula injection.

## Security

- **Scraper and your network:** competitor URLs are typed in by users and fetched by the server. The scraper only fetches public internet addresses: every DNS answer is checked when connecting (so DNS rebinding can't sneak in a private address), and so is every redirect hop. Only http/https, at most 5 redirects, and pages over `SCRAPER_MAX_PAGE_MB` are dropped. `SCRAPER_ALLOW_PRIVATE` exists for local demos and tests only.
- **Being a good citizen:** the scraper identifies itself, obeys robots.txt and its Crawl-delay, waits at least 1 second between pages (default 3), caps pages per site, and scrapes once a day. Only track public listing pages and respect each site's terms.
- **Accounts:** scrypt password hashes, account lockout after repeated failures, `httpOnly` / `SameSite` / `Secure` session cookies with only a hash stored, a CSRF token on every change plus an `Origin` check.
- **Server:** strict headers with a Content-Security-Policy (Helmet), zod validation on every input, parameterised SQL, rate limits (global, login, and the Test button).
- **Audit log:** records who added or changed competitors, started scrapes, uploaded stock and changed settings or users.

## Operations

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for deployment, https, email, backups, monitoring and upgrades.

## Known limits

- **JavaScript-only websites:** sites that build their inventory in the browser (no structured data, empty HTML) need a headless browser, which this version doesn't include. The Test button shows 0 cars for them.
- **One scrape at a time:** competitors are scraped one after another, politely. Fifty competitors with 20 pages each at 3 seconds take about 50 minutes, which is fine once a day.
- **Dashboard size:** the dashboard loads the whole report (compressed) at once. That's comfortable for a few dozen competitors and a year of history; shorten **Dashboard history** in Settings if it gets slow.
- **Currency:** prices are compared as scraped. All competitors should list in the same currency as your stock.
- **Rate limits are per server:** they are counted in memory, per app instance.
