\set ON_ERROR_STOP on

do $$
declare
  v_legacy public.ava_event_runs%rowtype;
  v_run public.ava_event_runs%rowtype;
  v_claim public.ava_event_runs%rowtype;
  v_retry public.ava_event_runs%rowtype;
  v_first_token uuid := gen_random_uuid();
  v_second_token uuid := gen_random_uuid();
begin
  insert into public.ava_event_runs (
    companion_key,
    event_key,
    starts_on,
    ends_on,
    duration_days
  ) values (
    'ava',
    'legacy-test',
    date '2035-01-01',
    date '2035-01-02',
    2
  ) returning * into v_legacy;

  if v_legacy.event_facts_status <> 'legacy' then
    raise exception 'existing_style_run_not_legacy';
  end if;

  select * into v_run
    from public.ensure_ava_event_run('ava', date '2035-01-04', 'facts-test', 2);
  if v_run.event_facts_status <> 'pending' then
    raise exception 'new_run_not_pending';
  end if;

  select * into v_claim
    from public.claim_ava_event_facts('ava', v_first_token, 120);
  if v_claim.id <> v_run.id or v_claim.event_facts_status <> 'leased' then
    raise exception 'pending_run_not_claimed';
  end if;

  if exists (
    select 1 from public.claim_ava_event_facts('ava', v_second_token, 120)
  ) then
    raise exception 'leased_run_claimed_twice';
  end if;

  update public.ava_event_runs
    set event_facts_lease_expires_at = now() - interval '1 second'
    where id = v_run.id;

  select * into v_claim
    from public.claim_ava_event_facts('ava', v_second_token, 120);
  if v_claim.id <> v_run.id then
    raise exception 'expired_lease_not_reclaimed';
  end if;

  if public.complete_ava_event_facts(
    v_run.id,
    v_first_token,
    'ava_event_facts_v1',
    '{"schemaVersion":"ava_event_facts_v1"}'::jsonb
  ) then
    raise exception 'stale_token_completed';
  end if;

  if not public.complete_ava_event_facts(
    v_run.id,
    v_second_token,
    'ava_event_facts_v1',
    '{"schemaVersion":"ava_event_facts_v1"}'::jsonb
  ) then
    raise exception 'current_token_did_not_complete';
  end if;

  if public.complete_ava_event_facts(
    v_run.id,
    v_second_token,
    'ava_event_facts_v1',
    '{"schemaVersion":"ava_event_facts_v1"}'::jsonb
  ) then
    raise exception 'completed_run_finalized_twice';
  end if;

  select * into v_retry
    from public.ensure_ava_event_run('ava', date '2035-01-07', 'retry-test', 2);
  select * into v_claim
    from public.claim_ava_event_facts('ava', v_first_token, 120);
  if v_claim.id <> v_retry.id then
    raise exception 'retry_run_not_claimed';
  end if;
  if not public.release_ava_event_facts(v_retry.id, v_first_token) then
    raise exception 'valid_lease_not_released';
  end if;
  if exists (
    select 1 from public.claim_ava_event_facts('ava', v_second_token, 120)
  ) then
    raise exception 'failed_run_retried_too_early';
  end if;

  update public.ava_event_runs
    set event_facts_attempted_at = now() - interval '31 minutes'
    where id = v_retry.id;
  select * into v_claim
    from public.claim_ava_event_facts('ava', v_second_token, 120);
  if v_claim.id <> v_retry.id then
    raise exception 'failed_run_not_retried_after_cooldown';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.claim_ava_event_facts(text, uuid, integer)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.claim_ava_event_facts(text, uuid, integer)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.claim_ava_event_facts(text, uuid, integer)', 'EXECUTE')
  then
    raise exception 'ava_event_facts_claim_permissions_invalid';
  end if;

  if has_function_privilege('anon', 'public.complete_ava_event_facts(uuid, uuid, text, jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.complete_ava_event_facts(uuid, uuid, text, jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.complete_ava_event_facts(uuid, uuid, text, jsonb)', 'EXECUTE')
  then
    raise exception 'ava_event_facts_complete_permissions_invalid';
  end if;
end;
$$;

select 'ava event facts SQL integration test passed' as result;
