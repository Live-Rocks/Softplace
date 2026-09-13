alter table public.ava_event_runs
  add column event_facts_version text,
  add column event_facts jsonb,
  add column event_facts_status text not null default 'legacy'
    check (event_facts_status in ('legacy', 'pending', 'leased', 'generated', 'failed')),
  add column event_facts_attempted_at timestamptz,
  add column event_facts_lease_token uuid,
  add column event_facts_lease_expires_at timestamptz,
  add column event_facts_generated_at timestamptz,
  add constraint ava_event_runs_facts_check check (
    (event_facts_status = 'generated'
      and event_facts is not null
      and event_facts_version is not null
      and event_facts_generated_at is not null)
    or
    (event_facts_status <> 'generated'
      and event_facts is null
      and event_facts_version is null
      and event_facts_generated_at is null)
  );

create or replace function public.ensure_ava_event_run(
  p_companion_key text,
  p_local_date date,
  p_event_key text,
  p_duration_days integer
)
returns public.ava_event_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.ava_event_runs%rowtype;
begin
  if p_duration_days not in (2, 3) then
    raise exception 'invalid_ava_event_duration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ava-event-run:' || p_companion_key, 0));

  select * into v_run
    from public.ava_event_runs
    where companion_key = p_companion_key
      and daterange(starts_on, ends_on, '[]') @> p_local_date
    order by starts_on desc
    limit 1;

  if found then
    return v_run;
  end if;

  insert into public.ava_event_runs (
    companion_key,
    event_key,
    starts_on,
    ends_on,
    duration_days,
    event_facts_status
  )
  values (
    p_companion_key,
    p_event_key,
    p_local_date,
    p_local_date + (p_duration_days - 1),
    p_duration_days,
    'pending'
  )
  returning * into v_run;

  return v_run;
end;
$$;

create or replace function public.claim_ava_event_facts(
  p_companion_key text,
  p_worker_token uuid,
  p_lease_seconds integer default 120
)
returns setof public.ava_event_runs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 30 then
    raise exception 'invalid_ava_event_facts_lease';
  end if;

  return query
  update public.ava_event_runs as run
    set event_facts_status = 'leased',
        event_facts_lease_token = p_worker_token,
        event_facts_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        event_facts_attempted_at = now()
    where run.id = (
      select candidate.id
      from public.ava_event_runs as candidate
      where candidate.companion_key = p_companion_key
        and candidate.event_facts is null
        and (
          candidate.event_facts_status = 'pending'
          or (
            candidate.event_facts_status = 'failed'
            and candidate.event_facts_attempted_at <= now() - interval '30 minutes'
          )
          or (
            candidate.event_facts_status = 'leased'
            and candidate.event_facts_lease_expires_at < now()
          )
        )
      order by candidate.starts_on desc
      limit 1
      for update skip locked
    )
    returning run.*;
end;
$$;

create or replace function public.complete_ava_event_facts(
  p_event_run_id uuid,
  p_worker_token uuid,
  p_event_facts_version text,
  p_event_facts jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if btrim(coalesce(p_event_facts_version, '')) = ''
    or p_event_facts is null
    or jsonb_typeof(p_event_facts) <> 'object'
  then
    raise exception 'invalid_ava_event_facts';
  end if;

  update public.ava_event_runs
    set event_facts_version = btrim(p_event_facts_version),
        event_facts = p_event_facts,
        event_facts_status = 'generated',
        event_facts_lease_token = null,
        event_facts_lease_expires_at = null,
        event_facts_generated_at = now()
    where id = p_event_run_id
      and event_facts_status = 'leased'
      and event_facts_lease_token = p_worker_token
      and event_facts_lease_expires_at > now();

  return found;
end;
$$;

create or replace function public.release_ava_event_facts(
  p_event_run_id uuid,
  p_worker_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.ava_event_runs
    set event_facts_status = 'failed',
        event_facts_lease_token = null,
        event_facts_lease_expires_at = null
    where id = p_event_run_id
      and event_facts_status = 'leased'
      and event_facts_lease_token = p_worker_token
      and event_facts_lease_expires_at > now();

  return found;
end;
$$;

revoke all on function public.claim_ava_event_facts(text, uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_ava_event_facts(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_ava_event_facts(uuid, uuid) from public, anon, authenticated;

grant execute on function public.claim_ava_event_facts(text, uuid, integer) to service_role;
grant execute on function public.complete_ava_event_facts(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.release_ava_event_facts(uuid, uuid) to service_role;
