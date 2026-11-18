using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.DevHost.Fakes;
using Runova.ServerCore.Traffic;

namespace Runova.ServerCore.Tests.DevHost;

/// <summary>
/// E109 T8 and E110 T6: the DevHost's synthetic access log lines, which the app's end-to-end tests
/// seed a site with. They must read like nginx's own, vary like real visitors, and an attack burst
/// must trip the detector of its kind.
/// </summary>
public sealed class FakeTrafficTests
{
    private static readonly DateTimeOffset _now = new(2026, 11, 18, 12, 0, 0, TimeSpan.Zero);

    private static readonly AttackThresholds _thresholds = new(20, 50, 5, 20, 5, 600, 5, 10);

    private static List<TrafficRequest> Parse(IEnumerable<string> lines)
    {
        var classifier = new UserAgentClassifier();
        var geo = new GeoCountry();
        var requests = new List<TrafficRequest>();
        foreach (var text in lines)
        {
            Assert.EndsWith("\n", text, StringComparison.Ordinal);
            var bytes = Encoding.UTF8.GetBytes(text.TrimEnd('\n'));
            Assert.True(AccessLogParser.TryParse(bytes, out var line), text);
            Assert.True(line.Extended, text);
            Assert.True(IpKey.TryParse(line.RemoteAddress, out var address));
            var target = AccessLogParser.Text(line.Target);
            var question = target.IndexOf('?', StringComparison.Ordinal);
            requests.Add(new TrafficRequest(
                "app",
                line.TimeUnixMs,
                address,
                AccessLogParser.Text(line.Method) switch { "GET" => TrafficMethod.Get, "POST" => TrafficMethod.Post, "HEAD" => TrafficMethod.Head, _ => TrafficMethod.Other },
                question < 0 ? target : target[..question],
                question < 0 ? null : target[(question + 1)..],
                line.Status,
                line.BodyBytes,
                line.RequestTimeMs,
                line.ContentType.IsEmpty ? null : AccessLogParser.Text(line.ContentType).StartsWith("text/html", StringComparison.Ordinal),
                null,
                null,
                classifier.Classify(line.UserAgent),
                geo.Locate(line, address),
                1,
                false));
        }

        return requests;
    }

    [Fact]
    public void Synthetic_traffic_reads_like_real_visitors_over_the_days_asked_for()
    {
        var lines = FakeTraffic.Visits(2000, daysBack: 7, seed: 42, _now);
        var requests = Parse(lines);

        Assert.Equal(2000, lines.Count);
        Assert.All(requests, r => Assert.InRange(r.AtUnixMs, _now.AddDays(-7).ToUnixTimeMilliseconds(), _now.ToUnixTimeMilliseconds()));
        Assert.True(requests.Select(r => r.AtUnixMs).Order().SequenceEqual(requests.Select(r => r.AtUnixMs)), "Lines come in the order nginx writes them.");
        Assert.True(requests.Select(r => DateTimeOffset.FromUnixTimeMilliseconds(r.AtUnixMs).Date).Distinct().Count() >= 6);
        Assert.Contains(requests, r => r.Agent.IsBot);
        Assert.Contains(requests, r => r.Agent.Device == TrafficDevice.Mobile);
        Assert.Contains(requests, r => r.Agent.Device == TrafficDevice.Tablet);
        Assert.Contains(requests, r => r.Status == 404);
        Assert.Contains(requests, r => r.Geo.Source == CountrySource.Cloudflare);
        Assert.True(requests.Select(r => r.Geo.Country).Distinct().Count() >= 5);
        Assert.True(requests.Count(request => TrafficAggregator.IsPageView(request)) > 500);
        Assert.True(requests.Select(r => r.Path).Distinct().Count() >= 10);
    }

    [Fact]
    public void The_same_seed_gives_the_same_lines()
    {
        Assert.Equal(FakeTraffic.Visits(300, 3, 7, _now), FakeTraffic.Visits(300, 3, 7, _now));
        Assert.NotEqual(FakeTraffic.Visits(300, 3, 7, _now), FakeTraffic.Visits(300, 3, 8, _now));
    }

    [Theory]
    [InlineData(AttackKind.Scan)]
    [InlineData(AttackKind.BruteForce)]
    [InlineData(AttackKind.Flood)]
    [InlineData(AttackKind.Injection)]
    public void An_attack_burst_trips_its_detector(AttackKind kind)
    {
        var detector = new AttackDetector(_thresholds, []);
        var hits = new List<AttackHit>();

        foreach (var request in Parse(FakeTraffic.Attack(kind, "198.51.100.23", _thresholds, _now)))
        {
            detector.Observe(request, hits);
        }

        Assert.Contains(hits, hit => hit.Kind == kind && hit.Address.ToString() == "198.51.100.23");
    }
}
