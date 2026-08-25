ALTER TABLE command_records ADD COLUMN output_state TEXT NOT NULL DEFAULT 'closed';

-- Records created by the pre-fence contract cannot prove that D was a
-- physical output boundary. Preserve truncation/incomplete evidence and make
-- all previously optimistic "complete" values conservative.
UPDATE command_records
SET output_completeness = CASE
    WHEN output_truncated <> 0 THEN 'truncated'
    ELSE 'unknown'
END
WHERE output_completeness = 'complete';
