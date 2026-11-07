using System.Net;
using System.Text.Json;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Checks a response is RFC 9457 problem details in the contract's shape.</summary>
internal static class ProblemAssert
{
    /// <summary>The URI of a problem type from the contract's table.</summary>
    public static string Type(string slug) => "https://runovahq.com/problems/" + slug;

    public static async Task<JsonElement> IsProblemAsync(
        HttpResponseMessage response, HttpStatusCode status, string type, string instance)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);

        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var document = JsonDocument.Parse(body);
        var problem = document.RootElement.Clone();
        Assert.Equal(type, problem.GetProperty("type").GetString());
        Assert.Equal((int)status, problem.GetProperty("status").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("title").GetString()));
        Assert.Equal(instance, problem.GetProperty("instance").GetString());
        Assert.Matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$", problem.GetProperty("traceId").GetString());
        return problem;
    }

    /// <summary>A problem of this status, with the type the contract gives that status.</summary>
    public static Task<JsonElement> IsAsync(HttpResponseMessage response, HttpStatusCode status) =>
        IsAsync(response, status, (int)status switch
        {
            400 => "validation-failed",
            401 => "unauthorized",
            403 => "forbidden",
            404 => "not-found",
            409 => "conflict",
            412 => "precondition-failed",
            428 => "precondition-required",
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, "No default problem type for this status."),
        });

    /// <summary>A problem of this status and type, at whatever path it answered.</summary>
    public static async Task<JsonElement> IsAsync(HttpResponseMessage response, HttpStatusCode status, string slug)
    {
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.True(status == response.StatusCode, $"Expected {(int)status}, got {(int)response.StatusCode}: {body}");
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        using var document = JsonDocument.Parse(body);
        var problem = document.RootElement.Clone();
        Assert.Equal(Type(slug), problem.GetProperty("type").GetString());
        return problem;
    }
}
