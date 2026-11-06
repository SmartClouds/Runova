namespace Runova.Monitoring.Core.Health;

/// <summary>
/// What Runova makes of one probe. The first three come from the endpoint itself; the rest
/// describe a probe that never got a usable report back.
/// </summary>
public enum HealthProbeState
{
    Pass,
    Warn,
    Fail,
    Unreachable,
    Unauthorized,
    Invalid,
}

/// <summary>What a check or the whole endpoint reports about itself.</summary>
public enum HealthCheckStatus
{
    Pass,
    Warn,
    Fail,
}

/// <summary>The wire names of the states, as <c>@runova/core</c> spells them.</summary>
public static class HealthStates
{
    public static string ToWire(HealthProbeState state) => state switch
    {
        HealthProbeState.Pass => "pass",
        HealthProbeState.Warn => "warn",
        HealthProbeState.Fail => "fail",
        HealthProbeState.Unreachable => "unreachable",
        HealthProbeState.Unauthorized => "unauthorized",
        HealthProbeState.Invalid => "invalid",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Not a probe state."),
    };

    public static string ToWire(HealthCheckStatus status) => status switch
    {
        HealthCheckStatus.Pass => "pass",
        HealthCheckStatus.Warn => "warn",
        HealthCheckStatus.Fail => "fail",
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Not a check status."),
    };

    /// <summary>Reads a wire name back. Exact and lower case only, like the TypeScript union.</summary>
    public static bool TryParse(string? value, out HealthProbeState state)
    {
        switch (value)
        {
            case "pass":
                state = HealthProbeState.Pass;
                return true;
            case "warn":
                state = HealthProbeState.Warn;
                return true;
            case "fail":
                state = HealthProbeState.Fail;
                return true;
            case "unreachable":
                state = HealthProbeState.Unreachable;
                return true;
            case "unauthorized":
                state = HealthProbeState.Unauthorized;
                return true;
            case "invalid":
                state = HealthProbeState.Invalid;
                return true;
            default:
                state = default;
                return false;
        }
    }

    /// <summary>The states that mean the target is down. Warn is degraded, not down: it opens no incident.</summary>
    public static bool IsProblem(HealthProbeState state) =>
        state is HealthProbeState.Fail or HealthProbeState.Unreachable or HealthProbeState.Unauthorized or HealthProbeState.Invalid;
}
