using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Runova.RemoteAgent.Linux;

/// <summary>The real /proc, file owners, logind seat and X sockets that <see cref="XServerDiscovery"/> reads.</summary>
[SupportedOSPlatform("linux")]
internal sealed unsafe class LinuxXServerProbe : IXServerProbe
{
    public static readonly LinuxXServerProbe Instance = new();

    public IEnumerable<int> ProcessIds()
    {
        foreach (var folder in Directory.EnumerateDirectories("/proc"))
        {
            if (int.TryParse(Path.GetFileName(folder), out var pid))
            {
                yield return pid;
            }
        }
    }

    public string? CommandLine(int pid) => Read($"/proc/{pid}/cmdline");

    public string? Executable(int pid)
    {
        try
        {
            return new FileInfo($"/proc/{pid}/exe").LinkTarget;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Following /proc/pid/exe reaches the file the process runs, even one replaced since.
    public FileOwner? ExecutableFile(int pid) => Stat($"/proc/{pid}/exe");

    public FileOwner? Folder(string path) => Stat(path);

    public FileOwner? FileAt(string path) => Stat(path);

    public int? EffectiveUid(int pid) => Read($"/proc/{pid}/status") is { } status ? XServerDiscovery.EffectiveUid(status) : null;

    public int? SeatUser() => Read("/run/systemd/seats/seat0") is { } seat ? XServerDiscovery.SeatUser(seat) : null;

    public string ActiveTerminal() => Read("/sys/class/tty/tty0/active") ?? "";

    public IEnumerable<string> Sockets() =>
        Directory.Exists("/tmp/.X11-unix") ? Directory.EnumerateFileSystemEntries("/tmp/.X11-unix").Select(Path.GetFileName).OfType<string>().ToList() : [];

    public IReadOnlyList<int> SocketPeers(string display)
    {
        var number = display.TrimStart(':').Split('.')[0];
        if (number.Length == 0 || !number.All(char.IsAsciiDigit))
        {
            return [];
        }

        // Xlib tries the abstract socket first and then the file, so both have to lead to the server.
        var peers = new List<int>();
        Span<byte> credentials = stackalloc byte[12];
        foreach (var name in new[] { $"\0/tmp/.X11-unix/X{number}", $"/tmp/.X11-unix/X{number}" })
        {
            try
            {
                using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                socket.Connect(new UnixDomainSocketEndPoint(name));
                if (socket.GetRawSocketOption(X11Native.SolSocket, X11Native.SoPeerCred, credentials) >= 4)
                {
                    peers.Add(MemoryMarshal.Read<int>(credentials));
                }
            }
            catch (SocketException)
            {
                // Nothing listens there.
            }
        }

        return peers;
    }

    /// <summary>The process at the other end of a connected socket, from SO_PEERCRED.</summary>
    public static int? PeerPid(int socket)
    {
        // struct ucred: pid, uid, gid.
        var credentials = stackalloc int[3];
        var length = (uint)(sizeof(int) * 3);
        return X11Native.getsockopt(socket, X11Native.SolSocket, X11Native.SoPeerCred, credentials, &length) == 0 ? credentials[0] : null;
    }

    private static FileOwner? Stat(string path)
    {
        var buffer = stackalloc byte[256];
        if (X11Native.statx(X11Native.AtFdCwd, path, 0, X11Native.StatxBasicStats, buffer) != 0)
        {
            return null;
        }

        var uid = *(uint*)(buffer + 20);
        var mode = *(ushort*)(buffer + 28);
        return new FileOwner(uid > int.MaxValue ? -1 : (int)uid, (UnixFileMode)(mode & 0xfff));
    }

    private static string? Read(string path)
    {
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // A process that ended while the list was read, or a file this system does not have.
            return null;
        }
    }
}
