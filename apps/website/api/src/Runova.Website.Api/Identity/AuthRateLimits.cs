using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Identity;

/// <summary>The per-address limit on sign-in and the routes that send email, from <c>RateLimits:Auth</c>.</summary>
internal sealed class AuthRateLimitOptions
{
    /// <summary>Requests a minute per address. The contract says 10.</summary>
    public int PermitLimit { get; set; } = 10;

    public TimeSpan Window { get; set; } = TimeSpan.FromMinutes(1);
}

internal static class AuthRateLimits
{
    /// <summary>The name endpoints give <c>RequireRateLimiting</c>.</summary>
    public const string Policy = "auth";

    /// <summary>For a device waiting on an answer. It asks every few seconds, and its code can not be guessed.</summary>
    public const string PollPolicy = "auth-poll";

    private const int PollsPerMinute = 120;

    /// <summary>
    /// A fixed window per caller address (after forwarded headers), shared by every route under the
    /// policy, so a guesser can not spread tries over sign-in, sign-up and resets. A request with no
    /// address (only the in-memory test server sends none) is not limited.
    /// </summary>
    public static IServiceCollection AddAuthRateLimits(this IServiceCollection services)
    {
        services.AddOptions<AuthRateLimitOptions>().BindConfiguration("RateLimits:Auth");
        services.AddOptions<RateLimiterOptions>().Configure<IOptions<AuthRateLimitOptions>>((options, limits) =>
            options.AddPolicy(Policy, http =>
            {
                var address = http.Connection.RemoteIpAddress?.ToString();
                return address is null
                    ? RateLimitPartition.GetNoLimiter("none")
                    : RateLimitPartition.GetFixedWindowLimiter(address, _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = limits.Value.PermitLimit,
                        Window = limits.Value.Window,
                        QueueLimit = 0,
                        AutoReplenishment = true,
                    });
            }));
        services.Configure<RateLimiterOptions>(options =>
            options.AddPolicy(PollPolicy, http =>
            {
                var address = http.Connection.RemoteIpAddress?.ToString();
                return address is null
                    ? RateLimitPartition.GetNoLimiter("none")
                    : RateLimitPartition.GetFixedWindowLimiter(address, _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = PollsPerMinute,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                        AutoReplenishment = true,
                    });
            }));
        return services;
    }
}
