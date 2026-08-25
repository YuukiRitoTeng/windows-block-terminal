package persistence

import (
	"embed"
)

// MigrationFS is intentionally product-owned and independent from Wave's DB.
//
//go:embed migrations/*.sql
var MigrationFS embed.FS
