using System.Globalization;
using System.Text.Json;

namespace Runova.Monitoring.Core.Health;

/// <summary>One answer of a health endpoint, as the prober read it.</summary>
/// <param name="KnownSecrets">Literal secrets to mask wherever they show up, such as the key that was sent.</param>
public sealed record HealthResponseInput(
    int HttpStatus,
    string? ContentType,
    string Body,
    int? LatencyMs,
    DateTimeOffset CheckedAt,
    IReadOnlyList<string>? KnownSecrets = null);

/// <summary>
/// Turns an endpoint's answer into a <see cref="HealthReport"/>. A port of <c>health/parse.ts</c>:
/// the body follows the IETF draft "Health Check Response Format for HTTP APIs" with a
/// <c>runova</c> extension per check for error details.
/// </summary>
/// <remarks>
/// The parser is strict about what decides the verdict (the top-level <c>status</c>) and lenient
/// about everything else: one malformed check entry is skipped, not allowed to hide the rest.
/// Every string is redacted and trimmed here, so nothing downstream ever holds the raw text.
/// </remarks>
public static class HealthParser
{
    private const int MaxMessage = 2_000;
    private const int MaxDetail = 4_000;
    private const int MaxStack = 8_000;
    private const int MaxShort = 200;
    private const int MaxHint = 1_000;
    private const int MaxRaw = 64_000;
    private const int MaxServices = 200;

    private static readonly string[] _textFields = ["componentId", "componentType", "time", "observedUnit", "output"];
    private static readonly string[] _extraTextFields = ["detail", "stack", "hint", "since"];

    /// <summary>A report for a probe that never got an answer to read (a timeout, a refused connection).</summary>
    /// <param name="state">Unreachable or Invalid; the other states come from an answer.</param>
    public static HealthReport ProbeFailure(string problem, DateTimeOffset checkedAt, HealthProbeState state = HealthProbeState.Unreachable)
    {
        ArgumentNullException.ThrowIfNull(problem);
        if (state is not (HealthProbeState.Unreachable or HealthProbeState.Invalid))
        {
            throw new ArgumentOutOfRangeException(nameof(state), state, "A probe failure is unreachable or invalid.");
        }

        return new HealthReport { State = state, CheckedAt = checkedAt, Problem = HealthRedactor.Redact(problem) };
    }

    public static HealthReport Parse(HealthResponseInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        var text = new Cleaner(input.KnownSecrets ?? []);
        var status = input.HttpStatus;
        var report = new HealthReport
        {
            State = HealthProbeState.Invalid,
            HttpStatus = status,
            LatencyMs = input.LatencyMs,
            CheckedAt = input.CheckedAt,
        };

        if (status is 401 or 403)
        {
            return report with
            {
                State = HealthProbeState.Unauthorized,
                Problem = Format($"The endpoint rejected Runova's credentials (HTTP {status}). Check that the key or password on the server matches this target."),
            };
        }

        if (status is >= 300 and < 400)
        {
            return report with
            {
                Problem = Format($"The endpoint answered with a redirect (HTTP {status}). Runova does not follow redirects, so its credentials are never sent to another address. Use the final URL."),
            };
        }

        var raw = IsBlank(input.Body) ? null : text.Clean(input.Body, MaxRaw);
        using var document = raw is null ? null : JsJson.TryParse(input.Body);
        if (document is null)
        {
            if (status >= 500)
            {
                var what = raw is null ? " and no health report" : " and a body that is not JSON";
                return report with { State = HealthProbeState.Fail, Problem = Format($"The endpoint failed with HTTP {status}{what}."), Raw = raw };
            }

            if (status >= 400)
            {
                return report with { Problem = Format($"There is no healthcheck at this address (HTTP {status})."), Raw = raw };
            }

            return report with
            {
                Problem = raw is null
                    ? Format($"The endpoint answered HTTP {status} with an empty body.")
                    : "The endpoint answered, but the body is not JSON, so it does not follow the Runova Health Protocol.",
                Raw = raw,
            };
        }

        var json = document.RootElement;
        var pretty = text.Clean(JsJson.Stringify(json), MaxRaw);
        if (json.ValueKind != JsonValueKind.Object)
        {
            return report with { Problem = "The report must be a JSON object with a \"status\" field.", Raw = pretty };
        }

        var hasStatus = JsJson.TryGet(json, "status", out var statusValue);
        var declared = hasStatus ? StatusOf(statusValue) : null;
        if (declared is null)
        {
            return report with
            {
                Problem = hasStatus
                    ? $"The report's status \"{text.Clean(JsJson.ToJsString(statusValue), MaxShort)}\" is not one of \"pass\", \"warn\" or \"fail\"."
                    : "The report has no \"status\" field. It must be \"pass\", \"warn\" or \"fail\".",
                Raw = pretty,
            };
        }

        var services = JsJson.TryGet(json, "checks", out var checks) ? ReadServices(checks, text) : [];
        var worst = declared.Value;
        if (worst == HealthCheckStatus.Pass && services.Any(service => service.Status != HealthCheckStatus.Pass))
        {
            worst = HealthCheckStatus.Warn;
        }

        if (status >= 500)
        {
            worst = HealthCheckStatus.Fail;
        }

        string? Top(string key, int max = MaxShort) =>
            JsJson.TryGet(json, key, out var value) && value.ValueKind == JsonValueKind.String ? text.Optional(value.GetString(), max) : null;

        return report with
        {
            State = worst switch
            {
                HealthCheckStatus.Pass => HealthProbeState.Pass,
                HealthCheckStatus.Warn => HealthProbeState.Warn,
                _ => HealthProbeState.Fail,
            },
            ServiceId = Top("serviceId"),
            Description = Top("description"),
            ReleaseId = Top("releaseId"),
            Version = Top("version"),
            Output = Top("output", MaxMessage),
            Services = services,
            Raw = pretty,
        };
    }

    private static List<HealthServiceResult> ReadServices(JsonElement checks, Cleaner text)
    {
        var services = new List<HealthServiceResult>();
        if (checks.ValueKind != JsonValueKind.Object)
        {
            return services;
        }

        foreach (var (key, entries) in JsJson.Properties(checks))
        {
            if (entries.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var valid = new List<CheckEntry>();
            foreach (var item in entries.EnumerateArray())
            {
                if (CheckEntry.TryRead(item, out var entry))
                {
                    valid.Add(entry);
                }
            }

            var parts = key.Split(':');
            var name = parts[0];
            var measurement = parts.Length > 1 ? text.Clean(string.Join(':', parts[1..]), MaxShort) : null;
            foreach (var entry in valid)
            {
                if (services.Count >= MaxServices)
                {
                    return services;
                }

                var suffix = valid.Count > 1 && !string.IsNullOrEmpty(entry.ComponentId) ? "#" + entry.ComponentId : "";
                var extra = entry.Extra ?? Extra.Empty;
                var error = entry.Status == HealthCheckStatus.Pass
                    ? null
                    : new HealthServiceError
                    {
                        Message = !string.IsNullOrEmpty(entry.Output)
                            ? text.Clean(entry.Output, MaxMessage)
                            : entry.Status == HealthCheckStatus.Fail
                                ? "Reported as failing with no error message."
                                : "Reported as degraded with no message.",
                        Code = text.Optional(extra.ErrorCode, MaxShort),
                        Detail = text.Optional(extra.Detail, MaxDetail),
                        Stack = text.Optional(extra.Stack, MaxStack),
                        Hint = text.Optional(extra.Hint, MaxHint),
                        Since = text.Optional(extra.Since, MaxShort),
                    };

                services.Add(new HealthServiceResult
                {
                    Key = text.Clean(key + suffix, MaxShort),
                    Name = text.Clean(name, MaxShort),
                    Measurement = measurement,
                    ComponentId = text.Optional(entry.ComponentId, MaxShort),
                    ComponentType = text.Optional(entry.ComponentType, MaxShort),
                    Status = entry.Status,
                    ObservedValue = entry.ObservedValue is { ValueKind: JsonValueKind.String } observed
                        ? JsonSerializer.SerializeToElement(text.Clean(observed.GetString()!, MaxShort))
                        : entry.ObservedValue,
                    ObservedUnit = text.Optional(entry.ObservedUnit, MaxShort),
                    Time = text.Optional(entry.Time, MaxShort),
                    Error = error,
                });
            }
        }

        return services;
    }

    private static HealthCheckStatus? StatusOf(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return TrimJs(value.GetString()!).ToLowerInvariant() switch
        {
            "pass" or "ok" or "up" => HealthCheckStatus.Pass,
            "warn" => HealthCheckStatus.Warn,
            "fail" or "error" or "down" => HealthCheckStatus.Fail,
            _ => null,
        };
    }

    private static string Format(FormattableString text) => text.ToString(CultureInfo.InvariantCulture);

    /// <summary>What JavaScript's <c>String.prototype.trim</c> removes.</summary>
    private static bool IsJsSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00A0' or '\u1680' or '\u2028' or '\u2029'
            or '\u202F' or '\u205F' or '\u3000' or '\uFEFF' or (>= '\u2000' and <= '\u200A');

    private static bool IsBlank(string value) => value.All(IsJsSpace);

    private static string TrimJs(string value)
    {
        var start = 0;
        var end = value.Length;
        while (start < end && IsJsSpace(value[start]))
        {
            start++;
        }

        while (end > start && IsJsSpace(value[end - 1]))
        {
            end--;
        }

        return value[start..end];
    }

    /// <summary>
    /// Redacts and trims. TypeScript redacts the whole text and then trims it; here text much
    /// longer than it may end up is cut first (at a line break or space near the end when there is
    /// one, so no token is split), because some patterns take time that grows with the square of
    /// the length and a 512 KB body made to hit that could hold a node for seconds. Text up to
    /// <see cref="Margin"/> past the limit is treated exactly as TypeScript treats it.
    /// </summary>
    private sealed class Cleaner(IReadOnlyList<string> secrets)
    {
        private const int Margin = 16 * 1024;

        public string Clean(string value, int max)
        {
            if (value.Length <= max + Margin)
            {
                return Trim(HealthRedactor.Redact(value, secrets), max);
            }

            var space = value.AsSpan(max, Margin).LastIndexOfAny(" \t\r\n");
            var redacted = HealthRedactor.Redact(value[..(space < 0 ? max + Margin : max + space)], secrets);
            return redacted[..Math.Min(redacted.Length, max)] + "\n(trimmed)";
        }

        public string? Optional(string? value, int max) => string.IsNullOrEmpty(value) ? null : Clean(value, max);

        private static string Trim(string value, int max) => value.Length <= max ? value : value[..max] + "\n(trimmed)";
    }

    /// <summary>The <c>runova</c> details of a check, as the TypeScript schema accepts them.</summary>
    private sealed record Extra(string? ErrorCode, string? Detail, string? Stack, string? Hint, string? Since)
    {
        public static readonly Extra Empty = new(null, null, null, null, null);

        /// <summary>Null when it is missing or any field has the wrong type, as zod's <c>.catch(undefined)</c> does.</summary>
        public static Extra? Read(JsonElement owner, string key)
        {
            if (!JsJson.TryGet(owner, key, out var value) || value.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? code = null;
            if (JsJson.TryGet(value, "errorCode", out var errorCode))
            {
                if (errorCode.ValueKind == JsonValueKind.String)
                {
                    code = errorCode.GetString();
                }
                else if (errorCode.ValueKind == JsonValueKind.Number && double.IsFinite(JsJson.Number(errorCode)))
                {
                    code = JsJson.ToJsString(errorCode);
                }
                else
                {
                    return null;
                }
            }

            var fields = new string?[_extraTextFields.Length];
            for (var index = 0; index < fields.Length; index++)
            {
                if (!TryText(value, _extraTextFields[index], out fields[index]))
                {
                    return null;
                }
            }

            return new Extra(code, fields[0], fields[1], fields[2], fields[3]);
        }
    }

    /// <summary>One entry under a check key that passed the TypeScript schema and has a known status.</summary>
    private sealed record CheckEntry(
        string? ComponentId,
        string? ComponentType,
        string? Time,
        string? ObservedUnit,
        string? Output,
        HealthCheckStatus Status,
        JsonElement? ObservedValue,
        Extra? Extra)
    {
        public static bool TryRead(JsonElement item, out CheckEntry entry)
        {
            entry = null!;
            if (item.ValueKind != JsonValueKind.Object)
            {
                return false;
            }

            var fields = new string?[_textFields.Length];
            for (var index = 0; index < fields.Length; index++)
            {
                if (!TryText(item, _textFields[index], out fields[index]))
                {
                    return false;
                }
            }

            if (!JsJson.TryGet(item, "status", out var statusValue) || statusValue.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            JsonElement? observed = null;
            if (JsJson.TryGet(item, "observedValue", out var value))
            {
                switch (value.ValueKind)
                {
                    case JsonValueKind.String or JsonValueKind.True or JsonValueKind.False:
                        observed = value.Clone();
                        break;
                    case JsonValueKind.Number when double.IsFinite(JsJson.Number(value)):
                        observed = value.Clone();
                        break;
                    case JsonValueKind.Null:
                        break;
                    default:
                        return false;
                }
            }

            // A status word the protocol does not know drops the entry, like a schema failure.
            if (StatusOf(statusValue) is not { } status)
            {
                return false;
            }

            entry = new CheckEntry(
                fields[0],
                fields[1],
                fields[2],
                fields[3],
                fields[4],
                status,
                observed,
                Extra.Read(item, HealthProtocol.CheckKey));
            return true;
        }
    }

    /// <summary>An optional string field: missing is fine, any other type fails the schema.</summary>
    private static bool TryText(JsonElement owner, string key, out string? value)
    {
        value = null;
        if (!JsJson.TryGet(owner, key, out var element))
        {
            return true;
        }

        if (element.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = element.GetString();
        return true;
    }
}
