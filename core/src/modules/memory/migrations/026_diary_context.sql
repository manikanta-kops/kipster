-- Kip memory diary pages per context (decision record 10, sections 1 to 3).

-- A page belongs to one context: one agent, one day and one organization, or
-- none for installation threads. Search shows a page only where the thread
-- chunks of its context may be seen, so no page mixes contexts.
ALTER TABLE kipster.diary ADD COLUMN organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE;

-- Pages written before this migration merged every thread of an agent's day.
-- A page whose threads all share one context moves to that context. A page
-- that mixes contexts, or names no thread that still exists, cannot be split
-- or attributed without exposing one context's summary in another, so it is
-- deleted. Its threads keep their chunks and cards.
CREATE TEMPORARY TABLE diary_contexts ON COMMIT DROP AS
  SELECT d.agent_id, d.day,
    count(DISTINCT c.context_kind || ':' || c.context_id::text) AS contexts,
    min(CASE WHEN c.context_kind = 'organization' THEN c.context_id::text END)::uuid AS organization_id
  FROM kipster.diary d
  LEFT JOIN kipster.threads t ON t.id = ANY(d.thread_ids)
  LEFT JOIN kipster.direct_chats c ON c.id = t.chat_id
  GROUP BY d.agent_id, d.day;
DELETE FROM kipster.diary d USING diary_contexts x WHERE x.agent_id = d.agent_id AND x.day = d.day AND x.contexts <> 1;
UPDATE kipster.diary d SET organization_id = x.organization_id FROM diary_contexts x WHERE x.agent_id = d.agent_id AND x.day = d.day;

ALTER TABLE kipster.diary DROP CONSTRAINT diary_pkey;
ALTER TABLE kipster.diary ADD CONSTRAINT diary_page UNIQUE NULLS NOT DISTINCT (agent_id, day, organization_id);

-- A null summary means the page owes a rebuild: a thread it covered was
-- deleted, and the next nightly run writes it again from the remaining
-- threads. Such a page has no embedding and is never searched.
ALTER TABLE kipster.diary ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE kipster.diary ADD CONSTRAINT diary_owed_unembedded CHECK (summary IS NOT NULL OR embedding IS NULL);

CREATE INDEX diary_organization ON kipster.diary(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX diary_owed ON kipster.diary(agent_id) WHERE summary IS NULL;
