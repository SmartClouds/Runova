using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

public sealed class HealthStatesTests
{
    [Theory]
    [InlineData(HealthProbeState.Pass, "pass", false)]
    [InlineData(HealthProbeState.Warn, "warn", false)]
    [InlineData(HealthProbeState.Fail, "fail", true)]
    [InlineData(HealthProbeState.Unreachable, "unreachable", true)]
    [InlineData(HealthProbeState.Unauthorized, "unauthorized", true)]
    [InlineData(HealthProbeState.Invalid, "invalid", true)]
    public void Names_each_state_and_says_whether_it_is_down(HealthProbeState state, string wire, bool problem)
    {
        Assert.Equal(wire, HealthStates.ToWire(state));
        Assert.True(HealthStates.TryParse(wire, out var parsed));
        Assert.Equal(state, parsed);
        Assert.Equal(problem, HealthStates.IsProblem(state));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("PASS")]
    [InlineData("pending")]
    [InlineData(" pass")]
    public void Reads_only_exact_wire_names(string? value)
    {
        Assert.False(HealthStates.TryParse(value, out _));
    }

    [Theory]
    [InlineData(HealthCheckStatus.Pass, "pass")]
    [InlineData(HealthCheckStatus.Warn, "warn")]
    [InlineData(HealthCheckStatus.Fail, "fail")]
    public void Names_each_check_status(HealthCheckStatus status, string wire)
    {
        Assert.Equal(wire, HealthStates.ToWire(status));
    }
}
