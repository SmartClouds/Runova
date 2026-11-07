using Runova.Website.Core.Billing;
using Runova.Website.Core.Monitoring;

namespace Runova.Website.Tests.Monitoring;

public sealed class CloudMonitorRulesTests
{
    private static readonly Entitlement _free = new(1, "free", "Free", 1, 300, 7, true);
    private static readonly Entitlement _go = new(2, "go", "Go", 10, 300, 30, false);
    private static readonly Entitlement _pro = new(3, "pro", "Pro", 50, 60, 90, false);
    private static readonly Entitlement _ultra = new(4, "ultra", "Ultra", null, 30, 365, false);
    private static readonly DateTimeOffset _t0 = new(2026, 11, 7, 9, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("https://api.example.com/health", false)]
    [InlineData("https://93.184.216.34:8443/health?full=1", false)]
    [InlineData("http://api.example.com/health", true)]
    public void A_public_address_is_good(string url, bool allowInsecure) =>
        Assert.Null(CloudMonitorRules.UrlProblem(url, allowInsecure));

    [Theory]
    [InlineData("", "Give")]
    [InlineData("api.example.com/health", "full address")]
    [InlineData("ftp://api.example.com/health", "http or https")]
    [InlineData("http://api.example.com/health", "https")]
    [InlineData("https://user:pass@api.example.com/health", "user name")]
    [InlineData("https://localhost:3000/health", "this computer")]
    [InlineData("https://db.internal/health", "private network")]
    [InlineData("https://printer.local/health", "private network")]
    [InlineData("https://127.0.0.1/health", "loopback")]
    [InlineData("https://10.1.2.3/health", "private")]
    [InlineData("https://[::1]/health", "loopback")]
    [InlineData("https://169.254.169.254/latest", "metadata")]
    [InlineData("https://169.254.10.1/latest", "link-local")]
    public void An_address_a_node_may_not_check_is_refused(string url, string why)
    {
        var problem = CloudMonitorRules.UrlProblem(url, allowInsecure: false);

        Assert.NotNull(problem);
        Assert.Contains(why, problem, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void An_address_too_long_is_refused() =>
        Assert.NotNull(CloudMonitorRules.UrlProblem("https://example.com/" + new string('a', 2048), false));

    [Theory]
    [InlineData(300, true)]
    [InlineData(299, false)]
    [InlineData(86_400, true)]
    [InlineData(86_401, false)]
    public void Free_checks_every_5_minutes_or_slower(int interval, bool good) =>
        Assert.Equal(good, CloudMonitorRules.IntervalProblem(interval, _free) is null);

    [Fact]
    public void Each_type_has_its_own_floor_and_the_server_one_below_it()
    {
        Assert.NotNull(CloudMonitorRules.IntervalProblem(59, _pro));
        Assert.Null(CloudMonitorRules.IntervalProblem(60, _pro));
        Assert.Null(CloudMonitorRules.IntervalProblem(30, _ultra));
        Assert.NotNull(CloudMonitorRules.IntervalProblem(29, _ultra));
        // A type an Admin set lower than the server allows still stops at 30 seconds.
        Assert.NotNull(CloudMonitorRules.IntervalProblem(15, _ultra with { MinIntervalSec = 10 }));
    }

    [Fact]
    public void The_interval_problem_names_the_type_and_its_floor() =>
        Assert.Equal(
            "Free checks every 5 minutes or slower. Choose a longer interval, or a type that allows it.",
            CloudMonitorRules.IntervalProblem(60, _free));

    [Theory]
    [InlineData(10, 60, true)]
    [InlineData(1, 60, false)]
    [InlineData(61, 300, false)]
    [InlineData(60, 60, false)]
    [InlineData(30, 60, true)]
    public void A_timeout_is_2_to_60_seconds_and_shorter_than_the_interval(int timeout, int interval, bool good) =>
        Assert.Equal(good, CloudMonitorRules.TimeoutProblem(timeout, interval) is null);

    private static EnforcedMonitor Monitor(long id, int minutesOld, int interval = 300, bool paused = false) =>
        new(id, _t0.AddMinutes(-minutesOld), interval, paused);

    [Fact]
    public void A_type_that_goes_down_pauses_the_newest_over_its_limit()
    {
        var monitors = Enumerable.Range(1, 12).Select(i => Monitor(i, 100 - i)).ToList();

        var result = CloudMonitorRules.Enforce(_free, monitors);

        // The oldest stays on; the 11 made after it are paused.
        Assert.Equal([.. Enumerable.Range(2, 11).Select(i => (long)i)], result.Pause.Order());
        Assert.Empty(result.Intervals);
    }

    [Fact]
    public void A_paused_monitor_does_not_count()
    {
        List<EnforcedMonitor> monitors = [Monitor(1, 50, paused: true), Monitor(2, 40), Monitor(3, 30, paused: true)];

        var result = CloudMonitorRules.Enforce(_free, monitors);

        Assert.Empty(result.Pause);
    }

    [Fact]
    public void Intervals_under_the_new_floor_are_lengthened_paused_or_not()
    {
        List<EnforcedMonitor> monitors = [Monitor(1, 50, interval: 30), Monitor(2, 40, interval: 60, paused: true), Monitor(3, 30, interval: 600)];

        var result = CloudMonitorRules.Enforce(_go, monitors);

        Assert.Equal(new Dictionary<long, int> { [1] = 300, [2] = 300 }, result.Intervals);
        Assert.Empty(result.Pause);
    }

    [Fact]
    public void Unlimited_keeps_every_monitor()
    {
        var monitors = Enumerable.Range(1, 500).Select(i => Monitor(i, i, interval: 30)).ToList();

        var result = CloudMonitorRules.Enforce(_ultra, monitors);

        Assert.Empty(result.Pause);
        Assert.Empty(result.Intervals);
        Assert.False(result.Changed);
    }

    [Fact]
    public void The_hour_is_the_utc_hour_it_falls_in()
    {
        var at = new DateTimeOffset(2026, 11, 7, 11, 59, 59, TimeSpan.FromHours(2));

        Assert.Equal(new DateTimeOffset(2026, 11, 7, 9, 0, 0, TimeSpan.Zero), CloudMonitorRules.HourOf(at));
    }

    private static readonly MonitorLabel _api = new("API", "Storefront", "Production");

    [Fact]
    public void A_down_message_names_the_monitor_and_what_was_wrong()
    {
        var message = CloudMonitorMessages.Down(_api, "unreachable", "Connection refused", "eu-central", "us-east");

        Assert.Equal("API in Storefront (Production) is down", message.Title);
        Assert.Equal("It could not be reached: Connection refused. Seen from eu-central and confirmed from us-east.", message.Body);
        Assert.Equal("🔴 API in Storefront (Production) is down\nIt could not be reached: Connection refused. Seen from eu-central and confirmed from us-east.", message.Telegram);
    }

    [Fact]
    public void A_down_message_from_a_single_node_says_where_only()
    {
        var message = CloudMonitorMessages.Down(new MonitorLabel("API", "Storefront", null), "fail", null, "eu-central", null);

        Assert.Equal("API in Storefront is down", message.Title);
        Assert.Equal("It reports that it is failing. Seen from eu-central.", message.Body);
    }

    [Fact]
    public void A_recovered_message_says_how_long_it_was_down()
    {
        var message = CloudMonitorMessages.Recovered(_api, TimeSpan.FromMinutes(65));

        Assert.Equal("API in Storefront (Production) is back up", message.Title);
        Assert.Equal("It was down for 1 hour 5 minutes.", message.Body);
        Assert.StartsWith("🟢 ", message.Telegram, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(20, "less than a minute")]
    [InlineData(60, "1 minute")]
    [InlineData(150, "2 minutes")]
    [InlineData(7200, "2 hours")]
    [InlineData(90_000, "1 day 1 hour")]
    public void Durations_read_like_a_person_wrote_them(int seconds, string text) =>
        Assert.Equal(text, CloudMonitorMessages.Duration(TimeSpan.FromSeconds(seconds)));

    [Fact]
    public void A_plan_notice_says_what_changed_and_why()
    {
        var message = CloudMonitorMessages.PlanChanged("Platform", _free, paused: 2, lengthened: 1);

        Assert.Equal("Online monitors in Platform changed", message.Title);
        Assert.Equal(
            "Platform now uses Free, which allows 1 online monitor checked every 5 minutes or slower. 2 monitors were paused and 1 now checks less often.",
            message.Body);
    }

    [Fact]
    public void A_telegram_message_fits_one_message()
    {
        var message = CloudMonitorMessages.Down(_api, "fail", new string('x', 5000), "eu", null);

        Assert.True(message.Telegram.Length <= 4096);
        Assert.EndsWith("…", message.Telegram, StringComparison.Ordinal);
    }
}
