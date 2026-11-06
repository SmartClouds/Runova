using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>A port of interval.test.ts.</summary>
public sealed class HealthIntervalsTests
{
    [Fact]
    public void Keeps_a_valid_whole_number_of_seconds()
    {
        Assert.Equal(300, HealthIntervals.NormalizeInterval(300));
    }

    [Fact]
    public void Clamps_to_the_allowed_range()
    {
        Assert.Equal(HealthIntervals.MinSec, HealthIntervals.NormalizeInterval(1));
        Assert.Equal(HealthIntervals.MaxSec, HealthIntervals.NormalizeInterval(10_000_000));
        Assert.Equal(HealthIntervals.MinSec, HealthIntervals.NormalizeInterval(-50));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void Falls_back_to_the_default_for_anything_that_is_not_a_finite_number(double? value)
    {
        Assert.Equal(HealthIntervals.DefaultSec, HealthIntervals.NormalizeInterval(value));
        Assert.Equal(HealthIntervals.TimeoutDefaultSec, HealthIntervals.NormalizeTimeout(value));
    }

    [Theory]
    [InlineData(59.6, 60)]
    [InlineData(59.5, 60)]
    [InlineData(59.49999999999999, 59)]
    [InlineData(20.5, 21)]
    public void Rounds_fractions_like_Math_round(double value, int expected)
    {
        Assert.Equal(expected, HealthIntervals.NormalizeInterval(value));
    }

    [Theory]
    [InlineData(30)]
    [InlineData(60)]
    [InlineData(300)]
    [InlineData(900)]
    [InlineData(3600)]
    [InlineData(21_600)]
    [InlineData(86_400)]
    public void Keeps_the_presets(int preset)
    {
        Assert.Equal(preset, HealthIntervals.NormalizeInterval(preset));
    }

    [Fact]
    public void Clamps_the_timeout_between_2_and_60_seconds()
    {
        Assert.Equal(2, HealthIntervals.NormalizeTimeout(1));
        Assert.Equal(60, HealthIntervals.NormalizeTimeout(600));
        Assert.Equal(15, HealthIntervals.NormalizeTimeout(15));
    }

    [Fact]
    public void Waits_the_interval_plus_up_to_5_percent_jitter()
    {
        Assert.Equal(TimeSpan.FromSeconds(60), HealthIntervals.NextDelay(60, false, () => 0));
        var late = HealthIntervals.NextDelay(60, false, () => 0.999);
        Assert.True(late <= TimeSpan.FromSeconds(63));
        Assert.True(late > TimeSpan.FromSeconds(62));
        Assert.Equal(TimeSpan.FromMilliseconds(62_997), late);
    }

    [Fact]
    public void Jitters_with_the_shared_random_when_none_is_given()
    {
        var delay = HealthIntervals.NextDelay(60, false);
        Assert.InRange(delay, TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(63));
    }

    [Fact]
    public void Rechecks_soon_while_a_change_waits_to_be_confirmed()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), HealthIntervals.NextDelay(3600, true, () => 0));
    }

    [Fact]
    public void Never_rechecks_later_than_the_interval_itself()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), HealthIntervals.NextDelay(15, true, () => 0));
    }

    [Fact]
    public void Normalizes_the_interval_before_waiting()
    {
        Assert.Equal(TimeSpan.FromSeconds(15), HealthIntervals.NextDelay(1, false, () => 0));
    }
}
