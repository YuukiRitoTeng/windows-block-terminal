-- Authority is additive provenance; the column is dropped on downgrade and the
-- remaining provenance columns are left untouched.
ALTER TABLE command_records DROP COLUMN authority;
