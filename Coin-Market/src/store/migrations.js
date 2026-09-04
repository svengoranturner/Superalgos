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
    },
    {
        name: '004-category-path',
        sql: `
        /* ---------------------------------------------------------------
           eBay sends the whole category ancestry on every search summary
           and we were keeping only the leaf id. The leaf alone cannot tell
           a coin from a teacup: leaf ids differ by country and issue, so an
           allow-list built from British sovereign leaves discarded 2,491
           genuine Australian Sydney half-sovereigns, and one built from the
           Coins root discarded them too, because world coins hang off a
           different root on EBAY_GB.

           The ancestry does not have that problem. Every real coin carries
           a Coins ancestor; a Royal Doulton cup carries Pottery, a Hardy
           fishing reel carries Sporting Goods, a Sovereign-brand wristwatch
           carries Watches. Storing the path makes that test available to
           reclassify as well as to live discovery.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN category_path TEXT;
        `
    },
    {
        name: '005-human-labels-and-learned-rules',
        sql: `
        /* ---------------------------------------------------------------
           Somewhere to put a human decision.

           Every rule in exclusions.js is a guess made from outside the
           market about what a sovereign is. A person who knows the market
           can look at a title and answer in a second what a regex cannot
           answer at all - that a "1984 Straits Edward VIII sovereign" is a
           fantasy piece, that a Hardy Gold Sovereign is a fishing reel.
           Until now there was nowhere for that answer to go, so the same
           judgement had to be re-encoded by hand as another pattern.

           The label carries its own copy of the title on purpose. Raw eBay
           rows roll off under retention (see purgeExpired, which names the
           tables it clears and does not name these two); the judgement is
           ours and is kept. A label whose listing has expired is still a
           training example.

           Keyed on legacy_id rather than browse_id so a decision survives a
           relist - the same coin re-listed is the same coin.
           --------------------------------------------------------------- */
        CREATE TABLE listing_label (
            id           INTEGER PRIMARY KEY,
            legacy_id    TEXT NOT NULL,
            title        TEXT NOT NULL,
            verdict      TEXT NOT NULL,
            denomination TEXT,
            note         TEXT,
            labelled_at  TEXT NOT NULL,
            source       TEXT NOT NULL DEFAULT 'human'
        );
        CREATE UNIQUE INDEX listing_label_legacy ON listing_label(legacy_id);
        CREATE INDEX listing_label_verdict ON listing_label(verdict);

        /* ---------------------------------------------------------------
           A label fixes one listing. A rule generalises it.

           Phrases are stored as literal text, never as a regex. They are
           escaped and word-bounded at match time, so a rule can be read and
           audited by the person who accepted it, and no stored string can
           become a pathological pattern.

           support and agreement record what the evidence looked like at the
           moment the rule was accepted, so a rule that has since gone wrong
           is diagnosable rather than merely wrong.
           --------------------------------------------------------------- */
        CREATE TABLE learned_rule (
            id         INTEGER PRIMARY KEY,
            phrase     TEXT NOT NULL,
            kind       TEXT NOT NULL,
            value      TEXT,
            created_at TEXT NOT NULL,
            from_label INTEGER,
            support    INTEGER,
            agreement  REAL,
            enabled    INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX learned_rule_phrase ON learned_rule(phrase, kind);
        `
    },
    {
        name: '006-item-country',
        sql: `
        /* ---------------------------------------------------------------
           Where the coin actually is.

           eBay sends itemLocation.country on every search summary and we
           were throwing it away, so a lot sitting in Cyprus looked exactly
           like one in Birmingham. That is a different market - different
           postage, different buyer pool, different clearing price - and
           mixing them makes the premium wrong in a way no title rule can
           see.

           Every existing row is NULL until the next sweep re-sees it, so
           anything reading this column MUST treat NULL as "not known yet"
           and never as "foreign". Failing closed here would delete the
           entire corpus from the statistics in one migration.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN item_country TEXT;
        `
    },
    {
        name: '007-settings-and-lot-quantity',
        sql: `
        /* ---------------------------------------------------------------
           Choices the owner makes that outlive a restart.

           Kept in the database rather than config/settings.json because the
           dashboard writes them and the collector reads them, and those are
           two processes: a file both of them edit is a race, and a file only
           one of them can edit is a setting you cannot change from the page
           that shows you why you want to.
           --------------------------------------------------------------- */
        CREATE TABLE setting (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        /* ---------------------------------------------------------------
           How many coins are in the lot.

           A multi-coin lot is excluded from per-coin pricing by default,
           because the per-coin price of a job lot is not comparable to a
           single-coin sale - bulk discounts, mixed dates, a different buyer
           pool. But that is a default, not a law, and somebody looking at
           the listing can see that it is three of the same coin. Saying so
           admits it at the right spot value: the lot is priced against its own
           gold content, which is quantity times one coin's.
           --------------------------------------------------------------- */
        ALTER TABLE listing_label ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
        `
    },
    {
        name: '008-lot-quantity-on-the-assignment',
        sql: `
        /* ---------------------------------------------------------------
           How many coins this particular lot holds.

           It has to live here and not on the instrument row, because fine_oz
           the instrument is the gold in ONE coin and is shared by every
           listing filed under that key - writing a three-coin lot's spot value
           there would change the spot value for all of them.

           So the instrument keeps saying what a sovereign is, and each
           assignment says how many of them this lot contains. Every query
           that reads a listing's spot multiplies the two.
           --------------------------------------------------------------- */
        ALTER TABLE listing_instrument ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
        `
    },
    {
        name: '009-scope-decisions-to-a-series',
        sql: `
        /* ---------------------------------------------------------------
           Which coin a human decision was about.

           The verdicts were SOVEREIGN and NOT_SOVEREIGN, which could say
           "this is a sovereign" and "this is not a sovereign" and nothing
           else. The moment the tool tracks a second coin that becomes a
           problem in two directions.

           The harmless direction: there was no way to record "this is a
           Morgan dollar, not a sovereign" - only "not a sovereign", which
           throws away the useful half of what you knew.

           The dangerous one: rules are INDUCED from these labels, and an
           unscoped rule applies to every series. Marking Britannias "not a
           sovereign" is correct and would have been accepted for good
           reasons - and would then have silently emptied the Britannia pack
           the day it landed, months later, with nothing to connect the two.

           So a verdict now says whether the coin is one the tool TRACKS,
           and a separate column says which series the decision was about.
           Every existing decision genuinely was about sovereigns, so the
           rewrite is exact rather than a guess.
           --------------------------------------------------------------- */
        ALTER TABLE listing_label ADD COLUMN series TEXT;
        ALTER TABLE learned_rule  ADD COLUMN series TEXT;

        UPDATE listing_label SET verdict = 'TRACKED',     series = 'GB.SOV' WHERE verdict = 'SOVEREIGN';
        UPDATE listing_label SET verdict = 'NOT_TRACKED', series = 'GB.SOV' WHERE verdict = 'NOT_SOVEREIGN';
        UPDATE listing_label SET series = 'GB.SOV' WHERE series IS NULL;

        UPDATE learned_rule SET kind = 'NOT_TRACKED' WHERE kind = 'NOT_SOVEREIGN';
        UPDATE learned_rule SET series = 'GB.SOV' WHERE series IS NULL;

        /* ---------------------------------------------------------------
           Uniqueness is per SCOPE, not per phrase.

           (phrase, kind) alone meant a phrase one series had ruled on could
           be silently re-scoped by another - "france" as not-a-sovereign
           overwritten by "france" as not-a-dollar, leaving one of the two
           series quietly unprotected. COALESCE gives a rule that applies to
           every series a scope of its own rather than a NULL, which SQLite
           would treat as distinct from every other NULL and so not unique
           at all.
           --------------------------------------------------------------- */
        DROP INDEX IF EXISTS learned_rule_phrase;
        CREATE UNIQUE INDEX learned_rule_scope
            ON learned_rule(phrase, kind, COALESCE(series, '*'));
        `
    },
    {
        name: '010-which-coin-is-this',
        sql: `
        /* ---------------------------------------------------------------
           Which series a listing belongs to.

           NULLABLE, WITH NO DEFAULT, and that is the whole point of the
           column. Backfilling 'GB.SOV' onto every existing row would assert
           that the fishing reels, the Royal Doulton cup and the empty
           presentation boxes are sovereigns. They are not; they are listings
           no series recognises, and that is a fact worth being able to see.

           NULL means "not attributed yet". Classification fills it in from
           whichever pack recognised the title, and anything nothing claims
           stays NULL and reaches the review queue - which is exactly where
           a coin the tool cannot place belongs.

           Indexed because the review queue filters on it: with two series
           being worked through, a queue that mixes them is a queue nobody
           can work through in one pass.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN series TEXT;
        CREATE INDEX idx_listing_series ON listing(series);
        `
    },
    {
        name: '011-when-we-last-found-it-alive',
        sql: `
        /* ---------------------------------------------------------------
           When eBay last told us, directly, that a lot was still on sale.

           A Good-'Til-Cancelled Buy-It-Now never announces that it is over,
           so COL-01 infers it from absence: three days off the sweep clock
           and the lot is offered up for resolution. The resolver then refuses
           to write an outcome for anything eBay still calls Active, which is
           what keeps a wrong guess cheap.

           Cheap, but not free, and not once. Nothing recorded the refusal, so
           a lot that came back Active had no outcome, stayed quiet, and was
           offered again on the next cycle - and the next. The first live run
           found 28 of 38 still alive; at a cycle every thirty minutes that is
           roughly 1,300 Trading calls a day spent asking the same lots the
           same question and getting the same answer.

           So the answer is stored. A lot found alive is not asked again until
           it has been quiet for another full stretch, measured from this
           column.

           DELIBERATELY NOT last_seen. That column is the sweep's own clock -
           lastSweepAt() reads MAX(last_seen) over endless lots - and writing
           a resolver observation into it would advance that clock without a
           sweep having run, which is exactly the outage behaviour the sweep
           clock exists to prevent.

           NULL means never checked, which is every row today and the correct
           starting state: it has never been asked.
           --------------------------------------------------------------- */
        ALTER TABLE listing ADD COLUMN alive_checked_at TEXT;
        `
    }
]
