using Runova.Website.Core.Billing;

namespace Runova.Website.Tests.Billing;

/// <summary>The pure rules behind account types (E53): who gets which limits, prepaid periods, prices.</summary>
public sealed class BillingRulesTests
{
    private static readonly DateTimeOffset _now = new(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);

    private static Entitlement Type(string key, int? max, int minInterval, int history = 30) =>
        new(key.Length, key, key, max, minInterval, history, key == "free");

    [Fact]
    public void Unlimited_monitors_beat_any_number()
    {
        var best = Entitlement.Best([Type("go", 10, 300), Type("ultra", null, 30), Type("pro", 50, 60)]);

        Assert.Equal("ultra", best.Key);
    }

    [Fact]
    public void More_monitors_win_then_a_shorter_interval()
    {
        Assert.Equal("pro", Entitlement.Best([Type("go", 10, 300), Type("pro", 50, 60)]).Key);
        Assert.Equal("fast", Entitlement.Best([Type("slow", 10, 300), Type("fast", 10, 60)]).Key);
    }

    [Fact]
    public void Best_of_nothing_is_an_error()
    {
        Assert.Throws<InvalidOperationException>(() => Entitlement.Best([]));
    }

    [Theory]
    [InlineData(null, 1000, true)]
    [InlineData(10, 10, true)]
    [InlineData(10, 11, false)]
    [InlineData(1, 0, true)]
    public void A_limit_allows_up_to_its_count(int? max, int count, bool allowed)
    {
        Assert.Equal(allowed, Type("t", max, 60).AllowsMonitors(count));
    }

    [Theory]
    [InlineData(300, 299, false)]
    [InlineData(300, 300, true)]
    [InlineData(30, 45, true)]
    public void An_interval_must_not_be_shorter_than_the_floor(int floor, int interval, bool allowed)
    {
        Assert.Equal(allowed, Type("t", 1, floor).AllowsInterval(interval));
    }

    [Fact]
    public void Buying_the_same_type_again_adds_to_the_end_date()
    {
        var end = _now.AddDays(10);

        Assert.Equal(end.AddMonths(3), Prepaid.Extend(_now, end, 3));
    }

    [Fact]
    public void A_period_that_already_ended_starts_again_from_now()
    {
        Assert.Equal(_now.AddMonths(1), Prepaid.Extend(_now, _now.AddDays(-5), 1));
        Assert.Equal(_now.AddMonths(1), Prepaid.Extend(_now, null, 1));
    }

    [Fact]
    public void Switching_up_turns_the_days_left_into_fewer_days_at_the_new_price()
    {
        // 10 days left on a $5 type, moving to a $20 type: worth 2.5 days there.
        var end = Prepaid.Switch(_now, _now.AddDays(10), oldMonthlyCents: 500, newMonthlyCents: 2000, months: 1);

        Assert.Equal(_now.AddMonths(1).AddDays(2.5), end);
    }

    [Fact]
    public void Switching_down_turns_the_days_left_into_more_days()
    {
        var end = Prepaid.Switch(_now, _now.AddDays(10), oldMonthlyCents: 2000, newMonthlyCents: 500, months: 1);

        Assert.Equal(_now.AddMonths(1).AddDays(40), end);
    }

    [Fact]
    public void Switching_from_nothing_or_from_a_free_type_carries_nothing_over()
    {
        Assert.Equal(_now.AddMonths(12), Prepaid.Switch(_now, null, 500, 2000, 12));
        Assert.Equal(_now.AddMonths(1), Prepaid.Switch(_now, _now.AddDays(30), 0, 2000, 1));
        Assert.Equal(_now.AddMonths(1), Prepaid.Switch(_now, _now.AddDays(-1), 500, 2000, 1));
    }

    [Theory]
    [InlineData(500, null, 1, 500)]
    [InlineData(500, null, 3, 1500)]
    [InlineData(500, null, 12, 6000)]
    [InlineData(500, 5000, 12, 5000)]
    [InlineData(500, 5000, 3, 1500)]
    public void A_prepaid_price_is_the_monthly_price_times_months_or_the_yearly_one(int monthly, int? yearly, int months, long expected)
    {
        Assert.Equal(expected, Prepaid.PriceCents(monthly, yearly, months));
    }

    [Fact]
    public void A_type_with_no_monthly_price_can_not_be_bought()
    {
        Assert.Null(Prepaid.PriceCents(null, 5000, 1));
        Assert.Equal(5000, Prepaid.PriceCents(null, 5000, 12));
    }
}
