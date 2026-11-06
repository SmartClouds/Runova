namespace Runova.Monitoring.Core.Health;

/// <summary>
/// How often a target is checked, and how long a check may take. A port of
/// <c>health/interval.ts</c>: each target has its own interval, kept inside a range that can not
/// hammer a site (15 seconds at the fastest) or forget it (a day at the slowest).
/// </summary>
public static class HealthIntervals
{
    public const int MinSec = 15;
    public const int MaxSec = 86_400;
    public const int DefaultSec = 60;

    public const int TimeoutMinSec = 2;
    public const int TimeoutMaxSec = 60;
    public const int TimeoutDefaultSec = 10;

    /// <summary>How soon to look again while a change of state waits for its confirming sample.</summary>
    public const int ConfirmDelaySec = 15;

    /// <summary>Up to this share of the interval is added at random, so targets drift apart.</summary>
    public const double Jitter = 0.05;

    /// <summary>Whole seconds inside the range; the default for null, NaN or infinity.</summary>
    public static int NormalizeInterval(double? value) => ClampWhole(value, MinSec, MaxSec, DefaultSec);

    public static int NormalizeTimeout(double? value) => ClampWhole(value, TimeoutMinSec, TimeoutMaxSec, TimeoutDefaultSec);

    /// <summary>
    /// The time until the next check. While a new state waits to be confirmed the recheck comes
    /// sooner, so an outage is announced in seconds even on an hourly target.
    /// </summary>
    /// <param name="random">A number in [0, 1); <see cref="Random.Shared"/> when not given.</param>
    public static TimeSpan NextDelay(int intervalSec, bool pendingConfirmation, Func<double>? random = null)
    {
        var interval = NormalizeInterval(intervalSec);
        if (pendingConfirmation)
        {
            return TimeSpan.FromMilliseconds(Math.Min(interval, ConfirmDelaySec) * 1000);
        }

        var draw = random?.Invoke() ?? Random.Shared.NextDouble();
        return TimeSpan.FromMilliseconds(JsRound(interval * 1000 * (1 + (Jitter * draw))));
    }

    private static int ClampWhole(double? value, int min, int max, int fallback)
    {
        if (value is not { } number || !double.IsFinite(number))
        {
            return fallback;
        }

        return (int)Math.Min(max, Math.Max(min, JsRound(number)));
    }

    /// <summary>JavaScript's <c>Math.round</c>: halves go up, toward positive infinity.</summary>
    private static double JsRound(double value)
    {
        var floor = Math.Floor(value);
        return value - floor >= 0.5 ? floor + 1 : floor;
    }
}
