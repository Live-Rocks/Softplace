-- Phase 2.5: bounded shadow context reads and versioned, replayable generation observations.

alter table public.retrieval_generation_runs
  add column if not exists evaluation_version text not null default 'legacy_unknown',
  add column if not exists selection_version text,
  add column if not exists query_builder_version text,
  add column if not exists evidence_filter_version text,
  add column if not exists context_formatter_version text,
  add column if not exists minimum_score double precision,
  add column if not exists relative_score_ratio double precision,
  add column if not exists effective_threshold double precision,
  add column if not exists search_before_sequence bigint,
  add column if not exists retrieval_timeout_ms integer,
  add column if not exists retrieval_need text,
  add column if not exists question_type text,
  add column if not exists evidence_groups jsonb,
  add column if not exists evidence_resolution text,
  add column if not exists manifest_verification text,
  add column if not exists need_reviewed_at timestamptz,
  add column if not exists review_completed_at timestamptz;

alter table public.retrieval_generation_runs
  add constraint retrieval_generation_runs_phase25_scores_check check (
    minimum_score is null or minimum_score between -1 and 1
  ),
  add constraint retrieval_generation_runs_phase25_ratio_check check (
    relative_score_ratio is null or relative_score_ratio between 0 and 1
  ),
  add constraint retrieval_generation_runs_phase25_effective_check check (
    effective_threshold is null or effective_threshold between -1 and 1
  ),
  add constraint retrieval_generation_runs_retrieval_need_check check (
    retrieval_need is null or retrieval_need in ('required', 'not_needed', 'uncertain')
  ),
  add constraint retrieval_generation_runs_question_type_check check (
    question_type is null or question_type in (
      'explicit_recall', 'new_topic', 'ambiguous_reference', 'recent_context_reference', 'other'
    )
  ),
  add constraint retrieval_generation_runs_evidence_resolution_check check (
    evidence_resolution is null or evidence_resolution in (
      'not_applicable', 'in_recent_history', 'injected_complete', 'injected_truncated',
      'candidate_not_injected', 'outside_candidate_pool', 'search_incomplete', 'unresolved'
    )
  ),
  add constraint retrieval_generation_runs_manifest_verification_check check (
    manifest_verification is null or manifest_verification in ('verified', 'unverifiable', 'legacy_approximate')
  );

create index if not exists retrieval_generation_runs_evaluation_review_idx
  on public.retrieval_generation_runs (evaluation_version, user_id, review_completed_at, created_at, id);

create table public.retrieval_generation_manifests (
  run_id uuid primary key references public.retrieval_generation_runs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  history_hash text not null check (history_hash ~ '^[0-9a-f]{64}$'),
  embedding_input_hash text not null check (embedding_input_hash ~ '^[0-9a-f]{64}$'),
  retrieval_context_hash text check (retrieval_context_hash is null or retrieval_context_hash ~ '^[0-9a-f]{64}$'),
  retrieval_context_tokens integer not null check (retrieval_context_tokens between 0 and 1200),
  formatter_version text not null,
  created_at timestamptz not null default now()
);

alter table public.retrieval_generation_manifests enable row level security;
revoke all on table public.retrieval_generation_manifests from public, anon, authenticated;
grant all on table public.retrieval_generation_manifests to service_role;

create or replace function public.get_retrieval_shadow_job_context(
  p_job_id uuid,
  p_user_id uuid,
  p_conversation_id uuid,
  p_query_message_id uuid
)
returns table (
  id uuid, conversation_id uuid, message_sequence bigint, role public.message_role,
  content text, model_used text, mode public.companion_mode, image_present boolean,
  crisis_detected boolean, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target as (
    select m.*
    from public.retrieval_shadow_jobs j
    join public.messages m on m.id = j.query_message_id
    where j.id = p_job_id and j.user_id = p_user_id
      and j.conversation_id = p_conversation_id
      and j.query_message_id = p_query_message_id
      and m.conversation_id = p_conversation_id and m.role = 'user'
  ), context_ids as (
    select m.id
    from public.messages m cross join target q
    where m.conversation_id = q.conversation_id and m.role = 'user'
      and m.message_sequence < q.message_sequence
      and not m.image_present and not m.crisis_detected and btrim(m.content) <> ''
    order by m.message_sequence desc, m.id desc limit 2
  ), needed as (
    select id from target
    union select id from context_ids
    union
    select m.id from public.messages m cross join target q
    where m.conversation_id = q.conversation_id
      and m.message_sequence between q.message_sequence - 2 and q.message_sequence
  )
  select m.id, m.conversation_id, m.message_sequence, m.role, m.content, m.model_used,
    m.mode, m.image_present, m.crisis_detected, m.created_at
  from public.messages m join needed n on n.id = m.id
  order by m.message_sequence, m.id
$$;

revoke all on function public.get_retrieval_shadow_job_context(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_retrieval_shadow_job_context(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.get_retrieval_shadow_run_context(p_run_id uuid, p_user_id uuid)
returns table (
  id uuid, conversation_id uuid, message_sequence bigint, role public.message_role,
  content text, model_used text, mode public.companion_mode, image_present boolean,
  crisis_detected boolean, created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target as (
    select m.*
    from public.retrieval_shadow_runs r
    join public.messages m on m.id = r.query_message_id
    where r.id = p_run_id and r.user_id = p_user_id
      and m.conversation_id = r.conversation_id and m.role = 'user'
  ), context_ids as (
    select m.id
    from public.messages m cross join target q
    where m.conversation_id = q.conversation_id and m.role = 'user'
      and m.message_sequence < q.message_sequence
      and not m.image_present and not m.crisis_detected and btrim(m.content) <> ''
    order by m.message_sequence desc, m.id desc limit 2
  ), needed as (
    select id from target
    union select id from context_ids
    union
    select m.id from public.messages m cross join target q
    where m.conversation_id = q.conversation_id
      and m.message_sequence between q.message_sequence - 2 and q.message_sequence
  )
  select m.id, m.conversation_id, m.message_sequence, m.role, m.content, m.model_used,
    m.mode, m.image_present, m.crisis_detected, m.created_at
  from public.messages m join needed n on n.id = m.id
  order by m.message_sequence, m.id
$$;

revoke all on function public.get_retrieval_shadow_run_context(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_retrieval_shadow_run_context(uuid, uuid) to service_role;

create or replace function public.record_retrieval_generation_observed_run(
  p_user_id uuid, p_conversation_id uuid, p_query_message_id uuid, p_assistant_message_id uuid,
  p_status text, p_model text, p_embedding_latency_ms bigint, p_search_latency_ms bigint,
  p_total_retrieval_latency_ms bigint, p_error_code text, p_instructions_tokens integer,
  p_memory_tokens integer, p_history_10_tokens integer, p_history_20_tokens integer,
  p_retrieval_tokens integer, p_current_query_tokens integer, p_actual_input_tokens integer,
  p_cached_input_tokens integer, p_output_tokens integer, p_candidates jsonb,
  p_evaluation jsonb, p_manifest jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_run_id uuid;
  v_id jsonb;
  v_source jsonb;
  v_message jsonb;
begin
  if p_candidates is null or coalesce(jsonb_typeof(p_candidates), '') <> 'array'
    or p_evaluation is null or coalesce(jsonb_typeof(p_evaluation), '') <> 'object'
    or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
    or p_evaluation->>'evaluationVersion' <> 'phase25_v1'
    or p_evaluation->>'selectionVersion' <> 'adaptive_v1'
    or p_evaluation->>'queryBuilderVersion' <> 'recent_user_2_v1'
    or p_evaluation->>'evidenceFilterVersion' <> 'evidence_filter_v1'
    or p_evaluation->>'contextFormatterVersion' <> 'retrieved_user_history_v1'
    or (p_evaluation->>'minimumScore')::double precision <> 0.40
    or (p_evaluation->>'relativeScoreRatio')::double precision <> 0.90
    or (p_evaluation->>'timeoutMs')::integer <> 2500
    or p_manifest->>'version' <> 'phase25_v1'
    or (p_manifest->>'currentQueryMessageId')::uuid <> p_query_message_id
    or p_manifest->>'formatterVersion' <> p_evaluation->>'contextFormatterVersion'
    or coalesce((p_manifest->>'currentQueryPrefixCodePoints')::integer, -1) < 0
    or coalesce(p_manifest->>'currentQueryHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_manifest->>'historyHash', '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_manifest->>'embeddingInputHash', '') !~ '^[0-9a-f]{64}$'
    or (p_manifest->>'retrievalContextHash' is not null
      and p_manifest->>'retrievalContextHash' !~ '^[0-9a-f]{64}$')
    or coalesce(jsonb_typeof(p_manifest->'historyMessageIds'), '') <> 'array'
    or coalesce(jsonb_typeof(p_manifest->'queryContext'), '') <> 'array'
    or coalesce(jsonb_typeof(p_manifest->'injectedCandidates'), '') <> 'array'
  then raise exception 'invalid_generation_observation'; end if;

  if jsonb_array_length(coalesce(p_manifest->'historyMessageIds', '[]'::jsonb)) > 10
    or jsonb_array_length(coalesce(p_manifest->'queryContext', '[]'::jsonb)) > 2
    or jsonb_array_length(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) > 5
    or (p_manifest->>'retrievalContextTokens')::integer <> p_retrieval_tokens
    or jsonb_array_length(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) <> (
      select count(*) from jsonb_array_elements(p_candidates) candidate
      where coalesce((candidate->>'injected')::boolean, false)
    )
  then raise exception 'invalid_generation_manifest'; end if;
  if (
    jsonb_array_length(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) = 0
    and ((p_manifest->>'retrievalContextTokens')::integer <> 0
      or p_manifest->>'retrievalContextHash' is not null)
  ) or (
    jsonb_array_length(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) > 0
    and ((p_manifest->>'retrievalContextTokens')::integer <= 0
      or p_manifest->>'retrievalContextHash' is null)
  ) then raise exception 'invalid_generation_manifest'; end if;
  if exists (
    select source->>'chunkId', source->>'rank'
    from jsonb_array_elements(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) source
    except
    select candidate->>'chunkId', candidate->>'rank' from jsonb_array_elements(p_candidates) candidate
    where coalesce((candidate->>'injected')::boolean, false)
  ) or exists (
    select candidate->>'chunkId', candidate->>'rank' from jsonb_array_elements(p_candidates) candidate
    where coalesce((candidate->>'injected')::boolean, false)
    except
    select source->>'chunkId', source->>'rank'
    from jsonb_array_elements(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb)) source
  ) then raise exception 'invalid_generation_manifest'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_candidates) candidate
    where not exists (
      select 1 from public.retrieval_chunks c
      where c.id = (candidate->>'chunkId')::uuid and c.user_id = p_user_id
        and c.conversation_id = p_conversation_id and c.evidence_embedding is not null
    )
  ) then raise exception 'invalid_generation_candidate'; end if;

  for v_id in
    select value from jsonb_array_elements(coalesce(p_manifest->'historyMessageIds', '[]'::jsonb))
    union all
    select item->'messageId' from jsonb_array_elements(coalesce(p_manifest->'queryContext', '[]'::jsonb)) item
  loop
    if not exists (
      select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
      where m.id = trim(both '"' from v_id::text)::uuid
        and m.conversation_id = p_conversation_id and c.user_id = p_user_id
        and m.message_sequence < (select message_sequence from public.messages where id = p_query_message_id)
    ) then raise exception 'invalid_generation_manifest'; end if;
  end loop;

  for v_message in select value from jsonb_array_elements(coalesce(p_manifest->'queryContext', '[]'::jsonb))
  loop
    if coalesce((v_message->>'prefixCodePoints')::integer, -1) < 0
      or coalesce(v_message->>'sourceHash', '') !~ '^[0-9a-f]{64}$'
    then raise exception 'invalid_generation_manifest'; end if;
  end loop;

  v_run_id := public.record_retrieval_generation_adaptive_run(
    p_user_id, p_conversation_id, p_query_message_id, p_assistant_message_id,
    p_status, p_model, p_embedding_latency_ms, p_search_latency_ms,
    p_total_retrieval_latency_ms, p_error_code, p_instructions_tokens,
    p_memory_tokens, p_history_10_tokens, p_history_20_tokens, p_retrieval_tokens,
    p_current_query_tokens, p_actual_input_tokens, p_cached_input_tokens,
    p_output_tokens, p_candidates
  );

  if (select count(*) from public.retrieval_generation_candidates where run_id = v_run_id)
    <> jsonb_array_length(p_candidates)
  then raise exception 'generation_candidate_conflict'; end if;

  update public.retrieval_generation_runs set
    evaluation_version = p_evaluation->>'evaluationVersion',
    selection_version = p_evaluation->>'selectionVersion',
    query_builder_version = p_evaluation->>'queryBuilderVersion',
    evidence_filter_version = p_evaluation->>'evidenceFilterVersion',
    context_formatter_version = p_evaluation->>'contextFormatterVersion',
    minimum_score = (p_evaluation->>'minimumScore')::double precision,
    relative_score_ratio = (p_evaluation->>'relativeScoreRatio')::double precision,
    effective_threshold = nullif(p_evaluation->>'effectiveThreshold', '')::double precision,
    search_before_sequence = nullif(p_evaluation->>'searchBeforeSequence', '')::bigint,
    retrieval_timeout_ms = (p_evaluation->>'timeoutMs')::integer
  where id = v_run_id and evaluation_version = 'legacy_unknown';

  if not exists (
    select 1 from public.retrieval_generation_runs r
    where r.id = v_run_id
      and r.evaluation_version = p_evaluation->>'evaluationVersion'
      and r.selection_version = p_evaluation->>'selectionVersion'
      and r.query_builder_version = p_evaluation->>'queryBuilderVersion'
      and r.evidence_filter_version = p_evaluation->>'evidenceFilterVersion'
      and r.context_formatter_version = p_evaluation->>'contextFormatterVersion'
      and r.minimum_score = (p_evaluation->>'minimumScore')::double precision
      and r.relative_score_ratio = (p_evaluation->>'relativeScoreRatio')::double precision
      and r.effective_threshold is not distinct from nullif(p_evaluation->>'effectiveThreshold', '')::double precision
      and r.search_before_sequence is not distinct from nullif(p_evaluation->>'searchBeforeSequence', '')::bigint
      and r.retrieval_timeout_ms = (p_evaluation->>'timeoutMs')::integer
  ) then raise exception 'generation_observation_conflict'; end if;

  for v_source in select value from jsonb_array_elements(coalesce(p_manifest->'injectedCandidates', '[]'::jsonb))
  loop
    if coalesce(jsonb_typeof(v_source->'messages'), '') <> 'array'
      or jsonb_array_length(v_source->'messages') = 0
      or not exists (
      select 1 from public.retrieval_chunks c
      where c.id = (v_source->>'chunkId')::uuid and c.user_id = p_user_id
        and c.conversation_id = p_conversation_id
    ) then raise exception 'invalid_generation_manifest'; end if;
    for v_message in select value from jsonb_array_elements(coalesce(v_source->'messages', '[]'::jsonb))
    loop
      if coalesce((v_message->>'prefixCodePoints')::integer, -1) < 0
        or coalesce(v_message->>'sourceHash', '') !~ '^[0-9a-f]{64}$'
        or not exists (
        select 1 from public.messages m
        join public.conversations conversation on conversation.id = m.conversation_id
        join public.retrieval_chunks chunk on chunk.id = (v_source->>'chunkId')::uuid
        where m.id = (v_message->>'messageId')::uuid and m.conversation_id = p_conversation_id
          and conversation.user_id = p_user_id and m.role = 'user'
          and m.message_sequence between chunk.start_sequence and chunk.end_sequence
          and m.message_sequence < (
            select message_sequence from public.messages where id = p_query_message_id
          )
      ) then raise exception 'invalid_generation_manifest'; end if;
    end loop;
  end loop;

  insert into public.retrieval_generation_manifests (
    run_id, user_id, conversation_id, manifest, history_hash, embedding_input_hash,
    retrieval_context_hash, retrieval_context_tokens, formatter_version
  ) values (
    v_run_id, p_user_id, p_conversation_id, p_manifest,
    p_manifest->>'historyHash', p_manifest->>'embeddingInputHash',
    nullif(p_manifest->>'retrievalContextHash', ''),
    (p_manifest->>'retrievalContextTokens')::integer, p_manifest->>'formatterVersion'
  ) on conflict (run_id) do nothing;
  if not exists (
    select 1 from public.retrieval_generation_manifests m
    where m.run_id = v_run_id and m.manifest = p_manifest
  ) then raise exception 'generation_manifest_conflict'; end if;
  return v_run_id;
end;
$$;

revoke all on function public.record_retrieval_generation_observed_run(
  uuid, uuid, uuid, uuid, text, text, bigint, bigint, bigint, text,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.record_retrieval_generation_observed_run(
  uuid, uuid, uuid, uuid, text, text, bigint, bigint, bigint, text,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  jsonb, jsonb, jsonb
) to service_role;

create or replace function public.record_retrieval_generation_review(
  p_run_id uuid, p_user_id uuid, p_retrieval_need text, p_question_type text,
  p_evidence_groups jsonb, p_evidence_resolution text, p_manifest_verification text,
  p_response_effect text, p_stale_detected boolean, p_sensitive_detected boolean,
  p_complete boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.retrieval_generation_runs%rowtype;
  v_group jsonb;
  v_id jsonb;
begin
  select * into v_run from public.retrieval_generation_runs
  where id = p_run_id and user_id = p_user_id for update;
  if not found then raise exception 'generation_review_not_found'; end if;
  if p_retrieval_need is null or p_retrieval_need not in ('required', 'not_needed', 'uncertain')
    or p_question_type is null
    or p_question_type not in ('explicit_recall', 'new_topic', 'ambiguous_reference', 'recent_context_reference', 'other')
    or p_evidence_resolution is null or p_evidence_resolution not in (
      'not_applicable', 'in_recent_history', 'injected_complete', 'injected_truncated',
      'candidate_not_injected', 'outside_candidate_pool', 'search_incomplete', 'unresolved'
    ) or p_manifest_verification is null
    or p_manifest_verification not in ('verified', 'unverifiable', 'legacy_approximate')
    or p_evidence_groups is null or coalesce(jsonb_typeof(p_evidence_groups), '') <> 'array'
    or (p_retrieval_need = 'not_needed' and p_evidence_resolution <> 'not_applicable')
    or (p_complete and (
      p_response_effect is null or p_response_effect not in ('helpful', 'neutral', 'harmful')
      or p_stale_detected is null or p_sensitive_detected is null
    ))
  then raise exception 'invalid_generation_review'; end if;

  for v_group in select value from jsonb_array_elements(p_evidence_groups)
  loop
    if coalesce(jsonb_typeof(v_group), '') <> 'array' then raise exception 'invalid_generation_review'; end if;
    for v_id in select value from jsonb_array_elements(v_group)
    loop
      if not exists (
        select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
        where m.id = trim(both '"' from v_id::text)::uuid
          and m.conversation_id = v_run.conversation_id and c.user_id = p_user_id
          and m.message_sequence < (select message_sequence from public.messages where id = v_run.query_message_id)
      ) then raise exception 'invalid_generation_review_evidence'; end if;
    end loop;
  end loop;

  update public.retrieval_generation_runs set
    retrieval_need = p_retrieval_need, question_type = p_question_type,
    evidence_groups = p_evidence_groups, evidence_resolution = p_evidence_resolution,
    manifest_verification = p_manifest_verification,
    need_reviewed_at = coalesce(need_reviewed_at, now()),
    response_effect = case when p_complete then p_response_effect::public.retrieval_generation_effect else response_effect end,
    stale_detected = case when p_complete then p_stale_detected else stale_detected end,
    sensitive_detected = case when p_complete then p_sensitive_detected else sensitive_detected end,
    reviewed_at = case when p_complete then now() else reviewed_at end,
    review_completed_at = case when p_complete then now() else null end
  where id = p_run_id;
  return true;
end;
$$;

revoke all on function public.record_retrieval_generation_review(
  uuid, uuid, text, text, jsonb, text, text, text, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.record_retrieval_generation_review(
  uuid, uuid, text, text, jsonb, text, text, text, boolean, boolean, boolean
) to service_role;
