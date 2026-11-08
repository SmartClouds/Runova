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
    public static string Folder => OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Runova", "Agent")
        : "/etc/runova-agent";

    public static string FilePath => Path.Combine(Folder, "agent.bin");

    private static readonly byte[] _entropy = "Runova Anywhere agent v1"u8.ToArray();

    public static void Save(AgentConfig config, string? path = null)
    {
        ArgumentNullException.ThrowIfNull(config);
        var file = path ?? FilePath;
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var plain = System.Text.Encoding.UTF8.GetBytes(config.ToJson());
        var data = OperatingSystem.IsWindows() ? Seal(plain) : plain;
        File.WriteAllBytes(file, data);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
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
