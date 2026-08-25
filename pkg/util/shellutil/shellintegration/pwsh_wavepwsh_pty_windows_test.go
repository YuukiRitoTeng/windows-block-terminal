//go:build windows && !race

package shellintegration

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/wavetermdev/waveterm/pkg/commandjournal"
	"github.com/wavetermdev/waveterm/pkg/terminalruntime"
)

func TestPowerShellInteractivePTYLifecycle(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skipf("pwsh is required: %v", err)
	}

	dir := t.TempDir()
	integrationPath := filepath.Join(dir, "wavepwsh.ps1")
	content := "function wsh { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Args); return \"\" }\n" +
		"$env:WAVETERM_SWAPTOKEN = 'cli-test-token'\n" + pwshWaveIntegration
	content = replacePowerShellTemplate(content)
	if err := os.WriteFile(integrationPath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cwdTarget := filepath.Join(dir, "phase2-cwd")
	if err := os.Mkdir(cwdTarget, 0o700); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(pwsh, "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", integrationPath)
	term, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 120})
	if err != nil {
		t.Fatalf("start ConPTY: %v", err)
	}
	defer func() {
		_ = term.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	d := terminalruntime.NewDecoder()
	journal := commandjournal.New()
	const blockID = "block-phase2-conpty"
	events := make(chan terminalruntime.IntegrationEvent, 32)
	readDone := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := term.Read(buf)
			if n > 0 {
				for _, item := range d.FeedOrdered(buf[:n]) {
					journal.Apply(blockID, item, time.Now())
					if item.Kind == terminalruntime.StreamIntegrationEvent {
						events <- item.Event
					}
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					readDone <- nil
				} else {
					readDone <- readErr
				}
				return
			}
		}
	}()

	waitForKind := func(kind terminalruntime.EventKind) terminalruntime.IntegrationEvent {
		t.Helper()
		select {
		case event := <-events:
			if event.Kind != kind {
				t.Fatalf("expected %s, got %#v", kind, event)
			}
			return event
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for %s", kind)
			return terminalruntime.IntegrationEvent{}
		}
	}

	metadata := waitForKind(terminalruntime.EventShellMetadata)
	if metadata.SessionEpoch == "" {
		t.Fatal("shell metadata did not establish a session epoch")
	}

	run := func(command string) (terminalruntime.IntegrationEvent, terminalruntime.IntegrationEvent) {
		t.Helper()
		if _, err := term.Write([]byte(command + "\r")); err != nil {
			t.Fatalf("write command %q: %v", command, err)
		}
		var started, finished terminalruntime.IntegrationEvent
		deadline := time.After(10 * time.Second)
		for finished.Kind == "" {
			select {
			case event := <-events:
				switch event.Kind {
				case terminalruntime.EventCommandStarted:
					if started.Kind != "" {
						t.Fatalf("duplicate START for %q", command)
					}
					started = event
				case terminalruntime.EventCommandFinished:
					finished = event
				}
			case <-deadline:
				t.Fatalf("timed out waiting for C/D for %q", command)
			}
		}
		if started.Kind == "" || started.CommandID == "" || started.CommandID != finished.CommandID {
			t.Fatalf("unpaired C/D for %q: %#v %#v", command, started, finished)
		}
		if strings.TrimSpace(started.Command) == "" {
			t.Fatalf("START did not contain the PSReadLine command buffer for %q", command)
		}
		if started.SessionEpoch != metadata.SessionEpoch || finished.SessionEpoch != metadata.SessionEpoch {
			t.Fatalf("session epoch changed for %q: %#v %#v", command, started, finished)
		}
		if finished.HookSequence <= started.HookSequence {
			t.Fatalf("hook sequence did not advance for %q: %#v %#v", command, started, finished)
		}
		return started, finished
	}

	firstCommand := fmt.Sprintf(`Set-Location -LiteralPath '%s'; Write-Output phase2-one; Start-Sleep -Milliseconds 100`, strings.ReplaceAll(cwdTarget, "'", "''"))
	_, success := run(firstCommand)
	assertResult(t, success, true, 0)
	records := journal.Snapshot(blockID)
	if len(records) != 1 || records[0].WaveBlockID != blockID || records[0].SessionEpoch != metadata.SessionEpoch || records[0].WaveBlockID == records[0].SessionEpoch || !bytes.Contains(records[0].Output, []byte("phase2-one")) || records[0].Success == nil || !*records[0].Success || records[0].ExitCode == nil || *records[0].ExitCode != 0 {
		t.Fatalf("unexpected first command record: %#v", records)
	}
	secondStarted, native := run(`cmd /c exit 7`)
	assertResult(t, native, false, 7)
	if !strings.EqualFold(filepath.Clean(secondStarted.Cwd), filepath.Clean(cwdTarget)) {
		t.Fatalf("second command cwd did not persist: got %q want %q", secondStarted.Cwd, cwdTarget)
	}
	records = journal.Snapshot(blockID)
	if len(records) != 2 || records[1].Success == nil || *records[1].Success || records[1].ExitCode == nil || *records[1].ExitCode != 7 || bytes.Contains(records[1].Output, []byte("phase2-one")) {
		t.Fatalf("unexpected second command record or output contamination: %#v", records)
	}

	// Physical multiline input must not emit a lifecycle event for each
	// continuation Enter. Only the final accepted command may produce C/D.
	writeLine := func(line string) {
		t.Helper()
		if _, err := term.Write([]byte(line + "\r")); err != nil {
			t.Fatalf("write multiline line %q: %v", line, err)
		}
	}
	collectFor := func(d time.Duration) []terminalruntime.IntegrationEvent {
		t.Helper()
		var collected []terminalruntime.IntegrationEvent
		timer := time.NewTimer(d)
		defer timer.Stop()
		for {
			select {
			case event := <-events:
				if event.Kind != terminalruntime.EventPromptReady {
					collected = append(collected, event)
				}
			case <-timer.C:
				return collected
			}
		}
	}
	writeLine(`1..3 | ForEach-Object {`)
	if events := collectFor(500 * time.Millisecond); len(events) != 0 {
		t.Fatalf("multiline continuation emitted lifecycle events after first Enter: %#v", events)
	}
	writeLine(`    $_ * 2`)
	if events := collectFor(500 * time.Millisecond); len(events) != 0 {
		t.Fatalf("multiline continuation emitted lifecycle events after second Enter: %#v", events)
	}
	writeLine(`}`)
	var multilineStarted, multilineFinished *terminalruntime.IntegrationEvent
	deadline := time.After(10 * time.Second)
	for multilineFinished == nil {
		select {
		case event := <-events:
			switch event.Kind {
			case terminalruntime.EventCommandStarted:
				if multilineStarted != nil {
					t.Fatal("multiline emitted duplicate START")
				}
				copy := event
				multilineStarted = &copy
			case terminalruntime.EventCommandFinished:
				copy := event
				multilineFinished = &copy
			case terminalruntime.EventShellMetadata:
			}
		case <-deadline:
			t.Fatal("timed out waiting for multiline C/D")
		}
	}
	if multilineStarted == nil || multilineStarted.CommandID == "" || multilineStarted.CommandID != multilineFinished.CommandID {
		t.Fatalf("unpaired multiline C/D: %#v %#v", multilineStarted, multilineFinished)
	}
	if !strings.Contains(multilineStarted.Command, "1..3 | ForEach-Object {") ||
		!strings.Contains(multilineStarted.Command, "$_ * 2") ||
		!strings.Contains(multilineStarted.Command, "}") {
		t.Fatalf("multiline START did not contain complete command: %q", multilineStarted.Command)
	}
	assertResult(t, *multilineFinished, true, 0)

	// A deterministic alternate-screen command remains one outer record. The
	// key is written to the foreground PTY consumer, not interpreted by the
	// product layer.
	tuiCommand := `[Console]::Write(([char]27+'[?1049hPHASE4_TUI_READY'+[char]27+'[2J'+[char]27+'[H'));$key=[Console]::ReadKey($true);[Console]::Write(('PHASE4_KEY='+$key.KeyChar+([char]27)+'[?1049l'))`
	if _, err := term.Write([]byte(tuiCommand + "\r")); err != nil {
		t.Fatalf("write alternate-screen command: %v", err)
	}
	var tuiStarted, tuiFinished terminalruntime.IntegrationEvent
	for tuiStarted.Kind == "" {
		select {
		case event := <-events:
			if event.Kind == terminalruntime.EventCommandStarted {
				tuiStarted = event
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for alternate-screen START")
		}
	}
	if _, err := term.Write([]byte("x")); err != nil {
		t.Fatalf("write alternate-screen key: %v", err)
	}
	for tuiFinished.Kind == "" {
		select {
		case event := <-events:
			if event.Kind == terminalruntime.EventCommandStarted {
				t.Fatal("alternate-screen command emitted duplicate START")
			}
			if event.Kind == terminalruntime.EventCommandFinished {
				tuiFinished = event
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for alternate-screen FINISH")
		}
	}
	if tuiFinished.CommandID != tuiStarted.CommandID {
		t.Fatalf("alternate-screen lifecycle mismatch: start=%#v finish=%#v", tuiStarted, tuiFinished)
	}
	records = journal.Snapshot(blockID)
	var tuiRecord *commandjournal.CommandRecord
	for i := range records {
		if records[i].ID == tuiStarted.CommandID {
			copy := records[i]
			tuiRecord = &copy
		}
	}
	if tuiRecord == nil || tuiRecord.State != commandjournal.StateFinished || tuiRecord.CompletionReason != commandjournal.CompletionNormal || !bytes.Contains(tuiRecord.Output, []byte("PHASE4_TUI_READY")) || !bytes.Contains(tuiRecord.Output, []byte("PHASE4_KEY=x")) || !bytes.Contains(tuiRecord.Output, []byte("\x1b[?1049h")) || !bytes.Contains(tuiRecord.Output, []byte("\x1b[?1049l")) {
		t.Fatalf("alternate-screen output/lifecycle was not preserved: %#v", tuiRecord)
	}

	// A nested pwsh remains inside the outer command. Its commands do not
	// create inner product records; only the parent prompt emits D/P.
	if _, err := term.Write([]byte("pwsh -NoLogo -NoProfile\r")); err != nil {
		t.Fatalf("write nested pwsh command: %v", err)
	}
	var nestedStarted, nestedFinished terminalruntime.IntegrationEvent
	for nestedStarted.Kind == "" {
		select {
		case event := <-events:
			if event.Kind == terminalruntime.EventCommandStarted {
				nestedStarted = event
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for nested pwsh START")
		}
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := term.Write([]byte("Write-Output \"phase4-inner\"\rStart-Sleep -Milliseconds 100\rexit\r")); err != nil {
		t.Fatalf("write nested pwsh commands: %v", err)
	}
	for nestedFinished.Kind == "" {
		select {
		case event := <-events:
			if event.Kind == terminalruntime.EventCommandStarted {
				t.Fatal("nested pwsh emitted an inner CommandRecord")
			}
			if event.Kind == terminalruntime.EventCommandFinished {
				nestedFinished = event
			}
		case <-time.After(15 * time.Second):
			t.Fatal("timed out waiting for nested pwsh FINISH")
		}
	}
	if nestedFinished.CommandID != nestedStarted.CommandID {
		t.Fatalf("nested pwsh lifecycle mismatch: start=%#v finish=%#v", nestedStarted, nestedFinished)
	}
	records = journal.Snapshot(blockID)
	if len(records) != 5 || records[len(records)-1].ID != nestedStarted.CommandID || !bytes.Contains(records[len(records)-1].Output, []byte("phase4-inner")) || records[len(records)-1].State != commandjournal.StateFinished {
		t.Fatalf("nested pwsh did not remain one outer record: %#v", records)
	}
}

func assertResult(t *testing.T, event terminalruntime.IntegrationEvent, wantSuccess bool, wantExit int) {
	t.Helper()
	if event.Success == nil || *event.Success != wantSuccess || event.ExitCode == nil || *event.ExitCode != wantExit {
		t.Fatalf("unexpected completion: %#v", event)
	}
}

func replacePowerShellTemplate(content string) string {
	content = strings.ReplaceAll(content, "{{.WSHBINDIR_PWSH}}", "\"\"")
	return strings.ReplaceAll(content, "{{.PATHSEP}}", ";")
}
