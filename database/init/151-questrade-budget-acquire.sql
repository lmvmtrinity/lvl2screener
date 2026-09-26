-- One client round trip for a shared broker allowance. The budget row lock
-- keeps grants serial across both markets and all application processes.
CREATE FUNCTION questrade_acquire_request_budget(
  p_namespace TEXT,
  p_discovery BOOLEAN
)
RETURNS TABLE(
  granted BOOLEAN,
  retry_after_ms INTEGER,
  remaining_hour INTEGER,
  remaining_discovery_hour INTEGER
) AS $$
DECLARE
  v_blocked_until TIMESTAMPTZ;
  v_last_started_at TIMESTAMPTZ;
  v_last_discovery_at TIMESTAMPTZ;
  v_now TIMESTAMPTZ;
  v_next TIMESTAMPTZ;
  v_hour_count INTEGER;
  v_second_count INTEGER;
  v_discovery_count INTEGER;
  v_oldest_hour TIMESTAMPTZ;
  v_oldest_second TIMESTAMPTZ;
  v_oldest_discovery TIMESTAMPTZ;
  v_granted BOOLEAN;
BEGIN
  IF p_namespace IS NULL OR btrim(p_namespace) = '' OR p_discovery IS NULL THEN
    RAISE EXCEPTION 'Broker budget namespace and discovery flag are required';
  END IF;

  INSERT INTO questrade_request_budget(namespace)
  VALUES(p_namespace) ON CONFLICT DO NOTHING;
  SELECT blocked_until,last_started_at,last_discovery_at
    INTO v_blocked_until,v_last_started_at,v_last_discovery_at
    FROM questrade_request_budget
    WHERE namespace=p_namespace FOR UPDATE;
  v_now := clock_timestamp();

  DELETE FROM questrade_request_grant
  WHERE namespace=p_namespace AND started_at <= v_now - INTERVAL '1 hour';
  SELECT count(*)::int,
         count(*) FILTER (WHERE started_at > v_now - INTERVAL '1 second')::int,
         count(*) FILTER (WHERE discovery)::int,
         min(started_at),
         min(started_at) FILTER (WHERE started_at > v_now - INTERVAL '1 second'),
         min(started_at) FILTER (WHERE discovery)
    INTO v_hour_count,v_second_count,v_discovery_count,
         v_oldest_hour,v_oldest_second,v_oldest_discovery
    FROM questrade_request_grant WHERE namespace=p_namespace;

  v_next := greatest(v_now,v_blocked_until,
    coalesce(v_last_started_at + INTERVAL '50 milliseconds','-infinity'::timestamptz));
  IF v_second_count >= 20 THEN
    v_next := greatest(v_next,v_oldest_second + INTERVAL '1 second');
  END IF;
  IF v_hour_count >= 15000 THEN
    v_next := greatest(v_next,v_oldest_hour + INTERVAL '1 hour');
  END IF;
  IF p_discovery THEN
    v_next := greatest(v_next,
      coalesce(v_last_discovery_at + INTERVAL '1 second','-infinity'::timestamptz));
    IF v_discovery_count >= 1800 THEN
      v_next := greatest(v_next,v_oldest_discovery + INTERVAL '1 hour');
    END IF;
    IF v_hour_count >= 9000 THEN
      v_next := greatest(v_next,v_oldest_hour + INTERVAL '1 hour');
    END IF;
  END IF;

  v_granted := v_next <= v_now;
  IF v_granted THEN
    INSERT INTO questrade_request_grant(namespace,started_at,discovery)
    VALUES(p_namespace,v_now,p_discovery);
    UPDATE questrade_request_budget
       SET last_started_at=v_now,
           last_discovery_at=CASE WHEN p_discovery THEN v_now ELSE last_discovery_at END
     WHERE namespace=p_namespace;
  END IF;

  RETURN QUERY SELECT
    v_granted,
    greatest(0,ceil(extract(epoch FROM (v_next-v_now))*1000)::int),
    greatest(0,15000-v_hour_count-v_granted::int),
    greatest(0,least(
      1800-v_discovery_count-(v_granted AND p_discovery)::int,
      9000-v_hour_count-v_granted::int
    ));
END;
$$ LANGUAGE plpgsql;

INSERT INTO foundation_schema_version(version, description)
VALUES(151, 'Serialize broker budget acquisition in one database call')
ON CONFLICT(version) DO NOTHING;
