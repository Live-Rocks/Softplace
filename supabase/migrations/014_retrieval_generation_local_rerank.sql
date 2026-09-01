create function public.match_retrieval_generation_chunks(
  p_user_id uuid,
  p_conversation_id uuid,
  p_query_sequence bigint,
  p_query_embedding extensions.vector(512),
  p_limit integer default 20
)
returns table (
  chunk_id uuid,
  start_sequence bigint,
  end_sequence bigint,
  score double precision,
  vector_rank integer
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select
    c.id,
    c.start_sequence,
    c.end_sequence,
    1 - (c.embedding <=> p_query_embedding) as score,
    (row_number() over (order by c.embedding <=> p_query_embedding))::integer as vector_rank
  from public.retrieval_chunks c
  where c.user_id = p_user_id
    and c.conversation_id = p_conversation_id
    and c.end_sequence < p_query_sequence
  order by c.embedding <=> p_query_embedding
  limit least(greatest(p_limit, 1), 20)
$$;

revoke all on function public.match_retrieval_generation_chunks(
  uuid, uuid, bigint, extensions.vector, integer
) from public, anon, authenticated;
grant execute on function public.match_retrieval_generation_chunks(
  uuid, uuid, bigint, extensions.vector, integer
) to service_role;

alter table public.retrieval_generation_runs
  drop constraint if exists retrieval_generation_runs_selection_strategy_check,
  drop constraint if exists retrieval_generation_runs_candidate_limit_check,
  drop constraint if exists retrieval_generation_runs_candidate_count_check;

alter table public.retrieval_generation_runs
  add constraint retrieval_generation_runs_selection_strategy_check check (
    (
      selection_strategy = 'threshold_top2'
      and threshold = 0.60
      and candidate_limit = 5
      and injection_limit = 2
      and injected_count between 0 and 2
    )
    or
    (
      selection_strategy = 'top5_all'
      and threshold is null
      and candidate_limit = 5
      and injection_limit = 5
      and injected_count between 0 and 5
    )
    or
    (
      selection_strategy = 'top20_local_rerank'
      and threshold is null
      and candidate_limit = 20
      and injection_limit = 5
      and injected_count between 0 and 5
    )
  ),
  add constraint retrieval_generation_runs_candidate_count_check check (
    candidate_count between 0 and candidate_limit
  );

alter table public.retrieval_generation_candidates
  drop constraint if exists retrieval_generation_candidates_rank_check,
  add column selection_rank integer,
  add column selection_decision text;

update public.retrieval_generation_candidates
set
  selection_rank = case when injected then rank else null end,
  selection_decision = case when injected then 'selected' else 'not_selected' end;

alter table public.retrieval_generation_candidates
  alter column selection_decision set not null,
  add constraint retrieval_generation_candidates_rank_check check (rank between 1 and 20),
  add constraint retrieval_generation_candidates_selection_rank_check check (
    selection_rank is null or selection_rank between 1 and 5
  ),
  add constraint retrieval_generation_candidates_selection_decision_check check (
    selection_decision in (
      'selected', 'recall_probe_only', 'boilerplate_only',
      'duplicate', 'not_selected', 'invalid_source'
    )
  ),
  add constraint retrieval_generation_candidates_selection_consistency_check check (
    (
      injected
      and selection_decision = 'selected'
      and selection_rank is not null
    )
    or
    (
      not injected
      and selection_decision <> 'selected'
      and selection_rank is null
    )
  );

create unique index retrieval_generation_candidates_selection_rank_unique_idx
  on public.retrieval_generation_candidates (run_id, selection_rank)
  where selection_rank is not null;

create or replace function public.record_retrieval_generation_run(
  p_user_id uuid,
  p_conversation_id uuid,
  p_query_message_id uuid,
  p_assistant_message_id uuid,
  p_status text,
  p_model text,
  p_embedding_latency_ms bigint,
  p_search_latency_ms bigint,
  p_total_retrieval_latency_ms bigint,
  p_error_code text,
  p_instructions_tokens integer,
  p_memory_tokens integer,
  p_history_10_tokens integer,
  p_history_20_tokens integer,
  p_retrieval_tokens integer,
  p_current_query_tokens integer,
  p_actual_input_tokens integer,
  p_cached_input_tokens integer,
  p_output_tokens integer,
  p_candidates jsonb,
  p_selection_strategy text default 'threshold_top2'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_run_id uuid;
  v_candidate jsonb;
  v_candidate_count integer := 0;
  v_injected_count integer := 0;
  v_threshold double precision;
  v_candidate_limit integer;
  v_injection_limit integer;
  v_injected boolean;
  v_selection_rank integer;
  v_selection_decision text;
begin
  if p_status not in ('injected', 'abstained', 'fallback') then
    raise exception 'invalid_generation_status';
  end if;
  if p_selection_strategy not in ('threshold_top2', 'top5_all', 'top20_local_rerank') then
    raise exception 'invalid_generation_selection_strategy';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' then
    raise exception 'invalid_generation_candidates';
  end if;

  v_candidate_limit := case when p_selection_strategy = 'top20_local_rerank' then 20 else 5 end;
  v_injection_limit := case when p_selection_strategy = 'threshold_top2' then 2 else 5 end;
  v_threshold := case when p_selection_strategy = 'threshold_top2' then 0.60 else null end;
  v_candidate_count := jsonb_array_length(p_candidates);
  if v_candidate_count > v_candidate_limit then raise exception 'invalid_generation_candidates'; end if;

  select count(*) into v_injected_count
  from jsonb_array_elements(p_candidates) candidate
  where coalesce((candidate->>'injected')::boolean, false);

  if v_injected_count > v_injection_limit
    or v_injected_count > v_candidate_count
    or (p_status = 'injected') <> (v_injected_count > 0)
  then
    raise exception 'invalid_generation_injection';
  end if;
  if p_selection_strategy = 'threshold_top2' and exists (
    select 1
    from jsonb_array_elements(p_candidates) candidate
    where coalesce((candidate->>'injected')::boolean, false)
      and (candidate->>'score')::double precision < 0.60
  ) then
    raise exception 'invalid_generation_threshold_injection';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_candidates) candidate
    where (candidate->>'rank')::integer not between 1 and v_candidate_limit
      or not exists (
        select 1 from public.retrieval_chunks c
        where c.id = (candidate->>'chunkId')::uuid
          and c.user_id = p_user_id
          and c.conversation_id = p_conversation_id
      )
  ) then
    raise exception 'invalid_generation_candidate';
  end if;
  if not exists (
    select 1
    from public.conversations c
    join public.messages q on q.id = p_query_message_id and q.conversation_id = c.id and q.role = 'user'
    join public.messages a on a.id = p_assistant_message_id and a.conversation_id = c.id and a.role = 'assistant'
    where c.id = p_conversation_id and c.user_id = p_user_id and a.message_sequence > q.message_sequence
  ) then
    raise exception 'invalid_generation_messages';
  end if;

  for v_candidate in select value from jsonb_array_elements(p_candidates)
  loop
    v_injected := coalesce((v_candidate->>'injected')::boolean, false);
    v_selection_rank := case
      when v_candidate ? 'selectionRank' then (v_candidate->>'selectionRank')::integer
      when v_injected then (v_candidate->>'rank')::integer
      else null
    end;
    v_selection_decision := coalesce(
      v_candidate->>'selectionDecision',
      case when v_injected then 'selected' else 'not_selected' end
    );
    if v_selection_decision not in (
      'selected', 'recall_probe_only', 'boilerplate_only',
      'duplicate', 'not_selected', 'invalid_source'
    ) or (
      v_injected
      and (v_selection_decision <> 'selected' or v_selection_rank not between 1 and v_injection_limit)
    ) or (
      not v_injected
      and (v_selection_decision = 'selected' or v_selection_rank is not null)
    ) then
      raise exception 'invalid_generation_selection';
    end if;
  end loop;

  insert into public.retrieval_generation_runs (
    user_id, conversation_id, query_message_id, assistant_message_id, status, model,
    embedding_model, dimensions, chunk_strategy, injection_strategy, selection_strategy, threshold,
    candidate_limit, injection_limit, history_limit, retrieval_token_budget,
    candidate_count, injected_count, embedding_latency_ms, search_latency_ms,
    total_retrieval_latency_ms, error_code, instructions_tokens, memory_tokens,
    history_10_tokens, history_20_tokens, retrieval_tokens, current_query_tokens,
    actual_input_tokens, cached_input_tokens, output_tokens
  ) values (
    p_user_id, p_conversation_id, p_query_message_id, p_assistant_message_id,
    p_status::public.retrieval_generation_status, p_model,
    'text-embedding-3-small', 512, 'dialogue_window', 'user_only', p_selection_strategy, v_threshold,
    v_candidate_limit, v_injection_limit, 10, 1200, v_candidate_count, v_injected_count,
    greatest(p_embedding_latency_ms, 0), greatest(p_search_latency_ms, 0),
    greatest(p_total_retrieval_latency_ms, 0), left(p_error_code, 80),
    greatest(p_instructions_tokens, 0), greatest(p_memory_tokens, 0),
    greatest(p_history_10_tokens, 0), greatest(p_history_20_tokens, 0),
    greatest(p_retrieval_tokens, 0), greatest(p_current_query_tokens, 0),
    p_actual_input_tokens, p_cached_input_tokens, p_output_tokens
  )
  on conflict (query_message_id) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    select id into v_run_id
    from public.retrieval_generation_runs
    where query_message_id = p_query_message_id;
  end if;

  for v_candidate in select value from jsonb_array_elements(p_candidates)
  loop
    v_injected := coalesce((v_candidate->>'injected')::boolean, false);
    v_selection_rank := case
      when v_candidate ? 'selectionRank' then (v_candidate->>'selectionRank')::integer
      when v_injected then (v_candidate->>'rank')::integer
      else null
    end;
    v_selection_decision := coalesce(
      v_candidate->>'selectionDecision',
      case when v_injected then 'selected' else 'not_selected' end
    );
    insert into public.retrieval_generation_candidates (
      run_id, chunk_id, rank, score, injected, selection_rank, selection_decision
    )
    select
      v_run_id,
      c.id,
      (v_candidate->>'rank')::integer,
      (v_candidate->>'score')::double precision,
      v_injected,
      v_selection_rank,
      v_selection_decision
    from public.retrieval_chunks c
    where c.id = (v_candidate->>'chunkId')::uuid
      and c.user_id = p_user_id
      and c.conversation_id = p_conversation_id
    on conflict (run_id, chunk_id) do nothing;
  end loop;

  return v_run_id;
end;
$$;

revoke all on function public.record_retrieval_generation_run(
  uuid, uuid, uuid, uuid, text, text, bigint, bigint, bigint, text,
  integer, integer, integer, integer, integer, integer, integer, integer, integer, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_retrieval_generation_run(
  uuid, uuid, uuid, uuid, text, text, bigint, bigint, bigint, text,
  integer, integer, integer, integer, integer, integer, integer, integer, integer, jsonb, text
) to service_role;
