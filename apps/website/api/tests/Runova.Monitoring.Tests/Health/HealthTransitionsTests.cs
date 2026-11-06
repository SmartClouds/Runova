using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>A port of transitions.test.ts; the longer sequences live in the shared fixtures.</summary>
public sealed class HealthTransitionsTests
{
    private static (HealthTrack Track, List<string> Events) Run(int confirm, params HealthProbeState[] states)
    {
        var track = HealthTrack.Initial;
        var events = new List<string>();
        foreach (var state in states)
        {
            var step = HealthTransitions.Next(track, state, confirm);
            track = step.Track;
            if (step.Opened)
            {
                events.Add("opened");
            }

            if (step.Resolved)
            {
                events.Add("resolved");
            }
        }

        return (track, events);
    }

    [Fact]
    public void Starts_with_nothing_confirmed()
    {
        Assert.Equal(new HealthTrack(null, 0, false), HealthTrack.Initial);
        Assert.Equal(default, HealthTrack.Initial);
    }

    [Fact]
    public void Confirms_a_first_good_sample_at_once_and_opens_nothing()
    {
        var (track, events) = Run(2, HealthProbeState.Pass);
        Assert.Equal(HealthVerdict.Ok, track.Confirmed);
        Assert.False(track.Pending);
        Assert.Empty(events);
    }

    [Fact]
    public void Opens_an_incident_only_after_the_problem_repeats()
    {
        var once = Run(2, HealthProbeState.Pass, HealthProbeState.Fail);
        Assert.Empty(once.Events);
        Assert.True(once.Track.Pending);

        var twice = Run(2, HealthProbeState.Pass, HealthProbeState.Fail, HealthProbeState.Unreachable);
        Assert.Equal(["opened"], twice.Events);
        Assert.Equal(HealthVerdict.Problem, twice.Track.Confirmed);
        Assert.False(twice.Track.Pending);
    }

    [Fact]
    public void Resolves_after_the_target_recovers_for_the_same_number_of_samples()
    {
        Assert.Equal(["opened"], Run(2, HealthProbeState.Pass, HealthProbeState.Fail, HealthProbeState.Fail, HealthProbeState.Pass).Events);
        Assert.Equal(
            ["opened", "resolved"],
            Run(2, HealthProbeState.Pass, HealthProbeState.Fail, HealthProbeState.Fail, HealthProbeState.Pass, HealthProbeState.Warn).Events);
    }

    [Fact]
    public void Opens_at_once_when_confirmation_is_set_to_one_sample()
    {
        Assert.Equal(["opened"], Run(1, HealthProbeState.Pass, HealthProbeState.Fail).Events);
    }

    [Fact]
    public void Treats_a_negative_confirmation_as_one()
    {
        Assert.Equal(["opened"], Run(-3, HealthProbeState.Pass, HealthProbeState.Invalid).Events);
    }

    [Fact]
    public void Uses_two_samples_unless_told_otherwise()
    {
        var first = HealthTransitions.Next(HealthTrack.Initial, HealthProbeState.Fail);
        Assert.False(first.Opened);
        Assert.True(HealthTransitions.Next(first.Track, HealthProbeState.Fail).Opened);
    }
}
