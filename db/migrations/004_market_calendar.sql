-- Market holiday and early-close calendar, read by the backend behind the
-- holidayCalendarDbEnabled switch (off by default). Plain PostgreSQL only.
-- Dates and wall-clock times are stored as text ('YYYY-MM-DD', 'HH:MM'
-- exchange-local time), like the existing session tables, so no driver
-- timezone conversion can shift a date.

CREATE TABLE IF NOT EXISTS market_calendar_days (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL
    CONSTRAINT market_calendar_days_market_check
    CHECK (market IN ('US', 'SG', 'HK', 'UK')),
  year INTEGER NOT NULL
    CONSTRAINT market_calendar_days_year_check
    CHECK (year BETWEEN 2000 AND 2100),
  calendar_date TEXT NOT NULL
    CONSTRAINT market_calendar_days_date_check
    CHECK (calendar_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  kind TEXT NOT NULL
    CONSTRAINT market_calendar_days_kind_check
    CHECK (kind IN ('HOLIDAY', 'EARLY_CLOSE')),
  name TEXT NOT NULL
    CONSTRAINT market_calendar_days_name_check
    CHECK (BTRIM(name) <> ''),
  early_close_time TEXT
    CONSTRAINT market_calendar_days_early_close_time_check
    CHECK (early_close_time IS NULL OR early_close_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  after_hours_end TEXT
    CONSTRAINT market_calendar_days_after_hours_end_check
    CHECK (after_hours_end IS NULL OR after_hours_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  source TEXT NOT NULL
    CONSTRAINT market_calendar_days_source_check
    CHECK (source IN ('OFFICIAL', 'SECOND')),
  source_url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT market_calendar_days_year_matches_date_check
    CHECK (LEFT(calendar_date, 4) = year::TEXT),
  CONSTRAINT market_calendar_days_early_close_fields_check
    CHECK (
      (kind = 'EARLY_CLOSE' AND early_close_time IS NOT NULL)
      OR (kind = 'HOLIDAY' AND early_close_time IS NULL AND after_hours_end IS NULL)
    )
);

-- At most one live (not retired) row per market and date.
CREATE UNIQUE INDEX IF NOT EXISTS market_calendar_days_live_idx
  ON market_calendar_days (market, calendar_date)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS market_calendar_days_year_idx
  ON market_calendar_days (market, year);

-- One row per market and year. The backend reads a year only when its status
-- is COMPLETE; any other status leaves that year on the built-in lists.
CREATE TABLE IF NOT EXISTS market_calendar_years (
  market TEXT NOT NULL
    CONSTRAINT market_calendar_years_market_check
    CHECK (market IN ('US', 'SG', 'HK', 'UK')),
  year INTEGER NOT NULL
    CONSTRAINT market_calendar_years_year_check
    CHECK (year BETWEEN 2000 AND 2100),
  status TEXT NOT NULL
    CONSTRAINT market_calendar_years_status_check
    CHECK (status <> '' AND status = UPPER(BTRIM(status))),
  source TEXT NOT NULL
    CONSTRAINT market_calendar_years_source_check
    CHECK (source IN ('OFFICIAL', 'SECOND')),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count INTEGER NOT NULL
    CONSTRAINT market_calendar_years_row_count_check
    CHECK (row_count >= 0),
  PRIMARY KEY (market, year)
);

-- Insert-only change log: every add, change or retirement of a calendar row.
CREATE TABLE IF NOT EXISTS market_calendar_changes (
  id BIGSERIAL PRIMARY KEY,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market TEXT NOT NULL
    CONSTRAINT market_calendar_changes_market_check
    CHECK (market IN ('US', 'SG', 'HK', 'UK')),
  year INTEGER NOT NULL
    CONSTRAINT market_calendar_changes_year_check
    CHECK (year BETWEEN 2000 AND 2100),
  calendar_date TEXT
    CONSTRAINT market_calendar_changes_date_check
    CHECK (calendar_date IS NULL
      OR calendar_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  change_kind TEXT NOT NULL
    CONSTRAINT market_calendar_changes_kind_check
    CHECK (change_kind <> '' AND change_kind = UPPER(BTRIM(change_kind))),
  old_value JSONB,
  new_value JSONB,
  source TEXT
    CONSTRAINT market_calendar_changes_source_check
    CHECK (source IS NULL OR source IN ('OFFICIAL', 'SECOND')),
  source_url TEXT,
  note TEXT,
  -- TRUE when the change needs a person to look at it (every engine-written change today).
  flagged BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS market_calendar_changes_market_year_idx
  ON market_calendar_changes (market, year, changed_at);

CREATE OR REPLACE FUNCTION market_calendar_changes_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'market_calendar_changes is insert-only';
END
$function$;

DROP TRIGGER IF EXISTS market_calendar_changes_insert_only_trigger ON market_calendar_changes;
CREATE TRIGGER market_calendar_changes_insert_only_trigger
  BEFORE UPDATE OR DELETE ON market_calendar_changes
  FOR EACH ROW EXECUTE FUNCTION market_calendar_changes_insert_only();
