namespace Runova.RemoteAgent.Linux;

/// <summary>An X server on this computer: its auth file, the terminal it is on, and its display when it names one.</summary>
public sealed record XServer(string AuthFile, int? Terminal, string? Display);

/// <summary>
/// Finds the X server showing on the physical screen (E65). The display managers (GDM, LightDM,
/// SDDM) all start Xorg with the auth file and terminal on its command line, for the greeter and
/// for a signed-in desktop alike, so reading those is enough and needs no per-manager code. A
/// Wayland greeter has no such server, and the agent then reports no screen.
/// </summary>
public static class XServerDiscovery
{
    /// <param name="commandLine">A process's <c>/proc/pid/cmdline</c>: arguments ended by NUL.</param>
    public static XServer? Parse(string commandLine)
    {
        ArgumentNullException.ThrowIfNull(commandLine);
        var arguments = commandLine.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        if (arguments.Length == 0 || Path.GetFileName(arguments[0]) is not ("Xorg" or "X"))
        {
            return null;
        }

        string? auth = null;
        string? display = null;
        int? terminal = null;
        for (var i = 1; i < arguments.Length; i++)
        {
            var argument = arguments[i];
            if (argument == "-auth" && i + 1 < arguments.Length)
            {
                auth = arguments[++i];
            }
            else if (argument.StartsWith(':') && argument.Length > 1 && char.IsAsciiDigit(argument[1]))
            {
                display = argument;
            }
            else if (argument.StartsWith("vt", StringComparison.Ordinal) && int.TryParse(argument.AsSpan(2), out var number))
            {
                terminal = number;
            }
        }

        return auth is null ? null : new XServer(auth, terminal, display);
    }

    /// <summary>The server on the active terminal, or the only one when just one is running.</summary>
    /// <param name="servers">The X servers found.</param>
    /// <param name="activeTerminal">The contents of <c>/sys/class/tty/tty0/active</c>, like "tty2".</param>
    public static XServer? Pick(IReadOnlyList<XServer> servers, string activeTerminal)
    {
        ArgumentNullException.ThrowIfNull(servers);
        ArgumentNullException.ThrowIfNull(activeTerminal);
        var active = activeTerminal.Trim();
        var onActive = servers.FirstOrDefault(s => s.Terminal is { } t && active == $"tty{t}");
        return onActive ?? (servers.Count == 1 ? servers[0] : null);
    }

    /// <summary>The X server on the physical screen right now.</summary>
    public static XServer? Current()
    {
        var servers = new List<XServer>();
        foreach (var folder in Directory.EnumerateDirectories("/proc"))
        {
            if (!char.IsAsciiDigit(Path.GetFileName(folder)[0]))
            {
                continue;
            }

            try
            {
                if (Parse(File.ReadAllText(Path.Combine(folder, "cmdline"))) is { } server)
                {
                    servers.Add(server);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A process that ended while the list was read.
            }
        }

        var active = File.Exists("/sys/class/tty/tty0/active") ? File.ReadAllText("/sys/class/tty/tty0/active") : "";
        return Pick(servers, active);
    }

    /// <summary>The displays to try for a server that does not name its own (GDM's use -displayfd).</summary>
    public static IEnumerable<string> Candidates(XServer server)
    {
        ArgumentNullException.ThrowIfNull(server);
        if (server.Display is not null)
        {
            return [server.Display];
        }

        return Directory.Exists("/tmp/.X11-unix")
            ? Directory.EnumerateFiles("/tmp/.X11-unix", "X*").Select(socket => $":{Path.GetFileName(socket)[1..]}").Order(StringComparer.Ordinal)
            : [];
    }
}
