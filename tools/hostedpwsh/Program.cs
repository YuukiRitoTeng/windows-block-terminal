using System.Collections.ObjectModel;
using System.Globalization;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Language;
using System.Management.Automation.Runspaces;
using System.Net.Sockets;
using System.Security;
using System.Text.Json;

namespace WbtHostedPowerShell;

sealed class TraceLog : IDisposable
{
    readonly StreamWriter writer;
    readonly object gate = new();

    public TraceLog(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        writer = new StreamWriter(path, false) { AutoFlush = true };
    }

    public void Write(string message)
    {
        lock (gate) writer.WriteLine($"{DateTimeOffset.UtcNow:O} {message}");
    }

    public void Dispose() { lock (gate) writer.Dispose(); }
}

sealed class Sidechannel : IDisposable
{
    readonly object gate = new();
    readonly TraceLog trace;
    TcpClient? client;
    StreamWriter? writer;

    public Sidechannel(TraceLog trace) { this.trace = trace; }

    public void Connect()
    {
        var address = Environment.GetEnvironmentVariable("WBT_HOSTED_SIDECAR_ADDR");
        var token = Environment.GetEnvironmentVariable("WBT_HOSTED_SIDECAR_TOKEN");
        if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(token))
        {
            trace.Write("SIDECAR_DISABLED reason=missing_environment");
            return;
        }
        try
        {
            var split = address.LastIndexOf(':');
            var host = address[..split];
            var port = int.Parse(address[(split + 1)..], CultureInfo.InvariantCulture);
            client = new TcpClient();
            client.Connect(host, port);
            writer = new StreamWriter(client.GetStream()) { AutoFlush = true };
            Send(new { kind = "hello", token, hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture) });
            trace.Write("SIDECAR_CONNECTED");
        }
        catch (Exception ex)
        {
            trace.Write($"SIDECAR_ERROR type={ex.GetType().Name} message={Escape(ex.Message)}");
            Dispose();
        }
    }

    public void Send(object value)
    {
        lock (gate)
        {
            if (writer is null) return;
            try { writer.WriteLine(JsonSerializer.Serialize(value)); }
            catch (Exception ex) { trace.Write($"SIDECAR_WRITE_ERROR message={Escape(ex.Message)}"); }
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            writer?.Dispose();
            client?.Dispose();
            writer = null;
            client = null;
        }
    }

    static string Escape(string? value) => (value ?? "").Replace("\r", "\\r").Replace("\n", "\\n");
}

sealed class HostedHost : PSHost
{
    readonly TraceLog trace;
    public HostedHost(TraceLog trace, Action<string> writeOutput)
    {
        this.trace = trace;
        UI = new HostedUi(trace, writeOutput);
    }

    public override Guid InstanceId { get; } = Guid.NewGuid();
    public override string Name => "WindowsBlockTerminalHostedPowerShell";
    public override Version Version => new(1, 0);
    public override PSHostUserInterface UI { get; }
    public override CultureInfo CurrentCulture => CultureInfo.InvariantCulture;
    public override CultureInfo CurrentUICulture => CultureInfo.InvariantCulture;
    public override void SetShouldExit(int exitCode) => trace.Write($"HOST_SHOULD_EXIT code={exitCode}");
    public override void EnterNestedPrompt() => trace.Write("HOST_NESTED_PROMPT");
    public override void ExitNestedPrompt() => trace.Write("HOST_EXIT_NESTED_PROMPT");
    public override void NotifyBeginApplication() => trace.Write("HOST_BEGIN_APPLICATION");
    public override void NotifyEndApplication() => trace.Write("HOST_END_APPLICATION");
}

sealed class HostedUi : PSHostUserInterface
{
    readonly TraceLog trace;
    readonly Action<string> writeOutput;
    readonly HostedRawUi raw = new();

    public HostedUi(TraceLog trace, Action<string> writeOutput)
    {
        this.trace = trace;
        this.writeOutput = writeOutput;
    }

    public override PSHostRawUserInterface RawUI => raw;
    public override string ReadLine() => Console.ReadLine() ?? "";
    public override SecureString ReadLineAsSecureString() => new();
    public override void Write(string value) { Console.Write(value); writeOutput(value); }
    public override void Write(ConsoleColor foregroundColor, ConsoleColor backgroundColor, string value) => Write(value);
    public override void WriteLine(string value) { Console.WriteLine(value); writeOutput(value + Environment.NewLine); }
    public override void WriteErrorLine(string value) { Console.Error.WriteLine(value); writeOutput(value + Environment.NewLine); }
    public override void WriteDebugLine(string message) => trace.Write($"STREAM_DEBUG text={Escape(message)}");
    public override void WriteVerboseLine(string message) => trace.Write($"STREAM_VERBOSE text={Escape(message)}");
    public override void WriteWarningLine(string message) => trace.Write($"STREAM_WARNING text={Escape(message)}");
    public override void WriteProgress(long sourceId, ProgressRecord record) => trace.Write($"STREAM_PROGRESS status={Escape(record.StatusDescription)}");
    public override void WriteInformation(InformationRecord record) { Console.WriteLine(record); writeOutput(record + Environment.NewLine); }
    public override Dictionary<string, PSObject> Prompt(string caption, string message, Collection<FieldDescription> descriptions) => new();
    public override int PromptForChoice(string caption, string message, Collection<ChoiceDescription> choices, int defaultChoice) => defaultChoice;
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName) => throw new NotSupportedException();
    public override PSCredential PromptForCredential(string caption, string message, string userName, string targetName, PSCredentialTypes allowedCredentialTypes, PSCredentialUIOptions options) => throw new NotSupportedException();
    static string Escape(string? value) => (value ?? "").Replace("\r", "\\r").Replace("\n", "\\n");
}

sealed class HostedRawUi : PSHostRawUserInterface
{
    ConsoleColor foreground = Console.ForegroundColor;
    ConsoleColor background = Console.BackgroundColor;
    Coordinates cursor = new(0, 0);
    Coordinates window = new(0, 0);
    Size buffer = new(120, 9001);
    Size windowSize = new(120, 40);
    int cursorSize = 25;
    public override ConsoleColor ForegroundColor { get => foreground; set => foreground = value; }
    public override ConsoleColor BackgroundColor { get => background; set => background = value; }
    public override Coordinates CursorPosition { get => cursor; set => cursor = value; }
    public override Coordinates WindowPosition { get => window; set => window = value; }
    public override int CursorSize { get => cursorSize; set => cursorSize = value; }
    public override Size BufferSize { get => buffer; set => buffer = value; }
    public override Size WindowSize { get => windowSize; set => windowSize = value; }
    public override Size MaxWindowSize => windowSize;
    public override Size MaxPhysicalWindowSize => windowSize;
    public override KeyInfo ReadKey(ReadKeyOptions options)
    {
        var key = Console.ReadKey((options & ReadKeyOptions.NoEcho) != 0);
        return new KeyInfo((int)key.Key, key.KeyChar, (ControlKeyStates)0, true);
    }
    public override void FlushInputBuffer() { }
    public override bool KeyAvailable => Console.KeyAvailable;
    public override string WindowTitle { get => Console.Title; set => Console.Title = value; }
    public override void SetBufferContents(Coordinates origin, BufferCell[,] contents) { }
    public override void SetBufferContents(Rectangle rectangle, BufferCell fill) { }
    public override BufferCell[,] GetBufferContents(Rectangle rectangle) => new BufferCell[Math.Max(0, rectangle.Bottom - rectangle.Top + 1), Math.Max(0, rectangle.Right - rectangle.Left + 1)];
    public override void ScrollBufferContents(Rectangle source, Coordinates destination, Rectangle clip, BufferCell fill) { }
}

static class Program
{
    static Runspace? runspace;
    static PowerShell? currentInvocation;
    static Sidechannel? sidechannel;
    static TraceLog? trace;
    static int commandNumber;
    static long hookSequence;
    static bool interactiveChildActive;
    static int structuredInvocationInterrupted;

    public static int Main()
    {
        var tracePath = Environment.GetEnvironmentVariable("WBT_HOSTED_TRACE_PATH") ?? Path.Combine(Path.GetTempPath(), $"wbt-hosted-{Environment.ProcessId}.log");
        using var log = new TraceLog(tracePath);
        trace = log;
        sidechannel = new Sidechannel(log);
        sidechannel.Connect();
        log.Write($"HOST_START pid={Environment.ProcessId}");
        Console.CancelKeyPress += OnCancel;
        var host = new HostedHost(log, text => EmitOutput(text, null, "host"));
        using var rs = RunspaceFactory.CreateRunspace(host);
        runspace = rs;
        rs.Open();
        log.Write($"RUNSPACE_OPEN instance_id={rs.InstanceId}");
        sidechannel.Send(new { kind = "runtime_ready", hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture), runspaceId = rs.InstanceId.ToString("N") });
        Console.WriteLine("WBT hosted PowerShell ready");

        while (true)
        {
            Console.Write("WBT> ");
            var line = Console.ReadLine();
            if (line is null || line.Equals(":quit", StringComparison.OrdinalIgnoreCase)) break;
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (line.Equals("python", StringComparison.OrdinalIgnoreCase))
            {
                RunInteractive("python", "");
                continue;
            }
            if (line.StartsWith(":interactive ", StringComparison.OrdinalIgnoreCase))
            {
                var rest = line[":interactive ".Length..].Trim();
                var split = rest.IndexOf(' ');
                RunInteractive(split < 0 ? rest : rest[..split], split < 0 ? "" : rest[(split + 1)..]);
                continue;
            }
            RunScript(line);
        }

        log.Write($"RUNSPACE_CLOSE instance_id={rs.InstanceId}");
        sidechannel.Dispose();
        return 0;
    }

    static void RunScript(string command)
    {
        var id = $"{runspace!.InstanceId:N}-{Interlocked.Increment(ref commandNumber)}";
        var startSequence = NextHookSequence();
        var anchorNonce = Guid.NewGuid().ToString("N");
        var directNative = IsDirectNative(command);
        Interlocked.Exchange(ref structuredInvocationInterrupted, 0);
        trace!.Write($"INVOKE_BEGIN command_id={id} mode=structured direct_native={directNative} command={Escape(command)} runspace_id={runspace.InstanceId}");
        sidechannel!.Send(new { kind = "command_started", hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture), runspaceId = runspace.InstanceId.ToString("N"), commandId = id, anchorNonce, hookSequence = startSequence, mode = "structured", command, cwd = CurrentCwd() });
        EmitVisualAnchor(id, anchorNonce, startSequence);
        using var ps = PowerShell.Create();
        currentInvocation = ps;
        ps.Runspace = runspace;
        ps.AddScript(command + Environment.NewLine + "$__wbt_success=[bool]$?; $__wbt_lastExit=$LASTEXITCODE; Write-Output ('__WBT_META__|success=' + $__wbt_success + '|lastExit=' + $__wbt_lastExit)");
        var output = new PSDataCollection<PSObject>();
        string? meta = null;
        var errorCount = 0;
        output.DataAdded += (_, args) =>
        {
            var item = output[args.Index];
            var text = item?.ToString() ?? "";
            trace.Write($"INVOKE_OUTPUT_ITEM command_id={id} value={Escape(text)}");
            if (text.StartsWith("__WBT_META__|", StringComparison.Ordinal))
            {
                meta = text;
                return;
            }
            Console.WriteLine(text);
            EmitOutput(text + Environment.NewLine, id, "success");
        };
        ps.Streams.Error.DataAdded += (_, args) =>
        {
            var error = ps.Streams.Error[args.Index];
            var text = error.ToString();
            Interlocked.Exchange(ref errorCount, 1);
            Console.Error.WriteLine(text);
            EmitOutput(text + Environment.NewLine, id, "error");
        };
        try
        {
            var asyncResult = ps.BeginInvoke<PSObject, PSObject>(null, output);
            ps.EndInvoke(asyncResult);
        }
        catch (Exception ex)
        {
            var rendered = RenderInvocationError(ps, ex);
            Console.Error.WriteLine(rendered);
            EmitOutput(rendered + Environment.NewLine, id, "error");
            trace.Write($"INVOKE_EXCEPTION command_id={id} type={ex.GetType().Name} message={Escape(ex.Message)}");
            var wasInterrupted = Volatile.Read(ref structuredInvocationInterrupted) != 0 || ps.InvocationStateInfo.State == PSInvocationState.Stopped;
            EmitFinished(id, false, 1, wasInterrupted);
            currentInvocation = null;
            return;
        }
        var success = ParseMeta(meta, "success", false);
        var nativeExit = ParseMeta(meta, "lastExit", 0);
        var interrupted = Volatile.Read(ref structuredInvocationInterrupted) != 0 || ps.InvocationStateInfo.State == PSInvocationState.Stopped;
        if (errorCount != 0 || ps.InvocationStateInfo.State == PSInvocationState.Failed) success = false;
        var exitCode = directNative && !interrupted ? nativeExit : (success ? 0 : 1);
        if (interrupted)
        {
            success = false;
            exitCode = 1;
        }
        trace.Write($"INVOKE_OUTPUT_COUNT command_id={id} count={output.Count} meta={Escape(meta)} interrupted={interrupted}");
        EmitFinished(id, success, exitCode, interrupted);
        trace.Write($"INVOKE_END command_id={id} success={success} exit_code={exitCode} state={ps.InvocationStateInfo.State} runspace_id={runspace.InstanceId}");
        currentInvocation = null;
    }

    static void RunInteractive(string executable, string arguments)
    {
        var id = $"{runspace!.InstanceId:N}-{Interlocked.Increment(ref commandNumber)}";
        var startSequence = NextHookSequence();
        interactiveChildActive = true;
        trace!.Write($"INTERACTIVE_BEGIN command_id={id} executable={Escape(executable)} runspace_id={runspace.InstanceId}");
        sidechannel!.Send(new { kind = "command_started", hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture), runspaceId = runspace.InstanceId.ToString("N"), commandId = id, hookSequence = startSequence, mode = "interactive", command = executable, cwd = CurrentCwd() });
        using var child = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = executable,
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardInput = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
                CreateNoWindow = false,
            },
        };
        try
        {
            if (!child.Start()) throw new InvalidOperationException("native child did not start");
            trace.Write($"INTERACTIVE_CHILD_START command_id={id} child_pid={child.Id} executable={Escape(executable)}");
            child.WaitForExit();
            var code = child.ExitCode;
            trace.Write($"INTERACTIVE_CHILD_EXIT command_id={id} child_pid={child.Id} exit_code={code} runspace_id={runspace.InstanceId}");
            EmitFinished(id, code == 0, code, false);
        }
        catch (Exception ex)
        {
            trace.Write($"INTERACTIVE_EXCEPTION command_id={id} type={ex.GetType().Name} message={Escape(ex.Message)}");
            EmitFinished(id, false, 1, false);
        }
        finally { interactiveChildActive = false; }
    }

    static bool IsDirectNative(string command)
    {
        try
        {
            var ast = Parser.ParseInput(command, out var tokens, out var errors);
            if (errors.Length != 0 || ast.EndBlock.Statements.Count != 1) return false;
            if (ast.EndBlock.Statements[0] is not PipelineAst pipeline || pipeline.PipelineElements.Count != 1) return false;
            if (pipeline.PipelineElements[0] is not CommandAst commandAst) return false;
            var name = commandAst.GetCommandName();
            if (string.IsNullOrWhiteSpace(name)) return false;
            using var ps = PowerShell.Create();
            ps.Runspace = runspace;
            var result = ps.AddCommand("Get-Command").AddParameter("Name", name).Invoke().FirstOrDefault();
            return result?.BaseObject is CommandInfo info && info.CommandType == CommandTypes.Application;
        }
        catch { return false; }
    }

    static void EmitOutput(string text, string? commandId, string stream)
    {
        sidechannel?.Send(new { kind = "output", hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture), runspaceId = runspace?.InstanceId.ToString("N"), commandId, mode = "structured", stream, data = text });
    }

    static ulong NextHookSequence() => (ulong)Interlocked.Increment(ref hookSequence);

    static void EmitVisualAnchor(string commandId, string anchorNonce, ulong sequence)
    {
        var payload = JsonSerializer.Serialize(new
        {
            v = 1,
            epoch = runspace!.InstanceId.ToString("N"),
            seq = sequence,
            id = commandId,
            nonce = anchorNonce,
            phase = "start",
            hostid = Environment.ProcessId.ToString(CultureInfo.InvariantCulture),
            runspaceid = runspace.InstanceId.ToString("N"),
        });
        Console.Write($"\x1b]16162;B;{payload}\a");
        Console.Out.Flush();
        trace!.Write($"VISUAL_ANCHOR command_id={commandId} nonce={anchorNonce} hook_sequence={sequence}");
    }

    static string CurrentCwd()
    {
        try { return runspace?.SessionStateProxy.Path.CurrentFileSystemLocation.Path ?? ""; }
        catch { return ""; }
    }

    static void EmitFinished(string id, bool success, int exitCode, bool interrupted)
    {
        var hookSequence = NextHookSequence();
        sidechannel?.Send(new { kind = "command_finished", hostId = Environment.ProcessId.ToString(CultureInfo.InvariantCulture), runspaceId = runspace?.InstanceId.ToString("N"), commandId = id, hookSequence, success, exitCode, interrupted });
    }

    static string RenderInvocationError(PowerShell ps, Exception exception)
    {
        var streamError = ps.Streams.Error.FirstOrDefault();
        if (streamError is not null) return streamError.ToString();
        return exception.Message;
    }

    static void OnCancel(object? sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true;
        trace?.Write("CTRL_C_RECEIVED");
        if (!interactiveChildActive)
        {
            try
            {
                if (currentInvocation is not null)
                {
                    Interlocked.Exchange(ref structuredInvocationInterrupted, 1);
                    currentInvocation.Stop();
                    trace?.Write("CTRL_C_STOP_REQUESTED");
                }
            }
            catch (Exception ex) { trace?.Write($"CTRL_C_STOP_ERROR message={Escape(ex.Message)}"); }
        }
    }

    static bool ParseMeta(string? meta, string key, bool fallback)
    {
        if (meta is null) return fallback;
        var value = meta.Split('|').FirstOrDefault(x => x.StartsWith(key + "=", StringComparison.Ordinal));
        return value is not null && bool.TryParse(value[(key.Length + 1)..], out var result) ? result : fallback;
    }

    static int ParseMeta(string? meta, string key, int fallback)
    {
        if (meta is null) return fallback;
        var value = meta.Split('|').FirstOrDefault(x => x.StartsWith(key + "=", StringComparison.Ordinal));
        return value is not null && int.TryParse(value[(key.Length + 1)..], CultureInfo.InvariantCulture, out var result) ? result : fallback;
    }

    static string Escape(string? value) => (value ?? "").Replace("\r", "\\r").Replace("\n", "\\n");
}
