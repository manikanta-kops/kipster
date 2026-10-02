-- Installation-wide interface choices every connected interface applies. A missing value
-- (NULL) leaves the interface default. The revision counts changes.
CREATE TABLE kipster.interface_preferences (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  palette text,
  theme text,
  desktop_notifications boolean
);
