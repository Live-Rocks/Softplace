\set ON_ERROR_STOP on

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.profiles (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.conversations (id, user_id) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');

insert into public.messages (
  id, conversation_id, role, content, image_present, crisis_detected, message_sequence, created_at
)
select
  ('20000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '10000000-0000-4000-8000-000000000001',
  case when i % 2 = 1 then 'user'::public.message_role else 'assistant'::public.message_role end,
  '訊息 ' || i,
  i = 2999,
  false,
  i,
  '2026-01-01T00:00:00Z'::timestamptz + i * interval '1 second'
from generate_series(1, 3001) i;

update public.messages set role = 'user', content = '視窗中的使用者事實'
where conversation_id = '10000000-0000-4000-8000-000000000001' and message_sequence = 3000;
update public.messages set role = 'assistant', content = '視窗中的助理回覆'
where conversation_id = '10000000-0000-4000-8000-000000000001' and message_sequence = 3001;

insert into public.messages (id, conversation_id, role, content, message_sequence, created_at) values
  ('20000000-0000-4000-8000-000000003002', '10000000-0000-4000-8000-000000000001',
   'user', '三千則長對話中的目前問題', 3002, '2026-01-01T00:50:02Z'),
  ('20000000-0000-4000-8000-000000003003', '10000000-0000-4000-8000-000000000001',
   'assistant', '測試回覆', 3003, '2026-01-01T00:50:03Z');

select public.enqueue_retrieval_shadow_job(
  '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000003002'
);

do $$
declare v_count integer; v_sequences bigint[]; v_job_id uuid;
begin
  select id into v_job_id from public.retrieval_shadow_jobs
  where query_message_id = '20000000-0000-4000-8000-000000003002';
  select count(*), array_agg(message_sequence order by message_sequence)
  into v_count, v_sequences
  from public.get_retrieval_shadow_job_context(
    v_job_id, '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000003002'
  );
  if v_count > 5 or not (3002 = any(v_sequences)) or not (2997 = any(v_sequences))
    or 2999 = any(v_sequences)
  then raise exception 'bounded_shadow_context_failed: % %', v_count, v_sequences; end if;
  if exists (
    select 1 from public.get_retrieval_shadow_job_context(
      v_job_id, '00000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000003002'
    )
  ) then raise exception 'shadow_ownership_failed'; end if;
end $$;

create function public.test_record_phase25_observation() returns uuid language sql as $$
select public.record_retrieval_generation_observed_run(
  '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000003002',
  '20000000-0000-4000-8000-000000003003',
  'abstained', 'gpt-test', 10, 20, 30, null,
  1, 2, 3, 4, 0, 5, 6, 7, 8, '[]'::jsonb,
  '{"evaluationVersion":"phase25_v1","selectionVersion":"adaptive_v1","queryBuilderVersion":"recent_user_2_v1","evidenceFilterVersion":"evidence_filter_v1","contextFormatterVersion":"retrieved_user_history_v1","minimumScore":0.4,"relativeScoreRatio":0.9,"effectiveThreshold":null,"searchBeforeSequence":2997,"timeoutMs":2500}'::jsonb,
  '{"version":"phase25_v1","currentQueryMessageId":"20000000-0000-4000-8000-000000003002","historyMessageIds":[],"historyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","queryContext":[],"currentQueryPrefixCodePoints":10,"currentQueryHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","embeddingInputHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","injectedCandidates":[],"retrievalContextHash":null,"retrievalContextTokens":0,"formatterVersion":"retrieved_user_history_v1"}'::jsonb
)
$$;

select public.test_record_phase25_observation();
select public.test_record_phase25_observation();

do $$
declare v_run_id uuid;
begin
  select id into v_run_id from public.retrieval_generation_runs
  where query_message_id = '20000000-0000-4000-8000-000000003002';
  if (select evaluation_version from public.retrieval_generation_runs where id = v_run_id) <> 'phase25_v1'
    or not exists (select 1 from public.retrieval_generation_manifests where run_id = v_run_id)
    or (select count(*) from public.retrieval_generation_runs
      where query_message_id = '20000000-0000-4000-8000-000000003002') <> 1
  then raise exception 'atomic_observation_failed'; end if;
end $$;

do $$
begin
  begin
    perform public.record_retrieval_generation_observed_run(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000003002',
      '20000000-0000-4000-8000-000000003003',
      'abstained', 'gpt-test', 10, 20, 30, null,
      1, 2, 3, 4, 0, 5, 6, 7, 8, '[]'::jsonb,
      '{"evaluationVersion":"phase25_v1","selectionVersion":"adaptive_v1","queryBuilderVersion":"recent_user_2_v1","evidenceFilterVersion":"evidence_filter_v1","contextFormatterVersion":"retrieved_user_history_v1","minimumScore":0.4,"relativeScoreRatio":0.9,"effectiveThreshold":null,"searchBeforeSequence":2996,"timeoutMs":2500}'::jsonb,
      '{"version":"phase25_v1","currentQueryMessageId":"20000000-0000-4000-8000-000000003002","historyMessageIds":[],"historyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","queryContext":[],"currentQueryPrefixCodePoints":10,"currentQueryHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","embeddingInputHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","injectedCandidates":[],"retrievalContextHash":null,"retrievalContextTokens":0,"formatterVersion":"retrieved_user_history_v1"}'::jsonb
    );
    raise exception 'observation_conflict_not_rejected';
  exception when others then
    if sqlerrm <> 'generation_observation_conflict' then raise; end if;
  end;
end $$;

select public.record_retrieval_generation_review(
  (select id from public.retrieval_generation_runs where query_message_id = '20000000-0000-4000-8000-000000003002'),
  '00000000-0000-4000-8000-000000000001',
  'not_needed', 'new_topic', '[]'::jsonb, 'not_applicable', 'verified',
  'helpful', false, false, true
);

do $$
begin
  if not exists (
    select 1 from public.retrieval_generation_runs
    where query_message_id = '20000000-0000-4000-8000-000000003002'
      and review_completed_at is not null and response_effect = 'helpful'
  ) then raise exception 'review_recording_failed'; end if;
end $$;

insert into public.messages (id, conversation_id, role, content, message_sequence, created_at) values
  ('20000000-0000-4000-8000-000000003004', '10000000-0000-4000-8000-000000000001',
   'user', '需要舊證據的問題', 3004, '2026-01-01T00:50:04Z'),
  ('20000000-0000-4000-8000-000000003005', '10000000-0000-4000-8000-000000000001',
   'assistant', '使用舊證據的回答', 3005, '2026-01-01T00:50:05Z');

insert into public.retrieval_chunks (
  id, user_id, conversation_id, anchor_message_id, start_sequence, end_sequence,
  model, dimensions, chunk_strategy, embedding, evidence_embedding
) values (
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000005', 3, 5,
  'text-embedding-3-small', 512, 'dialogue_window',
  array_fill(0::real, array[512])::extensions.vector,
  array_fill(0::real, array[512])::extensions.vector
);

select public.record_retrieval_generation_observed_run(
  '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000003004',
  '20000000-0000-4000-8000-000000003005',
  'injected', 'gpt-test', 10, 20, 30, null,
  1, 2, 3, 4, 1, 5, 6, 7, 8,
  '[{"chunkId":"30000000-0000-4000-8000-000000000001","rank":1,"score":0.8,"injected":true,"selectionRank":1,"selectionDecision":"selected"}]'::jsonb,
  '{"evaluationVersion":"phase25_v1","selectionVersion":"adaptive_v1","queryBuilderVersion":"recent_user_2_v1","evidenceFilterVersion":"evidence_filter_v1","contextFormatterVersion":"retrieved_user_history_v1","minimumScore":0.4,"relativeScoreRatio":0.9,"effectiveThreshold":0.72,"searchBeforeSequence":2997,"timeoutMs":2500}'::jsonb,
  '{"version":"phase25_v1","currentQueryMessageId":"20000000-0000-4000-8000-000000003004","historyMessageIds":[],"historyHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","queryContext":[],"currentQueryPrefixCodePoints":8,"currentQueryHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","embeddingInputHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","injectedCandidates":[{"chunkId":"30000000-0000-4000-8000-000000000001","rank":1,"messages":[{"messageId":"20000000-0000-4000-8000-000000000003","sequence":3,"prefixCodePoints":4,"sourceHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},{"messageId":"20000000-0000-4000-8000-000000000005","sequence":5,"prefixCodePoints":4,"sourceHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}]}],"retrievalContextHash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","retrievalContextTokens":1,"formatterVersion":"retrieved_user_history_v1"}'::jsonb
);

do $$
declare v_run_id uuid;
begin
  select id into v_run_id from public.retrieval_generation_runs
  where query_message_id = '20000000-0000-4000-8000-000000003004';
  if (select count(*) from public.retrieval_generation_candidates where run_id = v_run_id) <> 1
    or not exists (select 1 from public.retrieval_generation_manifests where run_id = v_run_id)
  then raise exception 'atomic_candidate_manifest_failed'; end if;
  update public.retrieval_generation_runs set created_at = now() - interval '31 days' where id = v_run_id;
  perform public.cleanup_retrieval_generation(30);
  if exists (select 1 from public.retrieval_generation_runs where id = v_run_id)
    or exists (select 1 from public.retrieval_generation_candidates where run_id = v_run_id)
    or exists (select 1 from public.retrieval_generation_manifests where run_id = v_run_id)
  then raise exception 'generation_retention_failed'; end if;
end $$;

do $$
begin
  begin
    perform public.record_retrieval_generation_observed_run(
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000003002',
      '20000000-0000-4000-8000-000000003003',
      'abstained', 'gpt-test', 0, 0, 0, null,
      0, 0, 0, 0, 0, 0, null, null, null, '[]'::jsonb,
      '{"evaluationVersion":"phase25_v1","selectionVersion":"adaptive_v1","queryBuilderVersion":"recent_user_2_v1","evidenceFilterVersion":"evidence_filter_v1","contextFormatterVersion":"retrieved_user_history_v1","minimumScore":0.4,"relativeScoreRatio":0.9,"effectiveThreshold":null,"searchBeforeSequence":2997,"timeoutMs":2500}'::jsonb,
      '{"version":"phase25_v1","currentQueryMessageId":"20000000-0000-4000-8000-000000003002","historyMessageIds":[],"historyHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","queryContext":[],"currentQueryPrefixCodePoints":1,"currentQueryHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","embeddingInputHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","injectedCandidates":[],"retrievalContextHash":null,"retrievalContextTokens":0,"formatterVersion":"retrieved_user_history_v1"}'::jsonb
    );
    raise exception 'manifest_conflict_not_rejected';
  exception when others then
    if sqlerrm <> 'generation_manifest_conflict' then raise; end if;
  end;
end $$;

begin;
set local role authenticated;
do $$ begin
  begin
    perform count(*) from public.retrieval_generation_manifests;
    raise exception 'authenticated_manifest_read_not_blocked';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

delete from public.messages where id = '20000000-0000-4000-8000-000000003002';
do $$
begin
  if exists (
    select 1 from public.retrieval_generation_runs
    where query_message_id = '20000000-0000-4000-8000-000000003002'
  ) then raise exception 'generation_cascade_failed'; end if;
end $$;
