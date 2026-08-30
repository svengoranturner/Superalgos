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
    },
    {
        name: '002-immutable-seller-id-and-condition-descriptors',
        sql: `
        /* ---------------------------------------------------------------
           eBay replaced usernames with immutable user IDs in May 2026.

           We now hash BOTH identifiers. The account-deletion notification
           may name the departing user by either one, and a purge that
           matched only the username would answer eBay 200 while deleting
           nothing - the exact obligation we subscribed in order to meet.
           The immutable id is also the better relist key, since a seller
           who renames themselves is no longer two different people.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN seller_id_hash TEXT;
        CREATE INDEX idx_listing_seller_id ON listing(seller_id_hash);
        CREATE INDEX idx_listing_seller    ON listing(seller_hash);

        /* ---------------------------------------------------------------
           Standardised coin condition descriptors, mandatory on eBay coin
           listings from May 2026. Grade is the second-largest driver of a
           sovereign's price after its metal content, and this turns it
           from a title-regex guess into a structured read.

           The certification number uniquely identifies one physical
           slabbed coin, which lets us follow the SAME coin across
           relistings and resales - something the seller+title fingerprint
           could never do.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN cert_number TEXT;
        ALTER TABLE listing ADD COLUMN grading_company TEXT;
        ALTER TABLE listing ADD COLUMN grade_numeric TEXT;
        ALTER TABLE listing ADD COLUMN grade_letter TEXT;
        ALTER TABLE listing ADD COLUMN condition_band TEXT;
        CREATE INDEX idx_listing_cert ON listing(cert_number);
        `
    },
    {
        name: '003-legacy-id-is-not-unique',
        sql: `
        /* ---------------------------------------------------------------
           legacy_id was declared UNIQUE. It is not unique, and eBay says so.

           A Browse id has the form v1|<legacyItemId>|<variationId>, and a
           multi-variation listing returns one row per variation, each with
           its own browse id and all carrying the SAME legacy item number.
           Observed live on EBAY_GB:

               legacyItemId 327041911935
                 -> v1|327041911935|515924774139
                 -> v1|327041911935|515924774151

           The upsert only handles ON CONFLICT(browse_id), so the second
           variation violated a constraint the upsert could not absorb, the
           statement threw, and discover.js abandoned the rest of that
           partition. Ten partitions in a single sweep. The cost is not the
           duplicate - it is every listing after it in that partition, and
           discovery cannot be backfilled once a lot has closed.

           browse_id is the real identity and stays the primary key. The
           legacy id keeps its index, because outcome resolution looks up by
           it, but loses the constraint it never satisfied.

           SQLite cannot drop an inline constraint, so the table is rebuilt.
           --------------------------------------------------------------- */
        CREATE TABLE listing_rebuilt (
            browse_id           TEXT PRIMARY KEY,
            legacy_id           TEXT,
            marketplace         TEXT NOT NULL DEFAULT 'EBAY_GB',
            title               TEXT NOT NULL,
            category_id         TEXT,
            condition_label     TEXT,
            buying_options      TEXT NOT NULL,
            currency            TEXT NOT NULL DEFAULT 'GBP',
            seller_hash         TEXT,
            seller_feedback_pct REAL,
            seller_feedback_cnt INTEGER,
            item_web_url        TEXT,
            image_url           TEXT,
            start_time          TEXT,
            end_time            TEXT,
            first_seen          TEXT NOT NULL,
            last_seen           TEXT NOT NULL,
            aspects_fetched     INTEGER NOT NULL DEFAULT 0,
            expires_at          TEXT,
            seller_id_hash      TEXT,
            cert_number         TEXT,
            grading_company     TEXT,
            grade_numeric       TEXT,
            grade_letter        TEXT,
            condition_band      TEXT
        );

        INSERT INTO listing_rebuilt SELECT
            browse_id, legacy_id, marketplace, title, category_id, condition_label,
            buying_options, currency, seller_hash, seller_feedback_pct, seller_feedback_cnt,
            item_web_url, image_url, start_time, end_time, first_seen, last_seen,
            aspects_fetched, expires_at, seller_id_hash, cert_number, grading_company,
            grade_numeric, grade_letter, condition_band
        FROM listing;

        DROP TABLE listing;
        ALTER TABLE listing_rebuilt RENAME TO listing;

        CREATE INDEX idx_listing_end       ON listing(end_time);
        CREATE INDEX idx_listing_expires   ON listing(expires_at);
        CREATE INDEX idx_listing_legacy    ON listing(legacy_id);
        CREATE INDEX idx_listing_seller    ON listing(seller_hash);
        CREATE INDEX idx_listing_seller_id ON listing(seller_id_hash);
        CREATE INDEX idx_listing_cert      ON listing(cert_number);
        `
    }
]
