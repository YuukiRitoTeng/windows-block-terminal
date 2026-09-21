//go:build windows

package shellexec

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type hostedStreamingSink struct {
	events      chan HostedRuntimeEvent
	disconnects chan struct{}
}

func (s *hostedStreamingSink) ObserveHostedRuntimeEvent(event HostedRuntimeEvent) {
	s.events <- event
}

func (s *hostedStreamingSink) ObserveHostedRuntimeDisconnect() {
	if s.disconnects != nil {
		s.disconnects <- struct{}{}
	}
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

func hostedPowerShellTestExecutableRequired(t *testing.T) string {
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
	t.Fatalf("WbtHostedPowerShell executable is required for the positive hosted wsh resolution assertion")
	return ""
}

func TestHostedPowerShellInitializesWshBeforeFirstPrompt(t *testing.T) {
	executable := hostedPowerShellTestExecutableRequired(t)
	wshDir := t.TempDir()
	wshPath := filepath.Join(wshDir, "wsh.cmd")
	wshScript := "@echo off\r\n" +
		"if /I \"%~1\"==\"token\" (\r\n" +
		"  echo $env:WBT_TEST_WSH_TOKEN = 'resolved'\r\n" +
		"  exit /b 0\r\n" +
		")\r\n" +
		"exit /b 0\r\n"
	if err := os.WriteFile(wshPath, []byte(wshScript), 0700); err != nil {
		t.Fatal(err)
	}

	sink := &hostedStreamingSink{events: make(chan HostedRuntimeEvent, 32)}
	sidechannel, err := newHostedSidechannel("wsh-init-test", sink)
	if err != nil {
		t.Fatal(err)
	}
	defer sidechannel.listener.Close()
	go sidechannel.serve()

	tracePath := filepath.Join(t.TempDir(), "hosted-trace.log")
	cmd := exec.Command(executable)
	cmd.Env = append(os.Environ(),
		"WBT_HOSTED_SIDECAR_ADDR="+sidechannel.address(),
		"WBT_HOSTED_SIDECAR_TOKEN="+sidechannel.token,
		"WBT_HOSTED_TRACE_PATH="+tracePath,
		"WAVETERM_WSHBINDIR="+wshDir,
		"WAVETERM_SWAPTOKEN=swap-test-token",
		"WAVETERM_SI_OWNER_PID=foreign-owner",
		"WAVETERM_SI_INSTALLED=1",
		"PATH="+wshDir+string(os.PathListSeparator)+os.Getenv("PATH"),
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stdoutDone := make(chan []byte, 1)
	stderrDone := make(chan []byte, 1)
	go func() { data, _ := io.ReadAll(stdout); stdoutDone <- data }()
	go func() { data, _ := io.ReadAll(stderr); stderrDone <- data }()

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
	command := "if ((Get-Command wsh).CommandType -ne 'Application') { throw 'wsh is not an application' }; if ($env:WBT_TEST_WSH_TOKEN -ne 'resolved') { throw 'swap token script was not invoked' }; Write-Output 'WBT_WSH_RESOLVED'"
	if _, err := io.WriteString(stdin, command+"\n"); err != nil {
		t.Fatal(err)
	}
	outputCount := 0
	var outputData []string
	finishedCount := 0
	for finishedCount == 0 {
		select {
		case event := <-sink.events:
			switch event.Kind {
			case "output":
				outputData = append(outputData, event.Data)
				if strings.Contains(event.Data, "WBT_WSH_RESOLVED") {
					outputCount++
				}
			case "command_finished":
				finishedCount++
				if event.ExitCode == nil || *event.ExitCode != 0 || event.Success == nil || !*event.Success {
					traceData, _ := os.ReadFile(tracePath)
					t.Fatalf("wsh resolution command failed: %#v output=%q trace=%q", event, outputData, string(traceData))
				}
			}
		case <-time.After(10 * time.Second):
			t.Fatal("wsh resolution command did not finish")
		}
	}
	if outputCount != 1 {
		t.Fatalf("expected one structured wsh resolution output, got %d", outputCount)
	}
	if _, err := io.WriteString(stdin, ":quit\n"); err != nil {
		t.Fatal(err)
	}
	_ = stdin.Close()
	waitDone := make(chan error, 1)
	go func() { waitDone <- cmd.Wait() }()
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatalf("hosted runtime exit failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("hosted runtime did not exit")
	}
	stdoutData := <-stdoutDone
	_ = <-stderrDone
	traceData, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatal(err)
	}
	traceText := string(traceData)
	if !strings.Contains(traceText, "SI_INIT_FOREIGN_OWNER") || !strings.Contains(traceText, "SI_INIT_INSTALLED") {
		t.Fatalf("hosted SI guards were not explicitly handled: %s", traceText)
	}
	if strings.Contains(string(stdoutData), "\x1b]7;") || strings.Contains(string(stdoutData), "_waveterm_si_") {
		t.Fatalf("hosted output contains shell-integration OSC/authority output: %q", string(stdoutData))
	}
	if anchors := bytes.Count(stdoutData, []byte("\x1b]16162;B;")); anchors != 1 {
		t.Fatalf("expected one Program.cs visual anchor and no duplicate OSC authority, got %d", anchors)
	}
	t.Logf("hosted wsh resolution executed=1 skipped=0 structured_outputs=%d visual_anchors=1", outputCount)
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

func TestHostedPowerShellTerminationNotifiesDisconnect(t *testing.T) {
	executable := hostedPowerShellTestExecutable(t)
	sink := &hostedStreamingSink{events: make(chan HostedRuntimeEvent, 32), disconnects: make(chan struct{}, 1)}
	sidechannel, err := newHostedSidechannel("termination-test", sink)
	if err != nil {
		t.Fatal(err)
	}
	defer sidechannel.listener.Close()
	go sidechannel.serve()

	cmd := exec.Command(executable)
	cmd.Env = append(os.Environ(), "WBT_HOSTED_SIDECAR_ADDR="+sidechannel.address(), "WBT_HOSTED_SIDECAR_TOKEN="+sidechannel.token)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	for {
		select {
		case event := <-sink.events:
			if event.Kind == "runtime_ready" {
				if err := cmd.Process.Kill(); err != nil {
					t.Fatal(err)
				}
				select {
				case <-sink.disconnects:
					return
				case <-time.After(10 * time.Second):
					t.Fatal("hosted child termination did not close sidechannel")
				}
			}
		case <-time.After(10 * time.Second):
			t.Fatal("hosted runtime did not become ready")
		}
	}
}
