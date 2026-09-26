# A Wave integration is owned by the top-level PowerShell process. The marker
# is inherited by child shells so nested pwsh sessions remain ordinary PTY
# applications instead of becoming new product sessions.
if ($env:WAVETERM_SI_OWNER_PID -and $env:WAVETERM_SI_OWNER_PID -ne "$PID") {
    return
}
if ($env:WAVETERM_SI_INSTALLED -eq "1") {
    return
}
$env:WAVETERM_SI_OWNER_PID = "$PID"
$env:WAVETERM_SI_INSTALLED = "1"

# We source this file with -NoExit -File
$env:PATH = {{.WSHBINDIR_PWSH}} + "{{.PATHSEP}}" + $env:PATH

# Source dynamic script from wsh token
$waveterm_swaptoken_output = wsh token $env:WAVETERM_SWAPTOKEN pwsh 2>$null | Out-String
if ($waveterm_swaptoken_output -and $waveterm_swaptoken_output -ne "") {
    Invoke-Expression $waveterm_swaptoken_output
}
Remove-Variable -Name waveterm_swaptoken_output
Remove-Item Env:WAVETERM_SWAPTOKEN

# Load Wave completions
wsh completion powershell | Out-String | Invoke-Expression

if ($PSVersionTable.PSVersion.Major -lt 7) {
    return  # skip OSC setup entirely
}

if ($PSStyle.FileInfo.Directory -eq "`e[44;1m") {
    $PSStyle.FileInfo.Directory = "`e[34;1m"
}

$Global:_WAVETERM_SI_FIRSTPROMPT = $true
$Global:_WAVETERM_SI_PROTOCOL_VERSION = 1
$Global:_WAVETERM_SI_SESSION_EPOCH = [guid]::NewGuid().ToString("N")
$Global:_WAVETERM_SI_HOOK_SEQUENCE = 0
$Global:_WAVETERM_SI_LAST_COMMAND_ID = $null
$Global:_WAVETERM_SI_LAST_COMMAND_NATIVE = $false
$Global:_WAVETERM_SI_INTEGRATION_ACTIVE = $false

# shell integration
function Global:_waveterm_si_blocked {
    # Check if we're in tmux or screen
    return ($env:TMUX -or $env:STY -or $env:TERM -like "tmux*" -or $env:TERM -like "screen*")
}

# Returns the OSC 7 frame for the current directory (percent-encoded as-is,
# which handles UNC paths and drive letters). Like the other prompt frames it is
# returned rather than written, so it is rendered with the prompt text.
function Global:_waveterm_si_osc7 {
    if (_waveterm_si_blocked) { return "" }
    $encoded_pwd = [System.Uri]::EscapeDataString($PWD.Path)
    return "`e]7;file://localhost/$encoded_pwd`a"
}

function Global:_waveterm_si_next_sequence {
    $Global:_WAVETERM_SI_HOOK_SEQUENCE += 1
    return [uint64]$Global:_WAVETERM_SI_HOOK_SEQUENCE
}

function Global:_waveterm_si_b64([string]$value) {
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($value ?? "")))
}

function Global:_waveterm_si_frame([string]$kind, [hashtable]$payload) {
    try {
        $json = $payload | ConvertTo-Json -Compress
        return ("`e]16162;{0};{1}`a" -f $kind, $json)
    } catch {
        # Shell integration must never make the user's prompt fail.
        return ""
    }
}

function Global:_waveterm_si_emit([string]$kind, [hashtable]$payload) {
    $frame = _waveterm_si_frame $kind $payload
    if ($frame) {
        Write-Host -NoNewline $frame
    }
}

function Global:_waveterm_si_is_direct_native_invocation([string]$command) {
    try {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors)
        if (@($errors).Count -ne 0) { return $false }
        $statements = @($ast.EndBlock.Statements)
        if ($statements.Count -ne 1) { return $false }
        $pipeline = $statements[0] -as [System.Management.Automation.Language.PipelineAst]
        if ($null -eq $pipeline -or $pipeline.PipelineElements.Count -ne 1) { return $false }
        $commandAst = $pipeline.PipelineElements[0] -as [System.Management.Automation.Language.CommandAst]
        if ($null -eq $commandAst) { return $false }
        $commandName = $commandAst.GetCommandName()
        if ([string]::IsNullOrWhiteSpace($commandName)) { return $false }
        $resolved = Get-Command $commandName -ErrorAction Stop
        return $resolved.CommandType -eq "Application"
    } catch { return $false }
}

function Global:_waveterm_si_command_is_complete([string]$command) {
    try {
        $tokens = $null
        $errors = $null
        [System.Management.Automation.Language.Parser]::ParseInput($command, [ref]$tokens, [ref]$errors) | Out-Null
        foreach ($errorRecord in @($errors)) {
            # These parser diagnostics mean PSReadLine is expected to enter
            # continuation mode rather than accept/execute the buffer.
            if ($errorRecord.ErrorId -match '^(IncompleteParse|MissingEnd|ExpectedExpression|TerminatorExpected|MissingStatementBlock)') {
                return $false
            }
        }
        return $true
    } catch {
        # Preserve the terminal path if parser inspection is unavailable.
        return $true
    }
}

function Global:_waveterm_si_command_started {
    try {
        $line = ""
        $cursor = 0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        if ([string]::IsNullOrWhiteSpace($line)) { return $false }
        if (_waveterm_si_blocked) { return $false }
        if (-not (_waveterm_si_command_is_complete $line)) { return $false }
        $sequence = _waveterm_si_next_sequence
        $id = "{0}-{1}" -f $Global:_WAVETERM_SI_SESSION_EPOCH, $sequence
        $nonce = [guid]::NewGuid().ToString("N")
        $Global:_WAVETERM_SI_LAST_COMMAND_ID = $id
        $Global:_WAVETERM_SI_LAST_COMMAND_NATIVE = _waveterm_si_is_direct_native_invocation $line
        # The anchor marks where this command starts in the byte stream. It
        # carries the command's own identity (epoch, sequence, id) so the
        # marker and the record can be paired; it deliberately carries no
        # host/runspace identity - that belongs to the hosted authority only.
        _waveterm_si_emit "B" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = $sequence; id = $id; nonce = $nonce; phase = "start" }
        _waveterm_si_emit "C" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = $sequence; id = $id; nonce = $nonce; cmd64 = (_waveterm_si_b64 $line); cwd64 = (_waveterm_si_b64 $PWD.Path) }
        return $true
    } catch { return $false }
}

function Global:_waveterm_si_command_finished([bool]$success, [int]$nativeExitCode) {
    if ($null -eq $Global:_WAVETERM_SI_LAST_COMMAND_ID) { return "" }
    $exitCode = if ($Global:_WAVETERM_SI_LAST_COMMAND_NATIVE) { $nativeExitCode } elseif ($success) { 0 } else { 1 }
    $finalSuccess = if ($Global:_WAVETERM_SI_LAST_COMMAND_NATIVE) { $exitCode -eq 0 } else { $success }
    $sequence = _waveterm_si_next_sequence
    $frame = _waveterm_si_frame "D" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = $sequence; id = $Global:_WAVETERM_SI_LAST_COMMAND_ID; success = [bool]$finalSuccess; exitcode = [int]$exitCode; cwd64 = (_waveterm_si_b64 $PWD.Path) }
    $Global:_WAVETERM_SI_LAST_COMMAND_ID = $null
    $Global:_WAVETERM_SI_LAST_COMMAND_NATIVE = $false
    return $frame
}

function Global:_waveterm_si_prompt_ready {
    if (_waveterm_si_blocked) { return "" }
    $sequence = _waveterm_si_next_sequence
    return _waveterm_si_frame "P" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = $sequence; cwd64 = (_waveterm_si_b64 $PWD.Path) }
}

# PSReadLine is the earliest supported PowerShell boundary for a command that
# is about to be accepted. The original terminal input path is still used.
try {
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction Stop) {
        Set-PSReadLineKeyHandler -Key Enter -BriefDescription "WaveCommandStarted" -ScriptBlock {
            [void](_waveterm_si_command_started)
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $Global:_WAVETERM_SI_INTEGRATION_ACTIVE = $true
    }
} catch {
    $Global:_WAVETERM_SI_INTEGRATION_ACTIVE = $false
}

# Builds the integration frames for the prompt that is about to be displayed.
#
# These frames are *returned*, not written: the host renders the prompt text
# after everything the previous command printed, so frames that travel with the
# prompt text are ordered behind that output by construction. Writing them here
# with Write-Host instead would race the pipeline's own output writer, which is
# what let a finish frame overtake the command's last output.
function Global:_waveterm_si_prompt {
    $lastSuccess = [bool]$?
    $nativeExitCode = $LASTEXITCODE
    if (_waveterm_si_blocked) { return "" }

    $frames = _waveterm_si_command_finished $lastSuccess $nativeExitCode

    if ($Global:_WAVETERM_SI_FIRSTPROMPT) {
        $shellversion = $PSVersionTable.PSVersion.ToString()
        $frames += _waveterm_si_frame "M" @{ v = 1; epoch = $Global:_WAVETERM_SI_SESSION_EPOCH; seq = (_waveterm_si_next_sequence); shell = "pwsh"; shellversion = $shellversion; integration = [bool]$Global:_WAVETERM_SI_INTEGRATION_ACTIVE }
        $Global:_WAVETERM_SI_FIRSTPROMPT = $false
    }

    $frames += _waveterm_si_prompt_ready

    # OSC 7 announces the working directory in the same render, for the same
    # ordering reason.
    $frames += _waveterm_si_osc7

    return $frames
}

# The user's prompt stays exactly as it is: the integration frames ride with
# whatever the prompt function returns, and the prompt result keeps its shape (a
# string stays a string, an array keeps its elements). They are appended after
# the display text, because the host renders the prompt only once the previous
# command's output has been written; frames placed before the display can be
# flushed ahead of that output.
if (Test-Path Function:\prompt) {
    $global:_waveterm_original_prompt = $function:prompt
    function Global:prompt {
        $frames = _waveterm_si_prompt
        $display = & $global:_waveterm_original_prompt
        if ($display -is [string]) {
            return "$display$frames"
        }
        return @($display) + @($frames)
    }
} else {
    function Global:prompt {
        $frames = _waveterm_si_prompt
        return "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " + "$frames"
    }
}
