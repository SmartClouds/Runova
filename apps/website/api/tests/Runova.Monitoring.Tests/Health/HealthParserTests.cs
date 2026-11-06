using System.Text.Json;
using Runova.Monitoring.Core.Health;

namespace Runova.Monitoring.Tests.Health;

/// <summary>The cases of parse.test.ts that need code rather than data, plus the C# shapes.</summary>
public sealed class HealthParserTests
{
    private static readonly DateTimeOffset _at = DateTimeOffset.FromUnixTimeMilliseconds(1_760_000_000_000);

    private static HealthReport Respond(int status, object body, string contentType = HealthProtocol.MediaType) =>
        HealthParser.Parse(new HealthResponseInput(status, contentType, body as string ?? JsonSerializer.Serialize(body), 42, _at));

    [Fact]
    public void Normalizes_a_passing_report()
    {
        var report = Respond(200, new
        {
            status = "pass",
            serviceId = "curalink-api",
            checks = new Dictionary<string, object[]>
            {
                ["postgres:connection"] = [new { componentId = "db", status = "pass", observedValue = 12.5, observedUnit = "ms" }],
            },
        });

        Assert.Equal(HealthProbeState.Pass, report.State);
        Assert.Equal(200, report.HttpStatus);
        Assert.Equal(42, report.LatencyMs);
        Assert.Equal(_at, report.CheckedAt);
        Assert.Equal("curalink-api", report.ServiceId);
        Assert.Null(report.Problem);
        var service = Assert.Single(report.Services);
        Assert.Equal("postgres", service.Name);
        Assert.Equal("connection", service.Measurement);
        Assert.Equal(12.5, service.ObservedValue!.Value.GetDouble());
        Assert.Null(service.Error);
    }

    [Fact]
    public void Keeps_the_observed_value_after_the_document_is_gone()
    {
        var report = Respond(200, """{"status":"pass","checks":{"a":[{"status":"pass","observedValue":"x"}],"b":[{"status":"pass","observedValue":false}]}}""");
        GC.Collect();
        Assert.Equal("x", report.Services[0].ObservedValue!.Value.GetString());
        Assert.Equal(JsonValueKind.False, report.Services[1].ObservedValue!.Value.ValueKind);
    }

    [Fact]
    public void Trims_long_text_so_one_noisy_service_can_not_flood_the_store()
    {
        var report = Respond(503, new
        {
            status = "fail",
            checks = new Dictionary<string, object[]>
            {
                ["db"] = [new { status = "fail", output = string.Concat(Enumerable.Repeat("x ", 5_000)), runova = new { stack = string.Concat(Enumerable.Repeat("y ", 25_000)) } }],
            },
        });

        var error = report.Services[0].Error!;
        Assert.True(error.Message.Length <= 2_100);
        Assert.EndsWith("\n(trimmed)", error.Message, StringComparison.Ordinal);
        Assert.True(error.Stack!.Length <= 8_300);
        Assert.True(report.Raw!.Length <= 64_200);
    }

    [Fact]
    public void Caps_the_number_of_services()
    {
        var checks = Enumerable.Range(0, 300).ToDictionary(index => $"c{index}", _ => new object[] { new { status = "pass" } });
        Assert.Equal(200, Respond(200, new { status = "pass", checks }).Services.Count);
    }

    [Fact]
    public void Counts_a_lone_surrogate_escape_as_not_json()
    {
        // JavaScript keeps the lone half; .NET can not hold it in a string, so it says why it gave up.
        var report = Respond(200, """{"status":"pass","x":"\uD800"}""");
        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.Contains("not JSON", report.Problem, StringComparison.Ordinal);
    }

    [Fact]
    public void Reads_deeply_nested_json()
    {
        var nested = string.Concat(Enumerable.Repeat("[", 500)) + string.Concat(Enumerable.Repeat("]", 500));
        var report = Respond(200, "{\"status\":\"pass\",\"deep\":" + nested + "}");
        Assert.Equal(HealthProbeState.Pass, report.State);
    }

    [Theory]
    [InlineData("a=")]
    [InlineData("a.")]
    [InlineData("\"a\":")]
    public void Survives_a_512_KB_body_built_to_make_the_redaction_slow(string unit)
    {
        // a=a=a=... nests one value in the next, all the way down; a.a.a. makes every position a
        // possible name. Neither may crash a node or hold it for long.
        var body = string.Concat(Enumerable.Repeat(unit, 512 * 1024 / unit.Length));
        var report = Respond(200, body, "text/plain");
        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.EndsWith("\n(trimmed)", report.Raw, StringComparison.Ordinal);
        Assert.True(report.Raw!.Length <= 64_000 + 10);
    }

    [Fact]
    public void Cuts_a_long_body_at_a_space_so_no_secret_is_split()
    {
        var key = "rnh_" + new string('k', 43);
        var body = new string('x', 63_990) + " " + string.Concat(Enumerable.Repeat(key + " ", 2_000));
        var report = HealthParser.Parse(new HealthResponseInput(200, null, body, 1, _at, [key]));
        Assert.DoesNotContain("rnh_", report.Raw, StringComparison.Ordinal);
        Assert.EndsWith("\n(trimmed)", report.Raw, StringComparison.Ordinal);
    }

    [Fact]
    public void Masks_a_literal_secret_the_caller_knows()
    {
        var key = "rnh_" + new string('k', 43);
        var report = HealthParser.Parse(new HealthResponseInput(
            503, "application/json", JsonSerializer.Serialize(new { status = "fail", output = $"bad header {key}" }), 1, _at, [key]));
        Assert.DoesNotContain(key, FixtureTests.Everything(report), StringComparison.Ordinal);
    }

    [Fact]
    public void Builds_an_unreachable_report_with_the_reason()
    {
        var report = HealthParser.ProbeFailure("Connection refused", _at);
        Assert.Equal(HealthProbeState.Unreachable, report.State);
        Assert.Null(report.HttpStatus);
        Assert.Null(report.LatencyMs);
        Assert.Equal(_at, report.CheckedAt);
        Assert.Equal("Connection refused", report.Problem);
        Assert.Empty(report.Services);
        Assert.Null(report.Raw);
    }

    [Fact]
    public void Can_mark_a_probe_failure_invalid_and_redacts_the_reason()
    {
        var report = HealthParser.ProbeFailure("bad url https://u:secretpw@x", _at, HealthProbeState.Invalid);
        Assert.Equal(HealthProbeState.Invalid, report.State);
        Assert.DoesNotContain("secretpw", report.Problem, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(HealthProbeState.Pass)]
    [InlineData(HealthProbeState.Fail)]
    [InlineData(HealthProbeState.Unauthorized)]
    public void Refuses_a_probe_failure_with_a_state_an_answer_decides(HealthProbeState state)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => HealthParser.ProbeFailure("x", _at, state));
    }
}
