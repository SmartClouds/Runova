using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.Traffic;

/// <summary>E109: the live view, from memory: visitors in the last five minutes, requests in the last minute, the pages looked at now.</summary>
public sealed class TrafficLiveViewTests
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_794_996_000_000));

    private static readonly UserAgentInfo _browser = new("Firefox", 133, "Windows", TrafficDevice.Desktop, null);

    private static readonly UserAgentInfo _bot = new("Other", 0, "Other", TrafficDevice.Bot, "Googlebot");

    private long Now => _clock.GetUtcNow().ToUnixTimeMilliseconds();

    private TrafficRequest Request(ulong visitor, string path = "/", long? at = null, string site = "app", UserAgentInfo? agent = null) =>
        new(site, at ?? Now, default, TrafficMethod.Get, path, null, 200, 10, 5, true, null, null, agent ?? _browser, default, visitor, false);

    [Fact]
    public void Visitors_requests_and_pages_now()
    {
        var live = new TrafficLiveView(_clock);
        live.Record(Request(1, "/", Now - (6 * 60_000)));
        live.Record(Request(2, "/pricing", Now - (4 * 60_000)));
        live.Record(Request(3, "/", Now - 30_000));
        live.Record(Request(3, "/blog", Now - 10_000));
        live.Record(Request(4, "/", Now - 1000, agent: _bot));
        live.Record(Request(5, "/", Now - 1000, site: "blog"));

        var app = live.Snapshot("app");
        var all = live.Snapshot(null);

        Assert.Equal((2, 3), (app.VisitorsNow, app.RequestsLastMinute));
        Assert.Equal(["/", "/blog", "/pricing"], app.PagesNow.Select(p => p.Value).Order());
        Assert.Equal(Now, app.AtUnixMs);
        Assert.Equal((3, 4), (all.VisitorsNow, all.RequestsLastMinute));
    }

    [Fact]
    public void Old_lines_read_late_are_not_live_and_memory_stays_bounded()
    {
        var live = new TrafficLiveView(_clock, maxVisitors: 10);

        live.Record(Request(1, at: Now - (20 * 60_000)));
        for (var i = 0; i < 100; i++)
        {
            live.Record(Request((ulong)(100 + i)));
        }

        var app = live.Snapshot("app");
        Assert.Equal(10, app.VisitorsNow);
        Assert.Equal(100, app.RequestsLastMinute);
    }
}
