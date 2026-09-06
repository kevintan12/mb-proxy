CREATE TABLE IF NOT EXISTS completed_session_telemetry (
  market TEXT NOT NULL
    CONSTRAINT completed_session_telemetry_market_check
    CHECK (market IN ('US', 'SG', 'HK')),
  symbol TEXT NOT NULL
    CONSTRAINT completed_session_telemetry_symbol_check
    CHECK (symbol <> '' AND symbol = BTRIM(symbol) AND symbol = UPPER(symbol)),
  session_date TEXT NOT NULL
    CONSTRAINT completed_session_telemetry_session_date_check
    CHECK (session_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'),
  close_value DOUBLE PRECISION NOT NULL
    CONSTRAINT completed_session_telemetry_close_check
    CHECK (
      close_value > 0
      AND close_value <> 'NaN'::DOUBLE PRECISION
      AND close_value <> 'Infinity'::DOUBLE PRECISION
      AND close_value <> '-Infinity'::DOUBLE PRECISION
    ),
  close_time TEXT NOT NULL
    CONSTRAINT completed_session_telemetry_close_time_check
    CHECK (close_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'),
  source_id TEXT NOT NULL
    CONSTRAINT completed_session_telemetry_source_id_check
    CHECK (source_id <> '' AND source_id = BTRIM(source_id)),
  PRIMARY KEY (market, symbol, session_date)
);

CREATE INDEX IF NOT EXISTS completed_session_telemetry_latest_idx
  ON completed_session_telemetry (market, symbol, session_date DESC);
