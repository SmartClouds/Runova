using System.Buffers.Text;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;

namespace Runova.Website.Api.Notifications;

/// <summary>
/// The push services' credentials, from <c>Push:Fcm:*</c> and <c>Push:Apns:*</c>. Until they are set
/// a sender stays off and says so once in the log; nothing else changes.
/// </summary>
internal sealed class PushOptions
{
    public const string Section = "Push";

    public FcmOptions Fcm { get; set; } = new();

    public ApnsOptions Apns { get; set; } = new();
}

/// <summary>A Firebase service account: <c>project_id</c>, <c>client_email</c> and <c>private_key</c>.</summary>
internal sealed class FcmOptions
{
    public string? ProjectId { get; set; }

    public string? ClientEmail { get; set; }

    /// <summary>The PEM private key. A <c>\n</c> in an environment variable is read as a line break.</summary>
    public string? PrivateKey { get; set; }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ProjectId) && !string.IsNullOrWhiteSpace(ClientEmail) && !string.IsNullOrWhiteSpace(PrivateKey);
}

/// <summary>An APNs auth key (a <c>.p8</c> file), its key id and team id.</summary>
internal sealed class ApnsOptions
{
    public string? KeyId { get; set; }

    public string? TeamId { get; set; }

    /// <summary>The PEM private key. A <c>\n</c> in an environment variable is read as a line break.</summary>
    public string? PrivateKey { get; set; }

    public string BundleId { get; set; } = "com.runovahq.app";

    /// <summary>The sandbox endpoint, for development builds of the app.</summary>
    public bool Sandbox { get; set; }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(KeyId) && !string.IsNullOrWhiteSpace(TeamId) && !string.IsNullOrWhiteSpace(PrivateKey);
}

/// <summary>Shared pieces of signing a push service's token.</summary>
internal static class PushCredentials
{
    public static string Pem(string value) => value.Replace("\\n", "\n", StringComparison.Ordinal);

    public static string Encode(string text) => Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));

    public static string Encode(byte[] bytes) => Base64Url.EncodeToString(bytes);
}

/// <summary>
/// Firebase Cloud Messaging for Android, over its HTTP v1 API. The access token is one the service
/// account signs and trades at Google's token endpoint, reused until shortly before it expires.
/// </summary>
internal sealed partial class FcmPushSender(
    IHttpClientFactory http,
    IOptions<PushOptions> options,
    TimeProvider time,
    ILogger<FcmPushSender> logger) : IPushSender, IDisposable
{
    public const string HttpClientName = "push-fcm";
    private const string TokenUri = "https://oauth2.googleapis.com/token";
    private const string Scope = "https://www.googleapis.com/auth/firebase.messaging";

    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _expiresAt;
    private int _disabled;

    public string Platform => PushPlatforms.Android;

    public void Dispose() => _tokenLock.Dispose();

    public async Task<PushSendResult> SendAsync(PushDelivery delivery, CancellationToken cancellationToken)
    {
        var fcm = options.Value.Fcm;
        if (!fcm.IsConfigured)
        {
            return Disabled();
        }

        string token;
        try
        {
            token = await AccessTokenAsync(fcm, cancellationToken);
        }
        catch (Exception e) when (e is CryptographicException or ArgumentException)
        {
            // The key could not be read: the same as having none, and it stays that way until it is fixed.
            return Disabled();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            LogTokenFailed(logger, e.GetType().Name);
            return PushSendResult.Failed;
        }

        var client = http.CreateClient(HttpClientName);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"https://fcm.googleapis.com/v1/projects/{fcm.ProjectId}/messages:send")
        {
            Content = new StringContent(Body(delivery).ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            using var response = await client.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                _accessToken = null;
            }

            return ToResult(response.StatusCode);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            LogSendFailed(logger, e.GetType().Name);
            return PushSendResult.Failed;
        }
    }

    /// <summary>
    /// The whole body FCM receives: the one line and identifiers, nothing else. With a sealed copy
    /// it is data only, so the app's own service runs and can open it; <c>fallback</c> is the line it
    /// shows if it can not.
    /// </summary>
    internal static JsonObject Body(PushDelivery delivery)
    {
        var data = new JsonObject
        {
            ["category"] = delivery.Category,
            ["notificationId"] = delivery.NotificationId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        if (delivery.ItemId is not null)
        {
            data["itemId"] = delivery.ItemId;
        }

        var message = new JsonObject { ["token"] = delivery.Token };
        if (delivery.Sealed is null)
        {
            message["notification"] = new JsonObject { ["title"] = PushContent.Title, ["body"] = delivery.Line };
        }
        else
        {
            data["sealed"] = delivery.Sealed;
            data["fallback"] = delivery.Line;
        }

        message["data"] = data;
        message["android"] = new JsonObject { ["priority"] = "high" };
        return new JsonObject { ["message"] = message };
    }

    internal static PushSendResult ToResult(HttpStatusCode status) => status switch
    {
        HttpStatusCode.OK => PushSendResult.Sent,
        HttpStatusCode.NotFound => PushSendResult.Unregistered,
        _ => PushSendResult.Failed,
    };

    private async Task<string> AccessTokenAsync(FcmOptions fcm, CancellationToken cancellationToken)
    {
        await _tokenLock.WaitAsync(cancellationToken);
        try
        {
            var now = time.GetUtcNow();
            if (_accessToken is not null && now < _expiresAt)
            {
                return _accessToken;
            }

            var client = http.CreateClient(HttpClientName);
            using var response = await client.PostAsync(TokenUri, new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
                ["assertion"] = SignedAssertion(fcm, now),
            }), cancellationToken);
            response.EnsureSuccessStatusCode();
            var reply = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken))!;
            _accessToken = reply["access_token"]!.GetValue<string>();
            _expiresAt = now.AddSeconds(reply["expires_in"]!.GetValue<int>()).AddMinutes(-5);
            return _accessToken;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    internal static string SignedAssertion(FcmOptions fcm, DateTimeOffset now)
    {
        var header = PushCredentials.Encode("""{"alg":"RS256","typ":"JWT"}""");
        var payload = PushCredentials.Encode(new JsonObject
        {
            ["iss"] = fcm.ClientEmail,
            ["scope"] = Scope,
            ["aud"] = TokenUri,
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.ToUnixTimeSeconds() + 3600,
        }.ToJsonString());
        using var key = RSA.Create();
        key.ImportFromPem(PushCredentials.Pem(fcm.PrivateKey!));
        var signature = key.SignData(Encoding.ASCII.GetBytes($"{header}.{payload}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{payload}.{PushCredentials.Encode(signature)}";
    }

    private PushSendResult Disabled()
    {
        if (Interlocked.Exchange(ref _disabled, 1) == 0)
        {
            LogDisabled(logger);
        }

        return PushSendResult.Disabled;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "FCM push is off: Push:Fcm:ProjectId, ClientEmail and PrivateKey are not all set, or the key can not be read")]
    private static partial void LogDisabled(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "FCM did not give an access token ({Reason})")]
    private static partial void LogTokenFailed(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "An FCM send failed ({Reason})")]
    private static partial void LogSendFailed(ILogger logger, string reason);
}

/// <summary>
/// Apple Push Notification service for iOS. Every request carries a token signed with the auth
/// key (ES256), renewed every 50 minutes as Apple asks for it to be, over HTTP/2.
/// </summary>
internal sealed partial class ApnsPushSender(
    IHttpClientFactory http,
    IOptions<PushOptions> options,
    TimeProvider time,
    ILogger<ApnsPushSender> logger) : IPushSender
{
    public const string HttpClientName = "push-apns";
    private const string ProductionHost = "https://api.push.apple.com";
    private const string SandboxHost = "https://api.sandbox.push.apple.com";
    private static readonly TimeSpan _renewEvery = TimeSpan.FromMinutes(50);

    private readonly object _jwtLock = new();
    private string? _jwt;
    private DateTimeOffset _jwtAt;
    private int _disabled;

    public string Platform => PushPlatforms.Ios;

    public async Task<PushSendResult> SendAsync(PushDelivery delivery, CancellationToken cancellationToken)
    {
        var apns = options.Value.Apns;
        if (!apns.IsConfigured)
        {
            return Disabled();
        }

        string jwt;
        try
        {
            jwt = Jwt(apns);
        }
        catch (Exception e) when (e is CryptographicException or ArgumentException)
        {
            return Disabled();
        }

        var host = apns.Sandbox ? SandboxHost : ProductionHost;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{host}/3/device/{delivery.Token}")
        {
            Version = HttpVersion.Version20,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact,
            Content = new StringContent(Body(delivery).ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("bearer", jwt);
        request.Headers.TryAddWithoutValidation("apns-topic", apns.BundleId);
        request.Headers.TryAddWithoutValidation("apns-push-type", "alert");
        request.Headers.TryAddWithoutValidation("apns-priority", "10");
        try
        {
            using var response = await http.CreateClient(HttpClientName).SendAsync(request, cancellationToken);
            var reason = response.StatusCode == HttpStatusCode.OK
                ? null
                : JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken))?["reason"]?.GetValue<string>();
            if (response.StatusCode == HttpStatusCode.Forbidden)
            {
                lock (_jwtLock)
                {
                    _jwt = null;
                }
            }

            return ToResult(response.StatusCode, reason);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            LogSendFailed(logger, e.GetType().Name);
            return PushSendResult.Failed;
        }
    }

    /// <summary>
    /// The whole body APNs receives: the one line and identifiers, nothing else. A sealed copy rides
    /// beside the generic alert, and <c>mutable-content</c> wakes the app's extension to open it.
    /// </summary>
    internal static JsonObject Body(PushDelivery delivery)
    {
        var body = new JsonObject
        {
            ["aps"] = new JsonObject
            {
                ["alert"] = new JsonObject { ["title"] = PushContent.Title, ["body"] = delivery.Line },
                ["sound"] = "default",
                ["thread-id"] = delivery.Category,
            },
            ["category"] = delivery.Category,
            ["notificationId"] = delivery.NotificationId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        };
        if (delivery.ItemId is not null)
        {
            body["itemId"] = delivery.ItemId;
        }

        if (delivery.Sealed is not null)
        {
            body["aps"]!["mutable-content"] = 1;
            body["sealed"] = delivery.Sealed;
        }

        return body;
    }

    internal static PushSendResult ToResult(HttpStatusCode status, string? reason) => status switch
    {
        HttpStatusCode.OK => PushSendResult.Sent,
        HttpStatusCode.Gone => PushSendResult.Unregistered,
        HttpStatusCode.BadRequest when reason == "BadDeviceToken" => PushSendResult.Unregistered,
        _ => PushSendResult.Failed,
    };

    internal string Jwt(ApnsOptions apns)
    {
        var now = time.GetUtcNow();
        lock (_jwtLock)
        {
            if (_jwt is not null && now - _jwtAt < _renewEvery)
            {
                return _jwt;
            }

            var header = PushCredentials.Encode(new JsonObject { ["alg"] = "ES256", ["kid"] = apns.KeyId }.ToJsonString());
            var claims = PushCredentials.Encode(new JsonObject { ["iss"] = apns.TeamId, ["iat"] = now.ToUnixTimeSeconds() }.ToJsonString());
            using var key = ECDsa.Create();
            key.ImportFromPem(PushCredentials.Pem(apns.PrivateKey!));
            var signature = key.SignData(Encoding.ASCII.GetBytes($"{header}.{claims}"), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
            _jwt = $"{header}.{claims}.{PushCredentials.Encode(signature)}";
            _jwtAt = now;
            return _jwt;
        }
    }

    private PushSendResult Disabled()
    {
        if (Interlocked.Exchange(ref _disabled, 1) == 0)
        {
            LogDisabled(logger);
        }

        return PushSendResult.Disabled;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "APNs push is off: Push:Apns:KeyId, TeamId and PrivateKey are not all set, or the key can not be read")]
    private static partial void LogDisabled(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "An APNs send failed ({Reason})")]
    private static partial void LogSendFailed(ILogger logger, string reason);
}
