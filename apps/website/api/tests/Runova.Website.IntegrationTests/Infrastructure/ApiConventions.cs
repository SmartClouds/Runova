using System.Text.Json;
using System.Text.RegularExpressions;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The conventions in docs/website/api-contract.md that an OpenAPI document can show: every path a
/// plural noun under <c>/api/v1</c>, every error response problem details, every operation and
/// status code one the contract lists, and every contract row an operation. Each check returns what breaks the rule, so a test can name it.
/// </summary>
internal static partial class ApiConventions
{
    public const string Base = "/api/v1/";

    /// <summary>The fixed sub-resources and mass nouns that the contract allows in the singular.</summary>
    public static readonly IReadOnlySet<string> SingularSegments = new HashSet<string>(StringComparer.Ordinal)
    {
        "me", "current", "latest", "two-factor", "password", "downloads", "news", "media", "usage",
    };

    private static readonly HashSet<string> _problemSchemas = new(StringComparer.Ordinal)
    {
        "#/components/schemas/ProblemDetails",
        "#/components/schemas/HttpValidationProblemDetails",
    };

    /// <summary>What is wrong with a path, or nothing when it follows the convention.</summary>
    public static IEnumerable<string> PathProblems(string path)
    {
        if (!path.StartsWith(Base, StringComparison.Ordinal))
        {
            yield return $"{path} is not under {Base}";
            yield break;
        }

        foreach (var segment in path[Base.Length..].Split('/'))
        {
            if (IsParameter(segment) || SingularSegments.Contains(segment))
            {
                continue;
            }

            if (!PluralNoun().IsMatch(segment))
            {
                yield return $"{path}: '{segment}' is not a plural noun";
            }
        }
    }

    /// <summary>Every 4xx or 5xx response in the document that is not problem details.</summary>
    public static IEnumerable<string> ErrorResponseProblems(JsonElement document)
    {
        foreach (var (method, path, operation) in Operations(document))
        {
            foreach (var response in operation.GetProperty("responses").EnumerateObject())
            {
                if (!int.TryParse(response.Name, out var status) || status < 400)
                {
                    continue;
                }

                var where = $"{method} {path} {status}";
                if (!response.Value.TryGetProperty("content", out var content))
                {
                    yield return $"{where} has no problem details body";
                    continue;
                }

                foreach (var mediaType in content.EnumerateObject())
                {
                    if (mediaType.Name != "application/problem+json")
                    {
                        yield return $"{where} is {mediaType.Name}, not application/problem+json";
                    }
                    else if (!mediaType.Value.TryGetProperty("schema", out var schema)
                        || !schema.TryGetProperty("$ref", out var reference)
                        || !_problemSchemas.Contains(reference.GetString() ?? ""))
                    {
                        yield return $"{where} is not a problem details schema";
                    }
                }
            }
        }
    }

    /// <summary>
    /// Every operation the contract does not list, and every status code the document gives one
    /// that the contract's row does not. A GET may also answer 304: the caching conventions give
    /// every response with an ETag a conditional GET.
    /// </summary>
    public static IEnumerable<string> ContractProblems(JsonElement document, IReadOnlyDictionary<string, IReadOnlySet<int>> contract)
    {
        foreach (var (method, path, operation) in Operations(document))
        {
            var key = $"{method} {path}";
            if (!contract.TryGetValue(key, out var listed))
            {
                yield return $"{key} is not in the contract";
                continue;
            }

            foreach (var response in operation.GetProperty("responses").EnumerateObject())
            {
                if (!int.TryParse(response.Name, out var status) || listed.Contains(status) || (method == "GET" && status == 304))
                {
                    continue;
                }

                yield return $"{key} documents {status}, which the contract does not list";
            }
        }
    }

    /// <summary>Every contract row the document has no operation for: listed, but never built.</summary>
    public static IEnumerable<string> MissingOperations(JsonElement document, IReadOnlyDictionary<string, IReadOnlySet<int>> contract)
    {
        var documented = Operations(document).Select(o => $"{o.Method} {o.Path}").ToHashSet(StringComparer.Ordinal);
        return contract.Keys.Where(row => !documented.Contains(row)).Order(StringComparer.Ordinal).Select(row => $"{row} is in the contract but not in the document");
    }

    /// <summary>
    /// The rows of the contract's resource tables: <c>| METHOD | `/api/v1/...` | Auth | Request |
    /// Responses |</c>, keyed by method and path, with the status codes named in Responses.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlySet<int>> ReadContract(string markdown)
    {
        var rows = new Dictionary<string, IReadOnlySet<int>>(StringComparer.Ordinal);
        foreach (var line in markdown.ReplaceLineEndings("\n").Split('\n'))
        {
            var match = ContractRow().Match(line);
            if (match.Success)
            {
                var statuses = StatusCode().Matches(match.Groups["responses"].Value).Select(m => int.Parse(m.Value, System.Globalization.CultureInfo.InvariantCulture));
                rows[$"{match.Groups["method"].Value} {match.Groups["path"].Value}"] = statuses.ToHashSet();
            }
        }

        return rows;
    }

    private static IEnumerable<(string Method, string Path, JsonElement Operation)> Operations(JsonElement document)
    {
        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                if (operation.Name != "parameters")
                {
                    yield return (operation.Name.ToUpperInvariant(), path.Name, operation.Value);
                }
            }
        }
    }

    private static bool IsParameter(string segment) => segment.Length > 2 && segment[0] == '{' && segment[^1] == '}';

    // Lowercase words joined by single hyphens, ending in an s that is not a double s.
    [GeneratedRegex("^[a-z]+(-[a-z]+)*(?<!s)s$")]
    private static partial Regex PluralNoun();

    [GeneratedRegex(@"^\|\s*(?<method>GET|POST|PUT|PATCH|DELETE)\s*\|\s*`(?<path>/api/v1/[^`]+)`\s*\|[^|]*\|[^|]*\|(?<responses>.*)\|\s*$")]
    private static partial Regex ContractRow();

    [GeneratedRegex(@"\b[1-5]\d\d\b")]
    private static partial Regex StatusCode();
}
