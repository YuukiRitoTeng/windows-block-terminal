ALTER TABLE command_records ADD COLUMN output_completeness TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE command_records ADD COLUMN output_attribution TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE command_records ADD COLUMN output_text_safety TEXT NOT NULL DEFAULT 'unknown';
