using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.CoreDomain;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.CoreDomainTests;

/// <summary>
/// The core domain's loopback port on a real Kestrel, standing in for nginx: nothing listens until
/// the mode is on, a request needs nginx's key and the certificate of an enrolled, unrevoked
/// device, the request is then tied to that device like one over direct TLS, and the same headers
/// carry no weight on the core's own listener. Behind Cloudflare the certificate gives way to a
/// header signed with the device key, good for one request on one path, once.
/// </summary>
public sealed class CoreDomainListenerTests : IAsyncLifetime
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-domain-{Guid.NewGuid():N}");
    private readonly int _basePort = DirectTlsClient.FreePort();
    private readonly int _proxyPort = DirectTlsClient.FreePort();
    private readonly string _key = CoreDomainSettings.NewKey();
    private readonly ECDsa _deviceKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private WebApplication? _app;
    private Guid _deviceId;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private WebApplication App => _app!;

    public async ValueTask InitializeAsync()
    {
        _app = CoreApplication.Build(
        [
            $"--Core:Listen:TcpPort={_basePort}",
            $"--Core:DataDirectory={_directory}",
            "--environment",
            "Testing",
        ]);
        await _app.StartAsync(Cancel);
        _deviceId = await AddDeviceAsync(_deviceKey);
    }

    public async ValueTask DisposeAsync()
    {
        if (_app is not null)
        {
            await _app.DisposeAsync();
        }

        _deviceKey.Dispose();
        TestFolders.Delete(_directory);
    }

    [Fact]
    public async Task Nothing_listens_until_the_mode_is_on_and_nothing_after_it_is_off()
    {
        Assert.False(DirectTlsClient.Accepts(_proxyPort));

        await OpenAsync();
        Assert.True(DirectTlsClient.Accepts(_proxyPort));

        App.Services.GetRequiredService<CoreDomainEndpoint>().Close();
        await WaitAsync(() => !DirectTlsClient.Accepts(_proxyPort));

        Assert.False(DirectTlsClient.Accepts(_proxyPort));
        Assert.True(DirectTlsClient.Accepts(_basePort));
    }

    [Fact]
    public async Task An_enrolled_device_behind_nginx_reaches_the_core()
    {
        await OpenAsync();
        using var client = Proxied(_deviceKey);

        var response = await client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Without_the_key_or_a_known_certificate_nothing_gets_past_the_guard()
    {
        await OpenAsync();
        using var stranger = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        using var noKey = Proxied(_deviceKey, key: null);
        using var wrongKey = Proxied(_deviceKey, key: CoreDomainSettings.NewKey());
        using var noCertificate = Proxied(device: null);
        using var unknown = Proxied(stranger);
        using var garbage = Proxied(device: null);
        garbage.DefaultRequestHeaders.Add(CoreDomainSettings.CertificateHeader, "-----BEGIN%20CERTIFICATE-----%0Anot-base64%0A-----END%20CERTIFICATE-----");

        foreach (var client in new[] { noKey, wrongKey, noCertificate, unknown, garbage })
        {
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel)).StatusCode);
        }
    }

    [Fact]
    public async Task A_revoked_device_and_a_mode_turned_off_are_refused_at_once()
    {
        await OpenAsync();
        using var client = Proxied(_deviceKey);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel)).StatusCode);

        await RevokeAsync(_deviceId);
        var revoked = await client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel);

        var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        await AddDeviceAsync(other);
        using var otherClient = Proxied(other);
        var store = App.Services.GetRequiredService<CoreDomainStore>();
        store.Write(store.Read() with { Enabled = false });
        var off = await otherClient.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel);
        other.Dispose();

        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, off.StatusCode);
    }

    [Fact]
    public async Task The_request_is_tied_to_the_certificates_device_and_enrolling_is_refused()
    {
        await OpenAsync();
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherDevice = await AddDeviceAsync(otherKey);
        using var client = Proxied(_deviceKey);

        var own = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(_deviceId, AuthPurpose.Login), CoreJson.Options, Cancel);
        var theirs = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(otherDevice, AuthPurpose.Login), CoreJson.Options, Cancel);
        var enroll = await client.PostAsJsonAsync("/api/v1/auth/enroll", new { code = "x", userName = "maria", password = "y", publicKey = "z", deviceName = "n" }, CoreJson.Options, Cancel);

        Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, theirs.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, enroll.StatusCode);
    }

    [Fact]
    public async Task The_same_headers_carry_no_weight_on_the_cores_own_listener()
    {
        await OpenAsync();
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherDevice = await AddDeviceAsync(otherKey);
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_basePort}") };
        client.DefaultRequestHeaders.Host = "runova-core";
        client.DefaultRequestHeaders.Add(CoreDomainSettings.KeyHeader, _key);
        client.DefaultRequestHeaders.Add(CoreDomainSettings.CertificateHeader, EscapedPem(_deviceKey));

        // Over the core's own listener (SSH in production) no certificate binds the request, so a
        // challenge for any device goes through, whatever the headers claim.
        var theirs = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(otherDevice, AuthPurpose.Login), CoreJson.Options, Cancel);

        Assert.Equal(HttpStatusCode.OK, theirs.StatusCode);
    }

    [Fact]
    public async Task Through_cloudflare_a_signed_request_reaches_the_core_tied_to_its_device()
    {
        await OpenAsync(CoreDomainMode.Cloudflare);
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherDevice = await AddDeviceAsync(otherKey);
        using var client = Proxied(device: null);

        var health = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health"), Cancel);
        var own = await client.SendAsync(Signed(HttpMethod.Post, "/api/v1/auth/challenge", body: new ChallengeRequest(_deviceId, AuthPurpose.Login)), Cancel);
        var theirs = await client.SendAsync(Signed(HttpMethod.Post, "/api/v1/auth/challenge", body: new ChallengeRequest(otherDevice, AuthPurpose.Login)), Cancel);

        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        Assert.Equal(HttpStatusCode.OK, own.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, theirs.StatusCode);
    }

    [Fact]
    public async Task Through_cloudflare_a_proof_is_checked_against_the_request_and_spent_once()
    {
        await OpenAsync(CoreDomainMode.Cloudflare);
        using var stranger = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var client = Proxied(device: null);
        using var noKey = Proxied(device: null, key: null);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var refused = new Dictionary<string, HttpRequestMessage>
        {
            ["no proof"] = new(HttpMethod.Get, "/api/v1/health"),
            ["garbage"] = WithProof(new(HttpMethod.Get, "/api/v1/health"), "v1.not-a-proof"),
            ["another key"] = Signed(HttpMethod.Get, "/api/v1/health", key: stranger),
            ["unknown device"] = Signed(HttpMethod.Get, "/api/v1/health", key: stranger, device: Guid.NewGuid()),
            ["another path"] = WithProof(new(HttpMethod.Get, "/api/v1/health"), Proof(_deviceKey, _deviceId, "GET", "/api/v1/other", "core.example.com", now)),
            ["another method"] = WithProof(new(HttpMethod.Get, "/api/v1/health"), Proof(_deviceKey, _deviceId, "POST", "/api/v1/health", "core.example.com", now)),
            ["another domain"] = WithProof(new(HttpMethod.Get, "/api/v1/health"), Proof(_deviceKey, _deviceId, "GET", "/api/v1/health", "other.example.com", now)),
            ["the certificate instead"] = WithCertificate(new(HttpMethod.Get, "/api/v1/health"), EscapedPem(_deviceKey)),
        };
        foreach (var (name, request) in refused)
        {
            using (request)
            {
                Assert.True(HttpStatusCode.Forbidden == (await client.SendAsync(request, Cancel)).StatusCode, name);
            }
        }

        Assert.Equal(HttpStatusCode.Forbidden, (await noKey.SendAsync(Signed(HttpMethod.Get, "/api/v1/health"), Cancel)).StatusCode);

        var proof = Proof(_deviceKey, _deviceId, "GET", "/api/v1/health", "core.example.com", now);
        var first = await client.SendAsync(WithProof(new(HttpMethod.Get, "/api/v1/health"), proof), Cancel);
        var replayed = await client.SendAsync(WithProof(new(HttpMethod.Get, "/api/v1/health"), proof), Cancel);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, replayed.StatusCode);
        Assert.Equal("deviceProofInvalid", (await replayed.Content.ReadFromJsonAsync<ProofRefusal>(Cancel))!.Code);
    }

    [Fact]
    public async Task Through_cloudflare_a_clock_far_off_is_named_as_such()
    {
        await OpenAsync(CoreDomainMode.Cloudflare);
        using var client = Proxied(device: null);
        var now = DateTimeOffset.UtcNow;

        var stale = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health", at: now.AddMinutes(-10)), Cancel);
        var ahead = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health", at: now.AddMinutes(10)), Cancel);
        var close = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health", at: now.AddMinutes(-2)), Cancel);

        Assert.Equal(HttpStatusCode.Forbidden, stale.StatusCode);
        Assert.Equal("deviceProofClockSkew", (await stale.Content.ReadFromJsonAsync<ProofRefusal>(Cancel))!.Code);
        Assert.Equal("deviceProofClockSkew", Assert.Single(stale.Headers.GetValues(CoreDomainSettings.RefusalHeader)));
        Assert.Equal(HttpStatusCode.Forbidden, ahead.StatusCode);
        Assert.Equal(HttpStatusCode.OK, close.StatusCode);
    }

    [Fact]
    public async Task Through_cloudflare_the_path_is_compared_however_it_was_percent_encoded()
    {
        await OpenAsync(CoreDomainMode.Cloudflare);
        using var client = Proxied(device: null);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // Cloudflare may change how a URL is encoded on the way through; both sides compare it decoded.
        using var request = WithProof(new(HttpMethod.Get, "/api/v1/%68ealth?note=a%20b"), Proof(_deviceKey, _deviceId, "GET", "/api/v1/health?note=a b", "core.example.com", now));

        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(request, Cancel)).StatusCode);
    }

    [Fact]
    public async Task A_revoked_device_is_refused_through_cloudflare_and_a_proof_means_nothing_straight_to_the_server()
    {
        await OpenAsync(CoreDomainMode.Cloudflare);
        using var client = Proxied(device: null);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health"), Cancel)).StatusCode);

        await RevokeAsync(_deviceId);
        var revoked = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health"), Cancel);

        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherDevice = await AddDeviceAsync(other);
        await OpenAsync(CoreDomainMode.Direct);
        var direct = await client.SendAsync(Signed(HttpMethod.Get, "/api/v1/health", key: other, device: otherDevice), Cancel);

        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, direct.StatusCode);
    }

    private async Task OpenAsync(CoreDomainMode mode = CoreDomainMode.Direct)
    {
        App.Services.GetRequiredService<CoreDomainStore>().Write(new CoreDomainSettings(true, "core.example.com", _proxyPort, _key, [], Mode: mode));
        App.Services.GetRequiredService<CoreDomainEndpoint>().Open(_proxyPort);
        await WaitAsync(() => App.Services.GetRequiredService<ICoreDomainBinding>().IsListening(_proxyPort));
    }

    /// <summary>A client as nginx would forward it: Host set to the core's name, the key, and the escaped PEM.</summary>
    private HttpClient Proxied(ECDsa? device, string? key = "")
    {
        var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_proxyPort}") };
        client.DefaultRequestHeaders.Host = "runova-core";
        var sent = key == string.Empty ? _key : key;
        if (sent is not null)
        {
            client.DefaultRequestHeaders.Add(CoreDomainSettings.KeyHeader, sent);
        }

        if (device is not null)
        {
            client.DefaultRequestHeaders.Add(CoreDomainSettings.CertificateHeader, EscapedPem(device));
        }

        return client;
    }

    /// <summary>A request with a fresh proof, as the app signs it in Cloudflare mode.</summary>
    private HttpRequestMessage Signed(HttpMethod method, string path, ECDsa? key = null, Guid? device = null, DateTimeOffset? at = null, object? body = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: CoreJson.Options);
        }

        var unixMs = (at ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
        return WithProof(request, Proof(key ?? _deviceKey, device ?? _deviceId, method.Method, path, "core.example.com", unixMs));
    }

    private static HttpRequestMessage WithProof(HttpRequestMessage request, string proof)
    {
        request.Headers.Add(CoreDomainSettings.ProofHeader, proof);
        return request;
    }

    private static HttpRequestMessage WithCertificate(HttpRequestMessage request, string escapedPem)
    {
        request.Headers.Add(CoreDomainSettings.CertificateHeader, escapedPem);
        return request;
    }

    private static string Proof(ECDsa key, Guid device, string method, string path, string domain, long unixMs)
    {
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var message = DeviceProof.Message(device, method, path, domain, unixMs, nonce);
        var signature = key.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"v1.{device:D}.{unixMs}.{nonce}.{Convert.ToBase64String(signature)}";
    }

    private sealed record ProofRefusal(string Code, string Message);

    /// <summary>What nginx puts in $ssl_client_escaped_cert: the PEM, URL-escaped.</summary>
    private static string EscapedPem(ECDsa key)
    {
        using var certificate = DirectTlsClient.CertificateFor(key);
        return Uri.EscapeDataString(certificate.ExportCertificatePem());
    }

    private static async Task WaitAsync(Func<bool> done)
    {
        for (var attempt = 0; attempt < 100 && !done(); attempt++)
        {
            await Task.Delay(50, Cancel);
        }

        Assert.True(done());
    }

    private async Task<Guid> AddDeviceAsync(ECDsa key)
    {
        await using var scope = App.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var user = await users.FindByNameAsync("maria");
        if (user is null)
        {
            user = new CoreUser { UserName = "maria" };
            Assert.True((await users.CreateAsync(user, AuthHarness.Password)).Succeeded);
            Assert.True((await users.AddToRoleAsync(user, CoreRoles.Owner)).Succeeded);
        }

        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = new Device { Id = Guid.NewGuid(), UserId = user.Id, Name = "laptop", PublicKey = key.ExportSubjectPublicKeyInfo() };
        db.Devices.Add(device);
        await db.SaveChangesAsync(Cancel);
        return device.Id;
    }

    private async Task RevokeAsync(Guid deviceId)
    {
        await using var scope = App.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = await db.Devices.SingleAsync(d => d.Id == deviceId, Cancel);
        device.RevokedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await db.SaveChangesAsync(Cancel);
    }
}
