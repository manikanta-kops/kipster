-- Cards are renamed memories, and every kip learns lessons about its own work (decision record 13).

ALTER TABLE kipster.cards RENAME TO memories;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_pkey TO memories_pkey;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_installation_id_fkey TO memories_installation_id_fkey;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_organization_id_fkey TO memories_organization_id_fkey;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_replaced_by_fkey TO memories_replaced_by_fkey;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_type_check TO memories_type_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_subject_check TO memories_subject_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_statement_check TO memories_statement_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_details_check TO memories_details_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_check TO memories_valid_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_check1 TO memories_embedding_check;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_id_not_null TO memories_id_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_installation_id_not_null TO memories_installation_id_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_type_not_null TO memories_type_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_subject_not_null TO memories_subject_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_statement_not_null TO memories_statement_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_details_not_null TO memories_details_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_confirmed_not_null TO memories_confirmed_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_core_not_null TO memories_core_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_valid_from_not_null TO memories_valid_from_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_created_at_not_null TO memories_created_at_not_null;
ALTER TABLE kipster.memories RENAME CONSTRAINT cards_updated_at_not_null TO memories_updated_at_not_null;
ALTER INDEX kipster.cards_embedding RENAME TO memories_embedding;
ALTER INDEX kipster.cards_current RENAME TO memories_current;
ALTER INDEX kipster.cards_core RENAME TO memories_core;
ALTER INDEX kipster.cards_organization RENAME TO memories_organization;
ALTER INDEX kipster.cards_replaced_by RENAME TO memories_replaced_by;
ALTER INDEX kipster.cards_unembedded RENAME TO memories_unembedded;

ALTER TABLE kipster.card_sources RENAME TO memory_sources;
ALTER TABLE kipster.memory_sources RENAME COLUMN card_id TO memory_id;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_pkey TO memory_sources_pkey;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_card_id_fkey TO memory_sources_memory_id_fkey;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_installation_id_fkey TO memory_sources_installation_id_fkey;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_thread_id_fkey TO memory_sources_thread_id_fkey;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_message_id_fkey TO memory_sources_message_id_fkey;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_card_id_not_null TO memory_sources_memory_id_not_null;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_installation_id_not_null TO memory_sources_installation_id_not_null;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_thread_id_not_null TO memory_sources_thread_id_not_null;
ALTER TABLE kipster.memory_sources RENAME CONSTRAINT card_sources_message_id_not_null TO memory_sources_message_id_not_null;
ALTER INDEX kipster.card_sources_thread RENAME TO memory_sources_thread;
ALTER INDEX kipster.card_sources_message RENAME TO memory_sources_message;

ALTER TABLE kipster.installations RENAME COLUMN core_card_count TO core_memory_count;
ALTER TABLE kipster.installations RENAME COLUMN search_card_count TO search_memory_count;
ALTER TABLE kipster.installations RENAME CONSTRAINT installations_core_card_count_check TO installations_core_memory_count_check;
ALTER TABLE kipster.installations RENAME CONSTRAINT installations_search_card_count_check TO installations_search_memory_count_check;
ALTER TABLE kipster.installations RENAME CONSTRAINT installations_core_card_count_not_null TO installations_core_memory_count_not_null;
ALTER TABLE kipster.installations RENAME CONSTRAINT installations_search_card_count_not_null TO installations_search_memory_count_not_null;

ALTER TABLE kipster.memory_calls DROP CONSTRAINT memory_calls_step_check;
UPDATE kipster.memory_calls SET step='memories' WHERE step='cards';
ALTER TABLE kipster.memory_calls ADD CONSTRAINT memory_calls_step_check CHECK (step IN ('chunks','memories','lessons','diary','core'));

-- A lesson: how one kip should do its work, learned from the person's and other kips' messages. It belongs to the kip
-- in every workspace; `organization_id` is the workspace it was learned in. `confirmations` counts the nights it came
-- up, at most one per night (`last_confirmed_night`). An ended lesson keeps its row with `valid_to`, and `replaced_by`
-- when a merge took its place.
CREATE TABLE kipster.lessons (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  statement text NOT NULL CHECK (statement <> ''),
  confirmations integer NOT NULL DEFAULT 1 CHECK (confirmations >= 1),
  last_confirmed_night date NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  replaced_by uuid REFERENCES kipster.lessons(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(768),
  embedding_model text,
  CONSTRAINT lessons_valid_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT lessons_embedding_check CHECK (embedding IS NULL OR embedding_model IS NOT NULL)
);

CREATE TABLE kipster.lesson_sources (
  lesson_id uuid NOT NULL REFERENCES kipster.lessons(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES kipster.messages(id) ON DELETE CASCADE,
  PRIMARY KEY (lesson_id, message_id)
);

CREATE INDEX lessons_embedding ON kipster.lessons USING hnsw (embedding vector_cosine_ops);
CREATE INDEX lessons_current ON kipster.lessons(agent_id, confirmations DESC, last_confirmed_night DESC) WHERE valid_to IS NULL;
CREATE INDEX lessons_organization ON kipster.lessons(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX lessons_replaced_by ON kipster.lessons(replaced_by) WHERE replaced_by IS NOT NULL;
CREATE INDEX lessons_unembedded ON kipster.lessons(installation_id) WHERE embedding IS NULL;
CREATE INDEX lesson_sources_thread ON kipster.lesson_sources(thread_id);
CREATE INDEX lesson_sources_message ON kipster.lesson_sources(message_id);
