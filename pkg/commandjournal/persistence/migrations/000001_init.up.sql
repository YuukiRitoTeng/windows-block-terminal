CREATE TABLE command_records (
    id TEXT PRIMARY KEY,
    wave_block_id TEXT NOT NULL,
    session_epoch TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    start_hook_sequence INTEGER NOT NULL,
    finish_hook_sequence INTEGER NOT NULL DEFAULT 0,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL,
    completion_reason TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    success INTEGER,
    exit_code INTEGER,
    visibility_generation INTEGER NOT NULL DEFAULT 0,
    output_total_bytes INTEGER NOT NULL DEFAULT 0,
    output_stored_bytes INTEGER NOT NULL DEFAULT 0,
    output_truncated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX command_records_block_generation_started
    ON command_records(wave_block_id, visibility_generation, started_at_ms);

CREATE TABLE command_output_chunks (
    command_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    raw_bytes BLOB NOT NULL,
    byte_count INTEGER NOT NULL,
    PRIMARY KEY(command_id, chunk_index),
    FOREIGN KEY(command_id) REFERENCES command_records(id) ON DELETE CASCADE
);

CREATE TABLE journal_state (
    wave_block_id TEXT PRIMARY KEY,
    current_visibility_generation INTEGER NOT NULL
);
