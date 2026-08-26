ALTER TABLE command_records ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE command_records ADD COLUMN output_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE command_records ADD COLUMN runtime_host_id TEXT NOT NULL DEFAULT '';
ALTER TABLE command_records ADD COLUMN runtime_runspace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE command_records ADD COLUMN capture_contract_version INTEGER NOT NULL DEFAULT 0;

-- Existing rows predate the hosted structured authority contract. Their
-- execution/output provenance is intentionally unknown and must not be
-- inferred from optimistic output metadata.
UPDATE command_records
SET execution_mode = 'unknown',
    output_source = 'unknown',
    runtime_host_id = '',
    runtime_runspace_id = '',
    capture_contract_version = 0,
    output_completeness = CASE
        WHEN output_truncated <> 0 THEN 'truncated'
        ELSE 'unknown'
    END,
    output_attribution = 'unknown'
WHERE capture_contract_version = 0;
