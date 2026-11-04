using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Runova.Website.Api.Health;

/// <summary>
/// <c>GET /_runova/health</c>, the runova-health/1 report Runova polls on the Production
/// environment. Only a request with <c>Authorization: Bearer &lt;key&gt;</c> whose SHA-256 is
/// <c>RUNOVA_HEALTH_TOKEN_SHA256</c> gets it; without that variable every request is refused.
/// Each caller address gets <see cref="RequestsPerMinute"/>, refused attempts included.
/// </summary>
internal static class RunovaHealthEndpoint
{
    public const string Path = "/_runova/health";
    public const string TokenHashVariable = "RUNOVA_HEALTH_TOKEN_SHA256";
    public const string Challenge = "Bearer realm=\"runova-health\"";
    public const string RateLimitPolicy = "runova-health";
    public const int RequestsPerMinute = 30;

    private const string BearerPrefix = "Bearer ";

    public static IServiceCollection AddRunovaHealth(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<HealthRedaction>();
        services.AddSingleton<RunovaHealthReporter>();
        services.AddHttpClient(RunovaHealthChecks.SiteClient)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
        services.AddRateLimiter(options => options.AddPolicy(RateLimitPolicy, new PerAddressLimit()));
        return services;
    }

    public static IEndpointRouteBuilder MapRunovaHealth(this IEndpointRouteBuilder app)
    {
        // Anonymous to ASP.NET Core: the key is checked below, so a refusal stays an empty 401.
        app.MapGet(Path, AnswerAsync)
            .AllowAnonymous()
            .RequireRateLimiting(RateLimitPolicy)
            .ExcludeFromDescription();
        return app;
    }

    private static async Task AnswerAsync(HttpContext http)
    {
        var response = http.Response;
        KeepBodyAsWritten(http);
        response.Headers.CacheControl = "no-store";
        if (!IsAuthorized(http.Request.Headers.Authorization, http.RequestServices.GetRequiredService<IConfiguration>()[TokenHashVariable]))
        {
            response.StatusCode = StatusCodes.Status401Unauthorized;
            response.Headers.WWWAuthenticate = Challenge;
            return;
        }

        var reporter = http.RequestServices.GetRequiredService<RunovaHealthReporter>();
        byte[] body;
        RunovaHealthReport report;
        try
        {
            report = await reporter.GetAsync();
            body = JsonSerializer.SerializeToUtf8Bytes(report, RunovaHealthReport.Json);
        }
        catch (Exception e)
        {
            report = reporter.Broken(e);
            body = JsonSerializer.SerializeToUtf8Bytes(report, RunovaHealthReport.Json);
        }

        response.StatusCode = report.Status == HealthStatuses.Fail ? StatusCodes.Status503ServiceUnavailable : StatusCodes.Status200OK;
        response.ContentType = RunovaHealthReport.ContentType;
        response.ContentLength = body.Length;
        await response.Body.WriteAsync(body, http.RequestAborted);
    }

    /// <summary>
    /// True only for one <c>Bearer</c> credential whose SHA-256 (of its UTF-8 bytes) equals
    /// <paramref name="expectedHex"/>, compared in constant time. A missing or malformed variable
    /// refuses everything.
    /// </summary>
    internal static bool IsAuthorized(Microsoft.Extensions.Primitives.StringValues authorization, string? expectedHex)
    {
        if (ExpectedHash(expectedHex) is not { } expected
            || authorization is not { Count: 1 }
            || authorization[0] is not { } header
            || !header.StartsWith(BearerPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var key = header[BearerPrefix.Length..].Trim();
        var presented = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        return key.Length > 0 && CryptographicOperations.FixedTimeEquals(presented, expected);
    }

    private static byte[]? ExpectedHash(string? hex)
    {
        hex = hex?.Trim();
        if (hex is not { Length: SHA256.HashSizeInBytes * 2 })
        {
            return null;
        }

        try
        {
            return Convert.FromHexString(hex);
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // Status code pages would put a problem details body on the empty 401 and 429.
    private static void KeepBodyAsWritten(HttpContext http)
    {
        if (http.Features.Get<IStatusCodePagesFeature>() is { } pages)
        {
            pages.Enabled = false;
        }
    }

    /// <summary>A sliding minute per caller address, so a burst at the turn of a minute gets no more.</summary>
    private sealed class PerAddressLimit : IRateLimiterPolicy<string>
    {
        private static readonly SlidingWindowRateLimiterOptions _window = new()
        {
            PermitLimit = RequestsPerMinute,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 6,
            QueueLimit = 0,
            AutoReplenishment = true,
        };

        public Func<OnRejectedContext, CancellationToken, ValueTask>? OnRejected { get; } = (context, _) =>
        {
            var http = context.HttpContext;
            KeepBodyAsWritten(http);
            http.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            http.Response.Headers.CacheControl = "no-store";
            if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            {
                http.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
            }

            return ValueTask.CompletedTask;
        };

        public RateLimitPartition<string> GetPartition(HttpContext httpContext) =>
            RateLimitPartition.GetSlidingWindowLimiter(httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => _window);
    }
}
