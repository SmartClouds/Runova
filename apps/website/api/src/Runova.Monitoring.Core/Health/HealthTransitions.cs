namespace Runova.Monitoring.Core.Health;

/// <summary>What a target was last confirmed as.</summary>
public enum HealthVerdict
{
    Ok,
    Problem,
}

/// <summary>Where a target stands between samples.</summary>
/// <param name="Confirmed">What the target was last confirmed as, or null before the first confirmation.</param>
/// <param name="Streak">How many samples in a row disagreed with <paramref name="Confirmed"/>.</param>
/// <param name="Pending">True while a change is waiting for its confirming sample.</param>
public readonly record struct HealthTrack(HealthVerdict? Confirmed, int Streak, bool Pending)
{
    public static HealthTrack Initial => new(null, 0, false);
}

/// <summary>The track after a sample, and whether that sample opened or resolved an incident.</summary>
public readonly record struct HealthTrackStep(HealthTrack Track, bool Opened, bool Resolved);

/// <summary>
/// When a target counts as down or back up. A port of <c>health/transitions.ts</c>. One bad sample
/// is not an outage (a deploy restarting the app, a dropped packet), so a change has to repeat
/// <c>confirm</c> times in a row before an incident opens or resolves. The first good sample is
/// believed at once: there is nothing to announce about a target that was never down.
/// </summary>
public static class HealthTransitions
{
    public static HealthTrackStep Next(HealthTrack previous, HealthProbeState state, int confirm = 2)
    {
        var verdict = HealthStates.IsProblem(state) ? HealthVerdict.Problem : HealthVerdict.Ok;
        var needed = Math.Max(1, confirm);

        if (verdict == previous.Confirmed)
        {
            return new HealthTrackStep(new HealthTrack(verdict, 0, false), false, false);
        }

        if (previous.Confirmed is null && verdict == HealthVerdict.Ok)
        {
            return new HealthTrackStep(new HealthTrack(HealthVerdict.Ok, 0, false), false, false);
        }

        var streak = previous.Streak + 1;
        if (streak < needed)
        {
            return new HealthTrackStep(new HealthTrack(previous.Confirmed, streak, true), false, false);
        }

        return new HealthTrackStep(
            new HealthTrack(verdict, 0, false),
            Opened: verdict == HealthVerdict.Problem,
            Resolved: verdict == HealthVerdict.Ok && previous.Confirmed == HealthVerdict.Problem);
    }
}
