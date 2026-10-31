using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Server.Kestrel;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Runova.ServerCore.DirectTls;

namespace Runova.ServerCore.CoreDomain;

/// <summary>
/// The loopback port nginx passes the core domain's requests to. Like the direct TLS listener it
/// is a configuration endpoint that only exists while the mode is on, so turning it on or off
/// rebinds at runtime and leaves the Unix socket alone. It only ever binds 127.0.0.1, takes plain
/// HTTP/1.1 (nginx did the TLS), and marks each connection so the guard knows where it came from.
/// </summary>
internal sealed class CoreDomainEndpoint : ConfigurationProvider, IConfigurationSource
{
    public const string Name = "RunovaCoreDomain";

    private const string Prefix = $"Kestrel:Endpoints:{Name}";

    private const string ConnectionItem = "runova:core-domain";

    private readonly Lock _gate = new();

    public IConfigurationProvider Build(IConfigurationBuilder builder) => this;

    /// <summary>Binds the loopback port, or moves it.</summary>
    public void Open(int port)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(port, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(port, 65535);
        lock (_gate)
        {
            var url = string.Create(CultureInfo.InvariantCulture, $"http://127.0.0.1:{port}");
            if (Data.TryGetValue($"{Prefix}:Url", out var current) && current == url)
            {
                return;
            }

            // A new dictionary rather than edits, so Kestrel never reads one half changed.
            Data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                [$"{Prefix}:Url"] = url,
                [$"{Prefix}:Protocols"] = nameof(HttpProtocols.Http1),
            };
        }

        OnReload();
    }

    public void Close()
    {
        lock (_gate)
        {
            if (Data.Count == 0)
            {
                return;
            }

            Data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        }

        OnReload();
    }

    /// <summary>Called by Kestrel each time it binds the endpoint.</summary>
    public static void Configure(EndpointConfiguration endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        endpoint.ListenOptions.Use(next => connection =>
        {
            // Bound to loopback, but checked anyway: nothing off this machine is ever served here.
            if (connection.RemoteEndPoint is IPEndPoint { Address: var remote } && !IPAddress.IsLoopback(remote))
            {
                connection.Abort();
                return Task.CompletedTask;
            }

            connection.Items[ConnectionItem] = true;
            return next(connection);
        });
    }

    /// <summary>Whether the request came in on this port, that is, from nginx.</summary>
    public static bool IsProxied(HttpContext? context) =>
        context?.Features.Get<IConnectionItemsFeature>()?.Items.TryGetValue(ConnectionItem, out var value) == true && value is true;
}

/// <summary>
/// Every request on the core domain's port has to carry the key (so it came through nginx) and the
/// client certificate nginx saw in the TLS handshake, whose key has to belong to an enrolled device
/// that is not revoked. nginx asked for that certificate and the handshake proved the caller holds
/// its private key; nginx cannot check it against the devices, so the core does, on every request.
/// The request then goes on exactly as one over direct TLS: tied to that device.
/// </summary>
internal sealed class CoreDomainGuard(RequestDelegate next)
{
    /// <summary>A P-256 certificate the desktop makes is well under 1 KB; escaped PEM roughly doubles it.</summary>
    private const int MaxCertificateHeader = 8 * 1024;

    public async Task InvokeAsync(HttpContext context, CoreDomainStore store, DirectTlsDevices devices)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(devices);
        if (!CoreDomainEndpoint.IsProxied(context))
        {
            await next(context);
            return;
        }

        var settings = store.Read();
        var headers = context.Request.Headers;
        var sent = headers[CoreDomainSettings.KeyHeader].ToString();
        if (!settings.Enabled || settings.Key is not { } key || !SameKey(sent, key)
            || DeviceOf(headers[CoreDomainSettings.CertificateHeader].ToString(), devices) is not Guid device)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        headers.Remove(CoreDomainSettings.KeyHeader);
        headers.Remove(CoreDomainSettings.CertificateHeader);
        DirectTlsDevices.Remember(context, device);
        await next(context);
    }

    private static bool SameKey(string sent, string key) =>
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(sent), Encoding.ASCII.GetBytes(key));

    /// <summary>The enrolled device behind nginx's escaped PEM, or null.</summary>
    internal static Guid? DeviceOf(string escaped, DirectTlsDevices devices)
    {
        if (escaped.Length is 0 or > MaxCertificateHeader)
        {
            return null;
        }

        string pem;
        try
        {
            pem = Uri.UnescapeDataString(escaped);
        }
        catch (UriFormatException)
        {
            return null;
        }

        if (!PemEncoding.TryFind(pem, out var fields) || !pem.AsSpan()[fields.Label].SequenceEqual("CERTIFICATE"))
        {
            return null;
        }

        try
        {
            var der = Convert.FromBase64String(pem[fields.Base64Data]);
            using var certificate = X509CertificateLoader.LoadCertificate(der);
            return devices.Find(certificate);
        }
        catch (Exception error) when (error is FormatException or CryptographicException)
        {
            return null;
        }
    }
}
