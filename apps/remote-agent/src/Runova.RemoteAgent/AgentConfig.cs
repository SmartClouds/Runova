using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent;

/// <summary>
/// What the app hands the agent when it sets it up (E64): where the website is, which computer this
/// is, the agent's identity seed and secret, the password secret when one is set, and the owner's
/// choices. The app writes it to a file only its own user can read; <c>install</c> moves it into
/// the agent's folder sealed to this machine and deletes the original.
/// </summary>
public sealed record AgentConfig
{
    public required string SiteUrl { get; init; }

    public required string RemoteId { get; init; }

    public required long DeviceId { get; init; }

    public required string DeviceName { get; init; }

    /// <summary>The Ed25519 seed, base64url. The app registered its public key with the website.</summary>
    public required string IdentitySeed { get; init; }

    /// <summary>The <c>ras1.</c> secret the agent trades for hub tokens.</summary>
    public required string AgentSecret { get; init; }

    /// <summary>The CPace secret for this agent's key, base64url, when an unattended password is set.</summary>
    public string? PasswordSecret { get; init; }

    public required bool AllowOwnDevices { get; init; }

    public required IReadOnlyList<long> AlwaysAllow { get; init; }

    public required SessionPermissions DefaultPermissions { get; init; }

    [JsonIgnore]
    public Identity Identity => Identity.FromSeed(Bytes.FromB64u(IdentitySeed));

    [JsonIgnore]
    public AgentSettings Settings => new(AllowOwnDevices, AlwaysAllow, DefaultPermissions);

    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static AgentConfig Parse(string json) =>
        JsonSerializer.Deserialize<AgentConfig>(json, _json) ?? throw new InvalidDataException("The agent configuration is empty.");

    public string ToJson() => JsonSerializer.Serialize(this, _json);
}

/// <summary>Where the agent keeps its configuration, readable by the system and administrators only.</summary>
public static class AgentConfigStore
{
    public static string Folder
    {
        get
        {
            if (OperatingSystem.IsWindows())
            {
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Runova", "Agent");
            }

            return OperatingSystem.IsMacOS() ? "/Library/Application Support/Runova/Agent" : "/etc/runova-agent";
        }
    }

    public static string FilePath => Path.Combine(Folder, "agent.bin");

    private static readonly byte[] _entropy = "Runova Anywhere agent v1"u8.ToArray();

    public static void Save(AgentConfig config, string? path = null)
    {
        ArgumentNullException.ThrowIfNull(config);
        var file = path ?? FilePath;
        var plain = System.Text.Encoding.UTF8.GetBytes(config.ToJson());
        if (OperatingSystem.IsWindows())
        {
            WriteLockedDown(file, Seal(plain), lockParent: path is null);
        }
        else
        {
            WriteForOwnerOnly(file, plain);
        }
    }

    /// <summary>
    /// Any local account can open the sealed config (DPAPI machine scope), so on Windows the
    /// folder's access list is what keeps it to SYSTEM and administrators, and it has to be in place
    /// before the first byte. ProgramData lets a standard user make a folder first and own it, so an
    /// existing folder gets a new owner and its whole access list replaced, not just added to.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void WriteLockedDown(string file, byte[] content, bool lockParent)
    {
        var folder = Path.GetDirectoryName(file)!;
        if (lockParent && Path.GetDirectoryName(folder) is { } parent)
        {
            // ProgramData\Runova: whoever owns it could swap the Agent folder inside it.
            LockDown(parent);
        }

        LockDown(folder);
        var temporary = $"{file}.{Environment.ProcessId}.tmp";
        File.WriteAllBytes(temporary, content);
        // A new file under the locked folder, put in place of whatever was there.
        File.Move(temporary, file, overwrite: true);
    }

    /// <summary>
    /// Makes <paramref name="folder"/> belong to the account saving (the elevated installer, or
    /// SYSTEM for the service) with only SYSTEM, administrators and that account let in, nothing
    /// inherited. Refuses when the folder belongs to someone who will not let go of it.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void LockDown(string folder)
    {
        var me = System.Security.Principal.WindowsIdentity.GetCurrent().User!;
        var security = new System.Security.AccessControl.DirectorySecurity();
        security.SetOwner(me);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        var allowed = new[]
        {
            new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.LocalSystemSid, null),
            new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.BuiltinAdministratorsSid, null),
            me,
        };
        foreach (var sid in allowed.Distinct())
        {
            security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                sid,
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                System.Security.AccessControl.PropagationFlags.None,
                System.Security.AccessControl.AccessControlType.Allow));
        }

        var info = new DirectoryInfo(folder);
        if (!info.Exists)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(folder)!);
            FileSystemAclExtensions.Create(info, security);
            return;
        }

        try
        {
            info.SetAccessControl(security);
        }
        catch (UnauthorizedAccessException error)
        {
            throw new IOException($"{folder} belongs to another account that keeps it to itself. Delete it as an administrator and install again.", error);
        }
    }

    /// <summary>The file never exists with wider permissions, whatever the umask, and it replaces an older one whole.</summary>
    [UnsupportedOSPlatform("windows")]
    private static void WriteForOwnerOnly(string file, byte[] content)
    {
        var folder = Path.GetDirectoryName(file)!;
        Directory.CreateDirectory(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        File.SetUnixFileMode(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var temporary = $"{file}.{Environment.ProcessId}.tmp";
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
        };
        using (var stream = new FileStream(temporary, options))
        {
            stream.Write(content);
        }

        File.Move(temporary, file, overwrite: true);
    }

    public static AgentConfig Load(string? path = null)
    {
        var data = File.ReadAllBytes(path ?? FilePath);
        var plain = OperatingSystem.IsWindows() ? Open(data) : data;
        return AgentConfig.Parse(System.Text.Encoding.UTF8.GetString(plain));
    }

    [SupportedOSPlatform("windows")]
    private static byte[] Seal(byte[] plain) => ProtectedData.Protect(plain, _entropy, DataProtectionScope.LocalMachine);

    [SupportedOSPlatform("windows")]
    private static byte[] Open(byte[] data) => ProtectedData.Unprotect(data, _entropy, DataProtectionScope.LocalMachine);
}
