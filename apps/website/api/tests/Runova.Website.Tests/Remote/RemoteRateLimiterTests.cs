using Runova.Website.Api.Remote;

namespace Runova.Website.Tests.Remote;

public class RemoteRateLimiterTests
{
    private readonly ManualTime _time = new(new DateTimeOffset(2026, 11, 8, 9, 0, 0, TimeSpan.Zero));

    [Fact]
    public void A_key_gets_its_limit_and_then_waits_for_the_window()
    {
        var limiter = new RemoteRateLimiter(_time);

        for (var i = 0; i < 3; i++)
        {
            Assert.True(limiter.TryAcquire("account:3", 3, TimeSpan.FromMinutes(1)));
        }

        Assert.False(limiter.TryAcquire("account:3", 3, TimeSpan.FromMinutes(1)));
        _time.Advance(TimeSpan.FromSeconds(59));
        Assert.False(limiter.TryAcquire("account:3", 3, TimeSpan.FromMinutes(1)));
        _time.Advance(TimeSpan.FromSeconds(2));
        Assert.True(limiter.TryAcquire("account:3", 3, TimeSpan.FromMinutes(1)));
    }

    [Fact]
    public void The_window_slides_rather_than_resetting_at_once()
    {
        var limiter = new RemoteRateLimiter(_time);
        Assert.True(limiter.TryAcquire("k", 2, TimeSpan.FromMinutes(1)));
        _time.Advance(TimeSpan.FromSeconds(30));
        Assert.True(limiter.TryAcquire("k", 2, TimeSpan.FromMinutes(1)));
        _time.Advance(TimeSpan.FromSeconds(31));

        Assert.True(limiter.TryAcquire("k", 2, TimeSpan.FromMinutes(1)));
        Assert.False(limiter.TryAcquire("k", 2, TimeSpan.FromMinutes(1)));
    }

    [Fact]
    public void Keys_do_not_share_a_budget()
    {
        var limiter = new RemoteRateLimiter(_time);
        Assert.True(limiter.TryAcquire("a", 1, TimeSpan.FromMinutes(1)));

        Assert.True(limiter.TryAcquire("b", 1, TimeSpan.FromMinutes(1)));
        Assert.False(limiter.TryAcquire("a", 1, TimeSpan.FromMinutes(1)));
    }

    [Fact]
    public void Old_keys_are_forgotten_so_memory_stays_flat()
    {
        var limiter = new RemoteRateLimiter(_time);
        for (var i = 0; i < 1_000; i++)
        {
            limiter.TryAcquire($"k{i}", 5, TimeSpan.FromMinutes(1));
        }

        _time.Advance(TimeSpan.FromMinutes(2));
        limiter.TryAcquire("fresh", 5, TimeSpan.FromMinutes(1));

        Assert.True(limiter.Count <= 1);
    }
}
