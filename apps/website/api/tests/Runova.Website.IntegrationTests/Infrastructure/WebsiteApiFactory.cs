using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Hangfire;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Mvc.Testing.Handlers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Npgsql;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The API in memory, pointed at a test database. Production unless a test says otherwise; a test
/// may also hand it a fake clock, ask it to migrate the database on start, add settings, or
/// replace services.
/// </summary>
public sealed class WebsiteApiFactory(
    string connectionString,
    string environment = "Production",
    TimeProvider? time = null,
    bool migrateOnStart = false,
    IReadOnlyDictionary<string, string>? settings = null,
    Action<IServiceCollection>? services = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(environment);
        builder.UseSetting("ConnectionStrings:Default", connectionString);
        if (migrateOnStart)
        {
            builder.UseSetting("Database:MigrateOnStart", "true");
        }

        foreach (var (key, value) in settings ?? new Dictionary<string, string>())
        {
            builder.UseSetting(key, value);
        }

        builder.ConfigureTestServices(testServices =>
        {
            // No test needs jobs processed in the background, and a Hangfire server per test host
            // holds enough connections to run the database out of them.
            foreach (var server in testServices.Where(IsJobServer).ToList())
            {
                testServices.Remove(server);
            }

            testServices.AddSingleton<IStartupFilter, RemoteIpFromHeader>();
            if (time is not null)
            {
                testServices.AddSingleton(time);
            }

            services?.Invoke(testServices);
        });
    }

    // Most tests have a database of their own, and so a pool of their own, whose idle connections
    // would stay open for minutes and run the server out of them.
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        using var connection = new NpgsqlConnection(connectionString);
        NpgsqlConnection.ClearPool(connection);
    }

    private static bool IsJobServer(ServiceDescriptor service) =>
        service.ServiceType == typeof(IHostedService)
        && (service.ImplementationType ?? service.ImplementationFactory?.Method.ReturnType) == typeof(BackgroundJobServerHostedService);

    /// <summary>
    /// A client on https, since the session and antiforgery cookies are Secure, that keeps cookies
    /// by the API's clock and never follows a redirect.
    /// </summary>
    internal ApiClient CreateApiClient() =>
        new(time is null
            ? CreateDefaultClient(new Uri("https://localhost"), new CookieContainerHandler())
            : CreateDefaultClient(new Uri("https://localhost"), new CookieContainerHandler(), new CookieExpiryOnRealClock(time)));

    /// <summary>
    /// Moves each cookie's expiry from the API's clock to the real one. The cookie jar only knows
    /// real time, so a session cookie set under a fake clock in the past would be dropped at once.
    /// A cookie the API sends already expired, as a sign-out does, is left as it is.
    /// </summary>
    private sealed class CookieExpiryOnRealClock(TimeProvider time) : DelegatingHandler
    {
        private static readonly Regex _expires = new("expires=([^;]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var response = await base.SendAsync(request, cancellationToken);
            if (response.Headers.TryGetValues("Set-Cookie", out var cookies))
            {
                var now = time.GetUtcNow();
                var shift = DateTimeOffset.UtcNow - now;
                var moved = cookies.Select(cookie => _expires.Replace(cookie, match =>
                {
                    var expires = DateTimeOffset.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
                    return expires <= now ? match.Value : "expires=" + (expires + shift).ToString("R", CultureInfo.InvariantCulture);
                })).ToList();
                response.Headers.Remove("Set-Cookie");
                response.Headers.TryAddWithoutValidation("Set-Cookie", moved);
            }

            return response;
        }
    }

    /// <summary>
    /// The test server sends no caller address, so a test that needs one names it in
    /// <see cref="TestApiClients.RemoteIpHeader"/>, read before anything else in the pipeline.
    /// </summary>
    private sealed class RemoteIpFromHeader : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((http, nextMiddleware) =>
            {
                if (IPAddress.TryParse(http.Request.Headers[TestApiClients.RemoteIpHeader].ToString(), out var address))
                {
                    http.Connection.RemoteIpAddress = address;
                }

                return nextMiddleware(http);
            });
            next(app);
        };
    }
}
