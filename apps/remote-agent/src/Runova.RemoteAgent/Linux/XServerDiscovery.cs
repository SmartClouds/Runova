namespace Runova.RemoteAgent.Linux;

/// <summary>An X server on this computer: its auth file, the terminal it is on, its display when it names one, and its process.</summary>
public sealed record XServer(string AuthFile, int? Terminal, string? Display, int Pid = 0);

/// <summary>The owner and permission bits of a file or folder.</summary>
public sealed record FileOwner(int Uid, UnixFileMode Mode);

/// <summary>
/// What finding the X server reads from the computer: /proc, file owners, the logind seat and the
/// X sockets. The agent reads the real ones; tests stand in for them.
/// </summary>
public interface IXServerProbe
{
    IEnumerable<int> ProcessIds();

    /// <summary>The process's <c>/proc/pid/cmdline</c>, or null once it is gone.</summary>
    string? CommandLine(int pid);

    /// <summary>Where <c>/proc/pid/exe</c> points, which the process cannot change.</summary>
    string? Executable(int pid);

    /// <summary>The owner and mode of the very file the process runs (through <c>/proc/pid/exe</c>).</summary>
    FileOwner? ExecutableFile(int pid);

    /// <summary>The owner and mode of a folder.</summary>
    FileOwner? Folder(string path);

    /// <summary>The effective user the process runs as.</summary>
    int? EffectiveUid(int pid);

    /// <summary>The user of the active session on seat0, from logind, or null when there is none.</summary>
    int? SeatUser();

    /// <summary>The contents of <c>/sys/class/tty/tty0/active</c>, like "tty2".</summary>
    string ActiveTerminal();

    /// <summary>The socket names in <c>/tmp/.X11-unix</c>, like "X0".</summary>
    IEnumerable<string> Sockets();

    /// <summary>The process behind each local socket of the display (abstract and file) that takes a connection.</summary>
    IReadOnlyList<int> SocketPeers(string display);
}

/// <summary>
/// Finds the X server showing on the physical screen (E65). The display managers (GDM, LightDM,
/// SDDM) all start Xorg with the auth file and terminal on its command line, for the greeter and
/// for a signed-in desktop alike, so reading those is enough and needs no per-manager code. A
/// Wayland greeter has no such server, and the agent then reports no screen.
/// <para>
/// Anyone can put "Xorg" and an -auth file on their own command line, so a process only counts
/// when it really runs a root-owned Xorg binary from a known place, as root or as the user of the
/// active seat0 session. A display is only tried when its sockets lead to that same process.
/// </para>
/// </summary>
public static class XServerDiscovery
{
    /// <summary>Where distributions install the Xorg binary itself (not the /usr/bin/X wrappers).</summary>
    public static readonly IReadOnlyList<string> XorgBinaries = ["/usr/lib/xorg/Xorg", "/usr/lib/Xorg", "/usr/libexec/Xorg", "/usr/bin/Xorg"];

    /// <param name="commandLine">A process's <c>/proc/pid/cmdline</c>: arguments ended by NUL.</param>
    /// <param name="pid">The process the command line belongs to.</param>
    public static XServer? Parse(string commandLine, int pid = 0)
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

        return auth is null ? null : new XServer(auth, terminal, display, pid);
    }

    /// <summary>
    /// Whether the process is the system's own Xorg: its binary is one of <see cref="XorgBinaries"/>,
    /// owned by root and writable by no one else, in folders that are too, and it runs as root or as
    /// the user of the active seat0 session.
    /// </summary>
    public static bool Trusted(int pid, IXServerProbe probe, int? seatUser)
    {
        ArgumentNullException.ThrowIfNull(probe);
        var path = probe.Executable(pid);
        if (path is null)
        {
            return false;
        }

        // A package update replaces the binary under a running server; the file it still runs is checked below.
        const string Deleted = " (deleted)";
        if (path.EndsWith(Deleted, StringComparison.Ordinal))
        {
            path = path[..^Deleted.Length];
        }

        if (!XorgBinaries.Contains(path, StringComparer.Ordinal) || probe.ExecutableFile(pid) is not { } binary || !RootOnly(binary))
        {
            return false;
        }

        for (var folder = Parent(path); folder is not null; folder = Parent(folder))
        {
            if (probe.Folder(folder) is not { } owner || !RootOnly(owner))
            {
                return false;
            }
        }

        var uid = probe.EffectiveUid(pid);
        return uid == 0 || (uid is not null && uid == seatUser);
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

    /// <summary>The X server on the physical screen right now, among the ones that pass <see cref="Trusted"/>.</summary>
    public static XServer? Current(IXServerProbe probe)
    {
        ArgumentNullException.ThrowIfNull(probe);
        var seatUser = probe.SeatUser();
        var servers = new List<XServer>();
        foreach (var pid in probe.ProcessIds())
        {
            if (probe.CommandLine(pid) is { } commandLine && Parse(commandLine, pid) is { } server && Trusted(pid, probe, seatUser))
            {
                servers.Add(server);
            }
        }

        return Pick(servers, probe.ActiveTerminal());
    }

    /// <summary>
    /// The displays to try for a server: its own, or for one that does not name it (GDM's use
    /// -displayfd) each socket in /tmp/.X11-unix. Either way only displays whose sockets all lead to
    /// the server's own process, so a socket someone else made never gets the server's auth cookie.
    /// </summary>
    public static IEnumerable<string> Candidates(XServer server, IXServerProbe probe)
    {
        ArgumentNullException.ThrowIfNull(server);
        ArgumentNullException.ThrowIfNull(probe);
        IEnumerable<string> displays = server.Display is not null
            ? [server.Display]
            : probe.Sockets().Where(socket => socket.StartsWith('X')).Select(socket => $":{socket[1..]}").Order(StringComparer.Ordinal);
        return displays.Where(display => probe.SocketPeers(display) is { Count: > 0 } peers && peers.All(peer => peer == server.Pid)).ToList();
    }

    /// <summary>The user of the active session in logind's seat file (<c>/run/systemd/seats/seat0</c>).</summary>
    public static int? SeatUser(string seatFile)
    {
        ArgumentNullException.ThrowIfNull(seatFile);
        foreach (var line in seatFile.Split('\n'))
        {
            if (line.StartsWith("ACTIVE_UID=", StringComparison.Ordinal) && int.TryParse(line.AsSpan("ACTIVE_UID=".Length).Trim(), out var uid))
            {
                return uid;
            }
        }

        return null;
    }

    /// <summary>The effective user in a <c>/proc/pid/status</c> ("Uid: real effective saved fs").</summary>
    public static int? EffectiveUid(string status)
    {
        ArgumentNullException.ThrowIfNull(status);
        foreach (var line in status.Split('\n'))
        {
            if (line.StartsWith("Uid:", StringComparison.Ordinal))
            {
                var ids = line["Uid:".Length..].Split(['\t', ' '], StringSplitOptions.RemoveEmptyEntries);
                return ids.Length > 1 && int.TryParse(ids[1], out var uid) ? uid : null;
            }
        }

        return null;
    }

    private static bool RootOnly(FileOwner owner) =>
        owner.Uid == 0 && (owner.Mode & (UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) == 0;

    // Linux paths, worked out by hand so the checks read the same when the tests run on Windows.
    private static string? Parent(string path)
    {
        if (path == "/")
        {
            return null;
        }

        var slash = path.LastIndexOf('/');
        return slash <= 0 ? "/" : path[..slash];
    }
}
