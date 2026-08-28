//go:build windows

package shellexec

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type hostedStreamingSink struct {
	events chan HostedRuntimeEvent
}

func (s *hostedStreamingSink) ObserveHostedRuntimeEvent(event HostedRuntimeEvent) {
	s.events <- event
}

func hostedPowerShellTestExecutable(t *testing.T) string {
	t.Helper()
	if value := os.Getenv("WBT_HOSTED_PWSH_TEST_EXE"); value != "" {
		if _, err := os.Stat(value); err == nil {
			return value
		}
	}
	for _, path := range []string{
		filepath.Join("..", "..", "tools", "hostedpwsh", "bin", "Debug", "net8.0", "WbtHostedPowerShell.exe"),
		filepath.Join("..", "..", "tools", "hostedpwsh", "bin", "Release", "net8.0", "win-x64", "WbtHostedPowerShell.exe"),
		filepath.Join("tools", "hostedpwsh", "bin", "Debug", "net8.0", "WbtHostedPowerShell.exe"),
		filepath.Join("tools", "hostedpwsh", "bin", "Release", "net8.0", "win-x64", "WbtHostedPowerShell.exe"),
	} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	t.Skip("WbtHostedPowerShell executable not built; set WBT_HOSTED_PWSH_TEST_EXE to run hosted integration tests")
	return ""
}

func TestHostedPowerShellStreamsOutputBeforeCompletion(t *testing.T) {
	executable := hostedPowerShellTestExecutable(t)
	sink := &hostedStreamingSink{events: make(chan HostedRuntimeEvent, 32)}
	sidechannel, err := newHostedSidechannel("streaming-test", sink)
	if err != nil {
		t.Fatal(err)
	}
	defer sidechannel.listener.Close()
	go sidechannel.serve()

	cmd := exec.Command(executable)
	cmd.Env = append(os.Environ(), "WBT_HOSTED_SIDECAR_ADDR="+sidechannel.address(), "WBT_HOSTED_SIDECAR_TOKEN="+sidechannel.token)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	var ready bool
	for !ready {
		select {
		case event := <-sink.events:
			if event.Kind == "runtime_ready" {
				ready = true
			}
		case <-time.After(10 * time.Second):
			t.Fatal("hosted runtime did not become ready")
		}
	}
	if _, err := io.WriteString(stdin, "Write-Output 'first'; Start-Sleep -Milliseconds 500; Write-Output 'second'\n"); err != nil {
		t.Fatal(err)
	}

	firstOutputAt := time.Time{}
	finishAt := time.Time{}
	firstCount := 0
	secondCount := 0
	for finishAt.IsZero() {
		select {
		case event := <-sink.events:
			switch event.Kind {
			case "output":
				if strings.TrimSpace(event.Data) == "first" {
					firstCount++
					firstOutputAt = time.Now()
				}
				if strings.TrimSpace(event.Data) == "second" {
					secondCount++
				}
			case "command_finished":
				finishAt = time.Now()
			}
		case <-time.After(10 * time.Second):
			t.Fatal("hosted command did not finish")
		}
	}
	if firstOutputAt.IsZero() {
		t.Fatal("first output was not observed")
	}
	if !firstOutputAt.Before(finishAt) {
		t.Fatal("first output was not delivered before command completion")
	}
	if firstCount != 1 || secondCount != 1 {
		t.Fatalf("output was not delivered exactly once: first=%d second=%d", firstCount, secondCount)
	}
}

func TestHostedPowerShellStreamsDirectNativeOutput(t *testing.T) {
	executable := hostedPowerShellTestExecutable(t)
	sink := &hostedStreamingSink{events: make(chan HostedRuntimeEvent, 32)}
	sidechannel, err := newHostedSidechannel("native-streaming-test", sink)
	if err != nil {
		t.Fatal(err)
	}
	defer sidechannel.listener.Close()
	go sidechannel.serve()

	cmd := exec.Command(executable)
	cmd.Env = append(os.Environ(), "WBT_HOSTED_SIDECAR_ADDR="+sidechannel.address(), "WBT_HOSTED_SIDECAR_TOKEN="+sidechannel.token)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	for {
		select {
		case event := <-sink.events:
			if event.Kind == "runtime_ready" {
				goto ready
			}
		case <-time.After(10 * time.Second):
			t.Fatal("hosted runtime did not become ready")
		}
	}

ready:
	if _, err := io.WriteString(stdin, `cmd /c "echo first && ping 127.0.0.1 -n 3 -w 500 >nul && echo second"`+"\n"); err != nil {
		t.Fatal(err)
	}
	firstOutputAt := time.Time{}
	finishAt := time.Time{}
	firstCount := 0
	secondCount := 0
	for finishAt.IsZero() {
		select {
		case event := <-sink.events:
			switch event.Kind {
			case "output":
				if strings.TrimSpace(event.Data) == "first" {
					firstCount++
					firstOutputAt = time.Now()
				}
				if strings.TrimSpace(event.Data) == "second" {
					secondCount++
				}
			case "command_finished":
				finishAt = time.Now()
			}
		case <-time.After(10 * time.Second):
			t.Fatal("direct native command did not finish")
		}
	}
	if firstOutputAt.IsZero() || !firstOutputAt.Before(finishAt) {
		t.Fatal("direct native output was not delivered before command completion")
	}
	if firstCount != 1 || secondCount != 1 {
		t.Fatalf("direct native output was not delivered exactly once: first=%d second=%d", firstCount, secondCount)
	}
}
