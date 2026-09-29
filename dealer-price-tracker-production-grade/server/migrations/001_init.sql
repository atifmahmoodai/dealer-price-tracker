-- Competitor price tracker schema.

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'viewer')),
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per competitor dealer; `config` holds the scraping recipe (start URLs, mode, selectors, politeness).
CREATE TABLE competitors (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name       text NOT NULL,
  config     jsonb NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scrape_runs (
  id           bigserial PRIMARY KEY,
  trigger      text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  for_date     date NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  results      jsonb NOT NULL DEFAULT '[]',
  error        text
);
-- At most one scrape at a time, across every app instance.
CREATE UNIQUE INDEX scrape_runs_one_running ON scrape_runs ((true)) WHERE status = 'running';
CREATE INDEX scrape_runs_date_idx ON scrape_runs (for_date DESC, id DESC);

-- What one competitor's website listed on one day. A second scrape the same day replaces it.
CREATE TABLE snapshots (
  competitor_id text NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  date          date NOT NULL,
  scraped_at    timestamptz NOT NULL,
  pages         integer NOT NULL,
  listings      jsonb NOT NULL,
  errors        jsonb NOT NULL DEFAULT '[]',
  run_id        bigint REFERENCES scrape_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (competitor_id, date)
);
CREATE INDEX snapshots_date_idx ON snapshots (date);

-- The dealer's own stock, compared against the market.
CREATE TABLE own_stock (
  stock_no   text PRIMARY KEY,
  year       integer NOT NULL CHECK (year > 1900),
  make       text NOT NULL,
  model      text NOT NULL,
  mileage    integer NOT NULL CHECK (mileage >= 0),
  price      numeric(12, 2) NOT NULL CHECK (price > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The dashboard data, rebuilt from the snapshots after every scrape or stock change.
CREATE TABLE report (
  id           integer PRIMARY KEY CHECK (id = 1),
  generated_at timestamptz NOT NULL,
  history      jsonb NOT NULL
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text REFERENCES users(id) ON DELETE SET NULL,
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  details   jsonb NOT NULL DEFAULT '{}',
  ip        text
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
