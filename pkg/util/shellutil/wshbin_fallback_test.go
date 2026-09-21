// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellutil

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

const testWshVersion = "0.14.5"

// wshBinTestEnv points wavebase at throwaway dirs and returns (resourcesDir, dataDir).
// WAVETERM_APP_PATH is set explicitly so the primary bin path is absolute and confined to the test
// directory: without it wavebase resolves a *relative* "bin" path and the test would write into the
// package directory.
func wshBinTestEnv(t *testing.T) (string, string) {
	t.Helper()
	base := filepath.Join(os.TempDir(), "wbt-wshbin-"+t.Name())
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatalf("mkdir test base: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	resourcesDir := filepath.Join(base, "resources")
	dataDir := filepath.Join(base, "data")
	configDir := filepath.Join(base, "config")
	appDir := filepath.Join(resourcesDir, "app.asar.unpacked")
	for _, dir := range []string{resourcesDir, dataDir, configDir, appDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	t.Setenv("WAVETERM_APP_PATH", appDir)
	t.Setenv("WAVETERM_RESOURCES_PATH", resourcesDir)
	t.Setenv("WAVETERM_DATA_HOME", dataDir)
	t.Setenv("WAVETERM_CONFIG_HOME", configDir)
	wavebase.WaveVersion = testWshVersion
	if err := wavebase.CacheAndRemoveEnvVars(); err != nil {
		t.Skipf("cannot cache wavebase env vars in this environment: %v", err)
	}
	wavebase.WaveVersion = testWshVersion
	if wavebase.GetWaveAppResourcesPath() != resourcesDir {
		t.Fatalf("resources path not cached as expected: %q", wavebase.GetWaveAppResourcesPath())
	}
	if wavebase.GetWaveAppBinPath() != filepath.Join(appDir, "bin") {
		t.Fatalf("bin path not absolute as expected: %q", wavebase.GetWaveAppBinPath())
	}
	return resourcesDir, dataDir
}

func arm64TestBaseName() string {
	return "wsh-" + testWshVersion + "-windows.arm64.exe"
}

// writePayload writes a *.dat placeholder into <resources>/wsh-bin.
func writePayload(t *testing.T, resourcesDir string, content []byte) string {
	t.Helper()
	dir := filepath.Join(resourcesDir, WshBinResourcesDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir payload dir: %v", err)
	}
	path := filepath.Join(dir, arm64TestBaseName()+WshBinPlaceholderExt)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	return path
}

// writePrimary creates the primary bin variant so the no-op branch can be exercised.
func writePrimary(t *testing.T, content []byte) string {
	t.Helper()
	dir := wavebase.GetWaveAppBinPath()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir primary dir: %v", err)
	}
	path := filepath.Join(dir, arm64TestBaseName())
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write primary: %v", err)
	}
	return path
}

func cachedWshPath(dataDir string) string {
	return filepath.Join(dataDir, WshBinCacheDirName, arm64TestBaseName())
}

func fileSum(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	sum := sha256.Sum256(data)
	return sum[:]
}

func sumOf(content []byte) []byte {
	sum := sha256.Sum256(content)
	return sum[:]
}

func assertNoTempLeftovers(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatalf("read cache dir: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), arm64TestBaseName()+".tmp-") {
			t.Errorf("temp file left behind: %s", entry.Name())
		}
	}
}

func TestWshBinPrimaryPathWinsWithoutFallback(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	writePayload(t, resourcesDir, []byte("FALLBACK-PAYLOAD-MUST-NOT-BE-USED"))
	primaryPath := writePrimary(t, []byte("PRIMARY"))

	got, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != primaryPath {
		t.Fatalf("got %q, want primary %q", got, primaryPath)
	}
	if _, err := os.Stat(cachedWshPath(dataDir)); !os.IsNotExist(err) {
		t.Fatalf("fallback materialized a cache file even though primary exists (stat err=%v)", err)
	}
}

func TestWshBinFirstMaterializationCopiesPayloadExactly(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := []byte("ARM64-PAYLOAD-BYTES")
	writePayload(t, resourcesDir, payload)

	got, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := cachedWshPath(dataDir)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if !bytes.Equal(fileSum(t, got), sumOf(payload)) {
		t.Fatalf("materialized bytes differ from payload")
	}
	assertNoTempLeftovers(t, filepath.Dir(want))
}

func TestWshBinMatchingCacheIsReused(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := []byte("STABLE-PAYLOAD")
	writePayload(t, resourcesDir, payload)

	if _, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64"); err != nil {
		t.Fatalf("first call: %v", err)
	}
	cached := cachedWshPath(dataDir)
	info, err := os.Stat(cached)
	if err != nil {
		t.Fatalf("stat cache: %v", err)
	}
	firstModTime := info.ModTime()

	if _, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64"); err != nil {
		t.Fatalf("second call: %v", err)
	}
	info2, err := os.Stat(cached)
	if err != nil {
		t.Fatalf("stat cache again: %v", err)
	}
	if !info2.ModTime().Equal(firstModTime) {
		t.Fatalf("matching cache was rewritten: %v -> %v", firstModTime, info2.ModTime())
	}
}

func TestWshBinCorruptCacheIsRefreshed(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := []byte("GOOD-PAYLOAD-CONTENT")
	writePayload(t, resourcesDir, payload)

	cached := cachedWshPath(dataDir)
	if err := os.MkdirAll(filepath.Dir(cached), 0o755); err != nil {
		t.Fatalf("mkdir cache dir: %v", err)
	}
	if err := os.WriteFile(cached, []byte("CORRUPTED"), 0o644); err != nil {
		t.Fatalf("seed corrupt cache: %v", err)
	}

	got, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != cached {
		t.Fatalf("got %q, want %q", got, cached)
	}
	if !bytes.Equal(fileSum(t, cached), sumOf(payload)) {
		t.Fatalf("corrupt cache was not refreshed from the payload")
	}
}

func TestWshBinSameVersionPayloadUpdateRefreshesCache(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	writePayload(t, resourcesDir, []byte("PAYLOAD-REVISION-ONE"))

	if _, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64"); err != nil {
		t.Fatalf("first call: %v", err)
	}
	cached := cachedWshPath(dataDir)
	if !bytes.Equal(fileSum(t, cached), sumOf([]byte("PAYLOAD-REVISION-ONE"))) {
		t.Fatalf("first materialization wrong")
	}
	// Same version, different payload bytes: the cache must not be treated as valid.
	writePayload(t, resourcesDir, []byte("PAYLOAD-REVISION-TWO-DIFFERENT"))

	if _, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64"); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if !bytes.Equal(fileSum(t, cached), sumOf([]byte("PAYLOAD-REVISION-TWO-DIFFERENT"))) {
		t.Fatalf("cache was not refreshed after a same-version payload update")
	}
	assertNoTempLeftovers(t, filepath.Dir(cached))
}

func TestWshBinConcurrentFirstMaterialization(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := bytes.Repeat([]byte("CONCURRENT-PAYLOAD-"), 4096)
	writePayload(t, resourcesDir, payload)

	const callers = 16
	paths := make([]string, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			paths[idx], errs[idx] = GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
		}(i)
	}
	close(start)
	wg.Wait()

	cached := cachedWshPath(dataDir)
	for i := 0; i < callers; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d error: %v", i, errs[i])
		}
		if paths[i] != cached {
			t.Fatalf("caller %d got %q, want %q", i, paths[i], cached)
		}
	}
	if !bytes.Equal(fileSum(t, cached), sumOf(payload)) {
		t.Fatalf("concurrent materialization produced wrong bytes")
	}
	assertNoTempLeftovers(t, filepath.Dir(cached))
}

func TestWshBinMissingPayloadReturnsContextualError(t *testing.T) {
	_, _ = wshBinTestEnv(t)
	_, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
	if err == nil {
		t.Fatalf("expected an error when neither primary nor payload exists")
	}
	message := err.Error()
	if !strings.Contains(message, arm64TestBaseName()) {
		t.Errorf("error lacks the binary name: %v", err)
	}
	if !strings.Contains(message, WshBinResourcesDirName) {
		t.Errorf("error lacks the payload path: %v", err)
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("error does not wrap os.ErrNotExist: %v", err)
	}
}

func TestWshBinWriteFailureIsReportedWithContext(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	writePayload(t, resourcesDir, []byte("PAYLOAD"))

	// Make materialization impossible by occupying the cache dir path with a regular file.
	if err := os.WriteFile(filepath.Join(dataDir, WshBinCacheDirName), []byte("not a dir"), 0o644); err != nil {
		t.Fatalf("seed cache-dir blocker: %v", err)
	}

	_, err := GetLocalWshBinaryPath(testWshVersion, "windows", "arm64")
	if err == nil {
		t.Fatalf("expected a materialize error when the cache dir cannot be created")
	}
	message := err.Error()
	if !strings.Contains(message, "materialize") {
		t.Errorf("error lacks materialize context: %v", err)
	}
	if !strings.Contains(message, arm64TestBaseName()) {
		t.Errorf("error lacks the binary name: %v", err)
	}
	if !strings.Contains(message, WshBinCacheDirName) {
		t.Errorf("error lacks the cache location: %v", err)
	}
}

func TestWshBinUnsupportedPlatformStillErrors(t *testing.T) {
	_, _ = wshBinTestEnv(t)
	if _, err := GetLocalWshBinaryPath(testWshVersion, "linux", "mips"); err == nil {
		t.Fatalf("expected unsupported platform error for linux/mips")
	}
}

// ---------------------------------------------------------------------------
// Commit-layer regression tests.
//
// These drive materializeWshBinary directly so a rename failure can be triggered deterministically
// (the path GetLocalWshBinaryPath would take is short-circuited by its own cache check). A failed
// rename makes the commit loop exhaust wshBinCommitTimeout, so each of these cases costs roughly
// that long. They cannot use t.Parallel because the helper calls t.Setenv, which Go forbids in a
// parallel test.

// blockDestinationWithDir makes the rename onto dstPath fail on every attempt by occupying dstPath
// with a non-empty directory: POSIX rename(2) refuses to replace a directory with a file, and the
// Windows MoveFileEx equivalent fails with access denied. Reading the destination as a hash also
// fails, so the commit loop cannot succeed by merely polling.
func blockDestinationWithDir(t *testing.T, dstPath string) {
	t.Helper()
	if err := os.MkdirAll(dstPath, 0o755); err != nil {
		t.Fatalf("mkdir blocking destination: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dstPath, "occupied.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("populate blocking destination: %v", err)
	}
}

func TestWshBinRenameFailureReturnsRealErrorAndCleansTemp(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := writePayload(t, resourcesDir, []byte("PAYLOAD-FOR-RENAME-FAILURE"))
	dstPath := filepath.Join(dataDir, WshBinCacheDirName, arm64TestBaseName())
	blockDestinationWithDir(t, dstPath)

	err := materializeWshBinary(payload, dstPath)
	if err == nil {
		t.Fatalf("expected materialize to fail when the rename can never succeed")
	}
	message := err.Error()
	if !strings.Contains(message, "rename") {
		t.Errorf("error is not a rename failure: %v", err)
	}
	if !strings.Contains(message, arm64TestBaseName()) {
		t.Errorf("rename error lacks the destination context: %v", err)
	}
	assertNoTempLeftovers(t, filepath.Dir(dstPath))
}

func TestWshBinConvergesWhenDestinationAlreadyHoldsPayload(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payloadBytes := []byte("ALREADY-COMMITTED-PAYLOAD")
	payload := writePayload(t, resourcesDir, payloadBytes)
	dstDir := filepath.Join(dataDir, WshBinCacheDirName)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatalf("mkdir cache dir: %v", err)
	}
	dstPath := filepath.Join(dstDir, arm64TestBaseName())
	// Simulate a concurrent caller having already committed the correct bytes: the destination is
	// valid before this call starts, so the commit must accept it rather than insist on its own move.
	if err := os.WriteFile(dstPath, payloadBytes, 0o755); err != nil {
		t.Fatalf("pre-commit destination: %v", err)
	}

	err := materializeWshBinary(payload, dstPath)
	if err != nil {
		t.Fatalf("expected convergence when the destination already holds the payload, got: %v", err)
	}
	if !bytes.Equal(fileSum(t, dstPath), sumOf(payloadBytes)) {
		t.Fatalf("destination bytes changed unexpectedly")
	}
	assertNoTempLeftovers(t, dstDir)
}

func TestWshBinTempFileIsRemovedWhenRenameKeepsFailing(t *testing.T) {
	resourcesDir, dataDir := wshBinTestEnv(t)
	payload := writePayload(t, resourcesDir, []byte("PAYLOAD"))
	dstPath := filepath.Join(dataDir, WshBinCacheDirName, arm64TestBaseName())
	blockDestinationWithDir(t, dstPath)

	for attempt := 0; attempt < 2; attempt++ {
		if err := materializeWshBinary(payload, dstPath); err == nil {
			t.Fatalf("attempt %d unexpectedly succeeded", attempt)
		}
		assertNoTempLeftovers(t, filepath.Dir(dstPath))
	}
}
