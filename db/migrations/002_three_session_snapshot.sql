CREATE TABLE IF NOT EXISTS three_session_snapshot_sessions (
  market TEXT NOT NULL
    CONSTRAINT three_session_snapshot_market_check
    CHECK (market IN ('US', 'SG', 'HK')),
  symbol TEXT NOT NULL
    CONSTRAINT three_session_snapshot_symbol_check
    CHECK (symbol <> '' AND symbol = BTRIM(symbol) AND symbol = UPPER(symbol)),
  session_date TEXT NOT NULL
    CONSTRAINT three_session_snapshot_session_date_check
    CHECK (session_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'),
  open_value DOUBLE PRECISION NOT NULL,
  high_value DOUBLE PRECISION NOT NULL,
  low_value DOUBLE PRECISION NOT NULL,
  close_value DOUBLE PRECISION NOT NULL,
  previous_close_value DOUBLE PRECISION NOT NULL,
  volume_value DOUBLE PRECISION NULL,
  as_of_time TEXT NOT NULL
    CONSTRAINT three_session_snapshot_as_of_check
    CHECK (as_of_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  source_id TEXT NOT NULL
    CONSTRAINT three_session_snapshot_source_id_check
    CHECK (source_id <> '' AND source_id = BTRIM(source_id)),
  validation_state TEXT NOT NULL
    CONSTRAINT three_session_snapshot_validation_state_check
    CHECK (validation_state <> '' AND validation_state = BTRIM(validation_state)),
  CONSTRAINT three_session_snapshot_prices_check CHECK (
    open_value > 0 AND high_value > 0 AND low_value > 0
    AND close_value > 0 AND previous_close_value > 0
    AND high_value >= low_value
    AND open_value BETWEEN low_value AND high_value
    AND close_value BETWEEN low_value AND high_value
    AND open_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
    AND high_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
    AND low_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
    AND close_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
    AND previous_close_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
  ),
  CONSTRAINT three_session_snapshot_volume_check CHECK (
    volume_value IS NULL OR (
      volume_value >= 0
      AND volume_value NOT IN ('NaN'::DOUBLE PRECISION, 'Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION)
    )
  ),
  PRIMARY KEY (market, symbol, session_date)
);

CREATE INDEX IF NOT EXISTS three_session_snapshot_latest_idx
  ON three_session_snapshot_sessions (market, symbol, session_date DESC);
