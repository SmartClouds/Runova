using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace Runova.Website.Api.Http;

/// <summary>
/// Behind the reverse proxy the API is reached over plain HTTP from the proxy's address. It takes
/// the caller's address and scheme from <c>X-Forwarded-For</c> and <c>X-Forwarded-Proto</c>, so IP
/// allowlists, rate limits and the Secure cookies see the real request, but only from the networks
/// in <c>Website:KnownProxies</c> (CIDR ranges or addresses, separated by commas) and loopback.
/// </summary>
internal static class ForwardedHeadersSetup
{
    public static IServiceCollection AddWebsiteForwardedHeaders(this IServiceCollection services)
    {
        services.AddOptions<ForwardedHeadersOptions>().Configure<IConfiguration>((options, configuration) =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            var entries = (configuration["Website:KnownProxies"] ?? "")
                .Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var entry in entries)
            {
                if (entry.Contains('/', StringComparison.Ordinal) && System.Net.IPNetwork.TryParse(entry, out var network))
                {
                    options.KnownIPNetworks.Add(network);
                }
                else if (IPAddress.TryParse(entry, out var address))
                {
                    options.KnownProxies.Add(address);
                }
                else
                {
                    throw new InvalidOperationException($"Website:KnownProxies has \"{entry}\", which is not an address or a CIDR range.");
                }
            }
        });
        return services;
    }
}
