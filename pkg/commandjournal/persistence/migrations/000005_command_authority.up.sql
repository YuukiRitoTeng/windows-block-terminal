-- Explicit command authority for a record. The value is claimed by the
-- producer, never inferred from execution_mode at runtime: 'terminal-osc' for
-- the in-band shell integration, 'hosted-sidechannel' for the authenticated
-- hosted runtime.
ALTER TABLE command_records ADD COLUMN authority TEXT NOT NULL DEFAULT '';

-- Historical rows predate the column, so the authority is recovered once, from
-- provenance that could only have been written by one producer. Anything that
-- cannot be proven stays unknown (empty) rather than being guessed: a wrong
-- authority would let the renderer trust the wrong identity.
--
-- Hosted runtime provenance (the consumer always writes all of it):
--   * output_source = 'hostStructured'  - only the hosted consumer produces this source
--   * runtime_host_id + runtime_runspace_id - the hosted runtime identity
--   * execution_mode in (structured, interactive) - only the hosted consumer
--     classifies a command's execution mode; the in-band path leaves it unknown
-- Note that a hosted *interactive* command is output_source = 'pty' as well, so
-- PTY output alone proves nothing.
UPDATE command_records
SET authority = 'hosted-sidechannel'
WHERE authority = ''
  AND (
        output_source = 'hostStructured'
     OR (runtime_host_id <> '' AND runtime_runspace_id <> '')
     OR execution_mode IN ('structured', 'interactive')
      );

-- In-band terminal integration provenance: PTY-attributed output with no hosted
-- marker of any kind, and no capture contract (the hosted producer always
-- records one). Rows whose provenance was never recorded keep
-- output_source = 'unknown' and are deliberately not matched here.
UPDATE command_records
SET authority = 'terminal-osc'
WHERE authority = ''
  AND output_source = 'pty'
  AND execution_mode = 'unknown'
  AND runtime_host_id = ''
  AND runtime_runspace_id = ''
  AND capture_contract_version = 0;

-- Every remaining row keeps authority = '': a producer that cannot be proven
-- (no provenance recorded, contradictory markers, or a future producer) stays
-- unknown and is treated as untrusted by the consumers.
