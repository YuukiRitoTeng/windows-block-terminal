# Persistence

Wave uses block files and filestore/persistence services for session and object data. Terminal output is written through the block file path and may be circular/rotating. This is distinct from a durable Command Journal: a future journal needs its own ownership, schema and retention policy rather than reusing the terminal stream file as history.