'use strict'

/*
    Ordered, append-only list of schema migrations.

    Never edit a migration that has shipped - add a new one. The runner records
    the highest applied index in the `schema_version` table.
*/

exports.MIGRATIONS = [
    {
        name: '001-initial',
        sql: `
        /* ---------------------------------------------------------------
           Listings. One row per eBay lot we have ever seen.

           We keep both id forms deliberately: the Browse API speaks
           'v1|1234|0' while the Trading API - our only route to a final
           sale price - speaks the bare legacy number. Losing the legacy id
           means losing the ability to resolve the outcome.
           --------------------------------------------------------------- */
        CREATE TABLE listing (
            browse_id           TEXT PRIMARY KEY,
            legacy_id           TEXT UNIQUE,
            marketplace         TEXT NOT NULL DEFAULT 'EBAY_GB',
            title               TEXT NOT NULL,
            category_id         TEXT,
            condition_label     TEXT,
            buying_options      TEXT NOT NULL,          /* CSV: AUCTION,FIXED_PRICE,BEST_OFFER */
            currency            TEXT NOT NULL DEFAULT 'GBP',
            seller_hash         TEXT,                   /* salted hash - never the raw user id */
            seller_feedback_pct REAL,
            seller_feedback_cnt INTEGER,
            item_web_url        TEXT,
            image_url           TEXT,
            start_time          TEXT,
            end_time            TEXT,
            first_seen          TEXT NOT NULL,
            last_seen           TEXT NOT NULL,
            aspects_fetched     INTEGER NOT NULL DEFAULT 0,
            expires_at          TEXT                    /* retention: raw row is purged after this */
        );
        CREATE INDEX idx_listing_end       ON listing(end_time);
        CREATE INDEX idx_listing_expires   ON listing(expires_at);
        CREATE INDEX idx_listing_legacy    ON listing(legacy_id);

        /* ---------------------------------------------------------------
           Snapshots. The price/bid time series that makes the closing
           uplift curve possible - this is the data eBay will not sell us.
           --------------------------------------------------------------- */
        CREATE TABLE listing_snapshot (
            browse_id      TEXT NOT NULL,
            observed_at    TEXT NOT NULL,
            price          REAL NOT NULL,
            shipping       REAL,
            bid_count      INTEGER,
            seconds_to_end INTEGER,
            PRIMARY KEY (browse_id, observed_at)
        ) WITHOUT ROWID;
        CREATE INDEX idx_snapshot_listing ON listing_snapshot(browse_id, seconds_to_end);

        /* ---------------------------------------------------------------
           Outcomes. What actually happened when the lot ended.

           'censored' marks a listing whose true sale price eBay never
           publishes - chiefly accepted Best Offers. Treating those as
           sales at list price is the single easiest way to build a tool
           that systematically lies about clearing prices.
           --------------------------------------------------------------- */
        CREATE TABLE listing_outcome (
            browse_id     TEXT PRIMARY KEY,
            ended_at      TEXT NOT NULL,
            resolved_at   TEXT NOT NULL,
            sold          INTEGER NOT NULL,
            final_price   REAL,
            shipping      REAL,
            bid_count     INTEGER,
            sale_type     TEXT,                        /* AUCTION | FIXED_PRICE | BEST_OFFER */
            censored      INTEGER NOT NULL DEFAULT 0,
            source        TEXT NOT NULL                /* trading_getitem | last_snapshot | my_ebay */
        );
        CREATE INDEX idx_outcome_ended ON listing_outcome(ended_at);

        /* ---------------------------------------------------------------
           Instruments: sets of coins a buyer treats as interchangeable.
           --------------------------------------------------------------- */
        CREATE TABLE instrument (
            key           TEXT PRIMARY KEY,
            level         INTEGER NOT NULL,
            display_name  TEXT NOT NULL,
            metal         TEXT NOT NULL DEFAULT 'XAU',
            fine_oz       REAL NOT NULL,
            attributes    TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE listing_instrument (
            browse_id   TEXT NOT NULL,
            key         TEXT NOT NULL,
            confidence  REAL NOT NULL,
            method      TEXT NOT NULL,                 /* aspects | title | manual | alias */
            verified    INTEGER NOT NULL DEFAULT 0,
            assigned_at TEXT NOT NULL,
            PRIMARY KEY (browse_id, key)
        ) WITHOUT ROWID;
        CREATE INDEX idx_li_key ON listing_instrument(key);

        /* Listings the classifier could not place, awaiting a human call. */
        CREATE TABLE review_queue (
            browse_id   TEXT PRIMARY KEY,
            reason      TEXT NOT NULL,
            best_guess  TEXT,
            confidence  REAL,
            queued_at   TEXT NOT NULL,
            resolved_at TEXT
        );

        /* Learned rules: once you classify a listing by hand, the same
           phrasing self-classifies next time. */
        CREATE TABLE alias_rule (
            pattern     TEXT PRIMARY KEY,
            key         TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            hits        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE aspect (
            browse_id  TEXT NOT NULL,
            name       TEXT NOT NULL,
            value      TEXT NOT NULL,
            PRIMARY KEY (browse_id, name)
        ) WITHOUT ROWID;

        /* ---------------------------------------------------------------
           Spot. Mirrored from the portfolio app's existing metals.dev
           feed - we never poll metals.dev ourselves, so the two apps can
           never disagree about the gold price.
           --------------------------------------------------------------- */
        CREATE TABLE spot (
            observed_at TEXT NOT NULL,
            metal       TEXT NOT NULL,
            gbp_per_oz  REAL NOT NULL,
            usd_per_oz  REAL,
            source      TEXT NOT NULL,
            PRIMARY KEY (observed_at, metal)
        ) WITHOUT ROWID;

        /* API call accounting, so we degrade gracefully instead of
           blowing the 5,000/day quota at 11am. */
        CREATE TABLE call_budget (
            day       TEXT NOT NULL,
            api       TEXT NOT NULL,
            calls     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, api)
        ) WITHOUT ROWID;

        CREATE TABLE alert (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            rule       TEXT NOT NULL,
            browse_id  TEXT NOT NULL,
            fired_at   TEXT NOT NULL,
            payload    TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_alert_once ON alert(rule, browse_id);

        /* Derived per-instrument statistics. These survive the retention
           purge of raw listing rows - they are our own derived numbers. */
        CREATE TABLE instrument_stat (
            key          TEXT NOT NULL,
            as_of        TEXT NOT NULL,
            window_days  INTEGER NOT NULL,
            stats        TEXT NOT NULL,
            PRIMARY KEY (key, as_of, window_days)
        ) WITHOUT ROWID;
        `
    }
]
