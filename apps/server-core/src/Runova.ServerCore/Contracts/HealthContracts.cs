using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>
/// Answer of the anonymous health endpoint: which core and API version is running, and since when
/// (the app shows the uptime from it).
/// </summary>
[TranspilationSource]
public sealed record HealthResponse(
    string Status,
    string Version,
    int ApiVersion,
    long StartedAtUnixMs);

/// <summary>Answer of the hub's ping, used for latency and to spot clock skew on the server.</summary>
[TranspilationSource]
public sealed record PingResponse(long ServerTimeUnixMs);
