using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>
/// Runs the cases in packages/core/src/health/fixtures, which @runova/core's Vitest runs through
/// the TypeScript parser too (fixtures.test.ts). Both suites passing is what keeps the ports equal.
/// </summary>
public sealed class FixtureTests
{
    private const long At = 1_760_000_000_000;

    private static readonly JsonSerializerOptions _compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly Dictionary<string, JsonElement> _parseCases = Load("parse.json");
    private static readonly Dictionary<string, JsonElement> _transitionCases = Load("transitions.json");

    public static TheoryData<string> ParseCases => [.. _parseCases.Keys];
    public static TheoryData<string> TransitionCases => [.. _transitionCases.Keys];

    private static Dictionary<string, JsonElement> Load(string file)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", file);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.EnumerateArray().ToDictionary(item => item.GetProperty("name").GetString()!, item => item.Clone());
    }

    [Fact]
    public void Finds_the_shared_fixtures()
    {
        Assert.True(_parseCases.Count > 20);
        Assert.True(_transitionCases.Count > 10);
    }

    [Theory]
    [MemberData(nameof(ParseCases))]
    public void Parses_like_the_TypeScript_parser(string name)
    {
        var item = _parseCases[name];
        var input = item.GetProperty("input");
        var want = item.GetProperty("expect");

        var report = HealthParser.Parse(new HealthResponseInput(
            Int(input, "httpStatus") ?? 200,
            input.TryGetProperty("contentType", out var contentType) ? contentType.GetString() : "application/health+json",
            input.TryGetProperty("body", out var body) ? body.GetString()! : JsonSerializer.Serialize(input.GetProperty("json"), _compact),
            input.TryGetProperty("latencyMs", out var latency) ? (latency.ValueKind == JsonValueKind.Null ? null : latency.GetInt32()) : 42,
            DateTimeOffset.FromUnixTimeMilliseconds(input.TryGetProperty("checkedAt", out var at) ? at.GetInt64() : At),
            input.TryGetProperty("knownSecrets", out var secrets) ? [.. secrets.EnumerateArray().Select(secret => secret.GetString()!)] : null));

        Assert.Equal(want.GetProperty("state").GetString(), HealthStates.ToWire(report.State));
        CheckInt(want, "httpStatus", report.HttpStatus);
        CheckInt(want, "latencyMs", report.LatencyMs);
        if (want.TryGetProperty("checkedAt", out var checkedAt))
        {
            Assert.Equal(checkedAt.GetInt64(), report.CheckedAt.ToUnixTimeMilliseconds());
        }

        CheckText(want, "serviceId", report.ServiceId);
        CheckText(want, "description", report.Description);
        CheckText(want, "releaseId", report.ReleaseId);
        CheckText(want, "version", report.Version);
        CheckText(want, "output", report.Output);
        CheckText(want, "problem", report.Problem);
        CheckText(want, "raw", report.Raw);

        if (want.TryGetProperty("serviceKeys", out var keys))
        {
            Assert.Equal(keys.EnumerateArray().Select(key => key.GetString()), report.Services.Select(service => service.Key));
        }

        if (want.TryGetProperty("services", out var services))
        {
            var expected = services.EnumerateArray().ToList();
            Assert.Equal(expected.Count, report.Services.Count);
            for (var index = 0; index < expected.Count; index++)
            {
                CheckService(expected[index], report.Services[index]);
            }
        }

        foreach (var text in Strings(want, "rawContains"))
        {
            Assert.Contains(text, report.Raw, StringComparison.Ordinal);
        }

        foreach (var text in Strings(want, "rawExcludes"))
        {
            Assert.DoesNotContain(text, report.Raw ?? "", StringComparison.Ordinal);
        }

        var all = Everything(report);
        foreach (var text in Strings(want, "excludes"))
        {
            Assert.DoesNotContain(text, all, StringComparison.Ordinal);
        }
    }

    [Theory]
    [MemberData(nameof(TransitionCases))]
    public void Moves_like_the_TypeScript_transitions(string name)
    {
        var item = _transitionCases[name];
        var confirm = item.TryGetProperty("confirm", out var value) ? value.GetInt32() : 2;
        var track = HealthTrack.Initial;
        var events = new List<string>();
        foreach (var state in item.GetProperty("states").EnumerateArray())
        {
            Assert.True(HealthStates.TryParse(state.GetString(), out var probe));
            var step = HealthTransitions.Next(track, probe, confirm);
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

        var want = item.GetProperty("expect");
        Assert.Equal(want.GetProperty("events").EnumerateArray().Select(one => one.GetString()), events);
        var confirmed = want.GetProperty("confirmed").GetString();
        Assert.Equal(confirmed, track.Confirmed switch { HealthVerdict.Ok => "ok", HealthVerdict.Problem => "problem", _ => null });
        Assert.Equal(want.GetProperty("streak").GetInt32(), track.Streak);
        Assert.Equal(want.GetProperty("pending").GetBoolean(), track.Pending);
    }

    private static void CheckService(JsonElement want, HealthServiceResult service)
    {
        foreach (var property in want.EnumerateObject())
        {
            var value = property.Value;
            switch (property.Name)
            {
                case "key":
                    Assert.Equal(value.GetString(), service.Key);
                    break;
                case "name":
                    Assert.Equal(value.GetString(), service.Name);
                    break;
                case "measurement":
                    Assert.Equal(value.GetString(), service.Measurement);
                    break;
                case "componentId":
                    Assert.Equal(value.GetString(), service.ComponentId);
                    break;
                case "componentType":
                    Assert.Equal(value.GetString(), service.ComponentType);
                    break;
                case "status":
                    Assert.Equal(value.GetString(), HealthStates.ToWire(service.Status));
                    break;
                case "observedUnit":
                    Assert.Equal(value.GetString(), service.ObservedUnit);
                    break;
                case "time":
                    Assert.Equal(value.GetString(), service.Time);
                    break;
                case "observedValue":
                    if (value.ValueKind == JsonValueKind.Null)
                    {
                        Assert.Null(service.ObservedValue);
                    }
                    else
                    {
                        Assert.NotNull(service.ObservedValue);
                        Assert.True(JsonElement.DeepEquals(value, service.ObservedValue.Value), $"{service.Key}: {service.ObservedValue.Value.GetRawText()}");
                    }

                    break;
                case "error":
                    CheckError(value, service);
                    break;
                default:
                    Assert.Fail($"The fixture names a service field the test does not know: {property.Name}");
                    break;
            }
        }
    }

    private static void CheckError(JsonElement want, HealthServiceResult service)
    {
        if (want.ValueKind == JsonValueKind.Null)
        {
            Assert.Null(service.Error);
            return;
        }

        var error = service.Error;
        Assert.NotNull(error);
        foreach (var property in want.EnumerateObject())
        {
            var actual = property.Name switch
            {
                "message" => error.Message,
                "code" => error.Code,
                "detail" => error.Detail,
                "stack" => error.Stack,
                "hint" => error.Hint,
                "since" => error.Since,
                _ => throw new InvalidOperationException($"Unknown error field {property.Name}"),
            };
            Assert.Equal(property.Value.GetString(), actual);
        }
    }

    private static int? Int(JsonElement owner, string name) =>
        owner.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32() : null;

    private static void CheckInt(JsonElement want, string name, int? actual)
    {
        if (want.TryGetProperty(name, out var value))
        {
            Assert.Equal(value.ValueKind == JsonValueKind.Null ? null : value.GetInt32(), actual);
        }
    }

    private static void CheckText(JsonElement want, string name, string? actual)
    {
        if (want.TryGetProperty(name, out var value))
        {
            Assert.Equal(value.GetString(), actual);
        }
    }

    private static IEnumerable<string> Strings(JsonElement owner, string name) =>
        owner.TryGetProperty(name, out var value) ? value.EnumerateArray().Select(item => item.GetString()!) : [];

    /// <summary>Every string in the report, so a test can say a secret is nowhere in it.</summary>
    internal static string Everything(HealthReport report)
    {
        var all = new StringBuilder();
        foreach (var text in new[] { report.ServiceId, report.Description, report.ReleaseId, report.Version, report.Output, report.Problem, report.Raw })
        {
            all.Append(text).Append('\n');
        }

        foreach (var service in report.Services)
        {
            all.Append(service.Key).Append('\n').Append(service.Name).Append('\n').Append(service.Measurement).Append('\n')
                .Append(service.ComponentId).Append('\n').Append(service.ComponentType).Append('\n')
                .Append(service.ObservedValue?.GetRawText()).Append('\n').Append(service.ObservedUnit).Append('\n').Append(service.Time).Append('\n');
            if (service.Error is { } error)
            {
                all.Append(error.Message).Append('\n').Append(error.Code).Append('\n').Append(error.Detail).Append('\n')
                    .Append(error.Stack).Append('\n').Append(error.Hint).Append('\n').Append(error.Since).Append('\n');
            }
        }

        return all.ToString();
    }
}
