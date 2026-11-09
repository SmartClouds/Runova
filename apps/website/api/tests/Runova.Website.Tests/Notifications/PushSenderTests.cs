using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Notifications;

namespace Runova.Website.Tests.Notifications;

/// <summary>
/// The real FCM and APNs senders against a stand-in HTTP layer. They have never spoken to Google
/// or Apple: these show the bytes they would send and how they read an answer, nothing more.
/// </summary>
public class PushSenderTests
{
    private static readonly PushDelivery _delivery = new(1, PushPlatforms.Android, "device-token", "Claude Code finished in Shop", NotificationCategories.AgentFinished, 42, "proj-1");

    [Fact]
    public void The_fcm_body_is_the_line_and_identifiers_only()
    {
        var body = FcmPushSender.Body(_delivery);

        var message = body["message"]!;
        Assert.Equal("device-token", message["token"]!.GetValue<string>());
        Assert.Equal(PushContent.Title, message["notification"]!["title"]!.GetValue<string>());
        Assert.Equal(_delivery.Line, message["notification"]!["body"]!.GetValue<string>());
        Assert.Equal("42", message["data"]!["notificationId"]!.GetValue<string>());
        Assert.Equal(_delivery.Category, message["data"]!["category"]!.GetValue<string>());
        Assert.Equal("proj-1", message["data"]!["itemId"]!.GetValue<string>());
        Assert.Equal(["android", "data", "notification", "token"], message.AsObject().Select(p => p.Key).Order().ToArray());
    }

    [Fact]
    public void The_apns_body_is_the_line_and_identifiers_only()
    {
        var body = ApnsPushSender.Body(_delivery with { Platform = PushPlatforms.Ios });

        Assert.Equal(_delivery.Line, body["aps"]!["alert"]!["body"]!.GetValue<string>());
        Assert.Equal(PushContent.Title, body["aps"]!["alert"]!["title"]!.GetValue<string>());
        Assert.Equal("42", body["notificationId"]!.GetValue<string>());
        Assert.Equal(_delivery.Category, body["category"]!.GetValue<string>());
        Assert.Equal(["aps", "category", "itemId", "notificationId"], body.AsObject().Select(p => p.Key).Order().ToArray());
    }

    [Fact]
    public void A_sealed_fcm_body_is_data_only_with_the_generic_line_as_its_fallback()
    {
        var message = FcmPushSender.Body(_delivery with { Line = PushContent.SealedLine, Sealed = "c2VhbGVk" })["message"]!;

        Assert.Equal(["android", "data", "token"], message.AsObject().Select(p => p.Key).Order().ToArray());
        Assert.Equal("high", message["android"]!["priority"]!.GetValue<string>());
        var data = message["data"]!.AsObject();
        Assert.Equal(["category", "fallback", "itemId", "notificationId", "sealed"], data.Select(p => p.Key).Order().ToArray());
        Assert.Equal("c2VhbGVk", data["sealed"]!.GetValue<string>());
        Assert.Equal(PushContent.SealedLine, data["fallback"]!.GetValue<string>());
    }

    [Fact]
    public void A_sealed_apns_body_keeps_the_generic_alert_and_asks_the_app_to_open_it()
    {
        var body = ApnsPushSender.Body(_delivery with { Platform = PushPlatforms.Ios, Line = PushContent.SealedLine, Sealed = "c2VhbGVk" });

        Assert.Equal(PushContent.SealedLine, body["aps"]!["alert"]!["body"]!.GetValue<string>());
        Assert.Equal(1, body["aps"]!["mutable-content"]!.GetValue<int>());
        Assert.Equal("c2VhbGVk", body["sealed"]!.GetValue<string>());
    }

    [Fact]
    public void A_generic_line_with_no_copy_goes_as_a_normal_notification()
    {
        var delivery = _delivery with { Line = PushContent.SealedLine };

        Assert.Equal(PushContent.SealedLine, FcmPushSender.Body(delivery)["message"]!["notification"]!["body"]!.GetValue<string>());
        Assert.Null(ApnsPushSender.Body(delivery)["aps"]!["mutable-content"]);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "Sent")]
    [InlineData(HttpStatusCode.NotFound, "Unregistered")]
    [InlineData(HttpStatusCode.BadRequest, "Failed")]
    [InlineData(HttpStatusCode.InternalServerError, "Failed")]
    public void An_fcm_answer_is_read(HttpStatusCode status, string expected) =>
        Assert.Equal(expected, FcmPushSender.ToResult(status).ToString());

    [Theory]
    [InlineData(HttpStatusCode.OK, null, "Sent")]
    [InlineData(HttpStatusCode.Gone, "Unregistered", "Unregistered")]
    [InlineData(HttpStatusCode.BadRequest, "BadDeviceToken", "Unregistered")]
    [InlineData(HttpStatusCode.BadRequest, "BadTopic", "Failed")]
    public void An_apns_answer_is_read(HttpStatusCode status, string? reason, string expected) =>
        Assert.Equal(expected, ApnsPushSender.ToResult(status, reason).ToString());

    [Fact]
    public void An_fcm_assertion_is_signed_with_the_service_account()
    {
        using var rsa = RSA.Create(2048);
        var fcm = new FcmOptions { ClientEmail = "svc@example.iam", ProjectId = "p", PrivateKey = rsa.ExportPkcs8PrivateKeyPem() };

        var parts = FcmPushSender.SignedAssertion(fcm, new DateTimeOffset(2026, 11, 9, 8, 0, 0, TimeSpan.Zero)).Split('.');

        Assert.True(rsa.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), Convert.FromBase64String(ToBase64(parts[2])), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
        var claims = JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(ToBase64(parts[1]))))!;
        Assert.Equal("svc@example.iam", claims["iss"]!.GetValue<string>());
    }

    [Fact]
    public void An_apns_token_is_signed_with_the_auth_key()
    {
        using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var apns = new ApnsOptions { KeyId = "KEY123", TeamId = "TEAM456", PrivateKey = ec.ExportPkcs8PrivateKeyPem().Replace("\n", "\\n", StringComparison.Ordinal) };
        var sender = new ApnsPushSender(new StubFactory(), Options.Create(new PushOptions { Apns = apns }), TimeProvider.System, new CapturingLogger<ApnsPushSender>());

        var parts = sender.Jwt(apns).Split('.');

        Assert.True(ec.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), Convert.FromBase64String(ToBase64(parts[2])), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
    }

    [Fact]
    public async Task With_no_credentials_fcm_is_off_and_says_so_once()
    {
        var logger = new CapturingLogger<FcmPushSender>();
        var http = new StubFactory();
        var sender = new FcmPushSender(http, Options.Create(new PushOptions()), TimeProvider.System, logger);

        Assert.Equal(PushSendResult.Disabled, await sender.SendAsync(_delivery, TestContext.Current.CancellationToken));
        Assert.Equal(PushSendResult.Disabled, await sender.SendAsync(_delivery, TestContext.Current.CancellationToken));

        Assert.Single(logger.Entries);
        Assert.Empty(http.Requests);
    }

    [Fact]
    public async Task With_no_credentials_apns_is_off_and_says_so_once()
    {
        var logger = new CapturingLogger<ApnsPushSender>();
        var http = new StubFactory();
        var sender = new ApnsPushSender(http, Options.Create(new PushOptions()), TimeProvider.System, logger);

        Assert.Equal(PushSendResult.Disabled, await sender.SendAsync(_delivery, TestContext.Current.CancellationToken));
        Assert.Equal(PushSendResult.Disabled, await sender.SendAsync(_delivery, TestContext.Current.CancellationToken));

        Assert.Single(logger.Entries);
        Assert.Empty(http.Requests);
    }

    [Fact]
    public async Task A_key_that_can_not_be_read_turns_a_sender_off_without_throwing()
    {
        var logger = new CapturingLogger<ApnsPushSender>();
        var options = new PushOptions { Apns = new ApnsOptions { KeyId = "K", TeamId = "T", PrivateKey = "not a key" } };
        var sender = new ApnsPushSender(new StubFactory(), Options.Create(options), TimeProvider.System, logger);

        Assert.Equal(PushSendResult.Disabled, await sender.SendAsync(_delivery with { Platform = PushPlatforms.Ios }, TestContext.Current.CancellationToken));
        Assert.Single(logger.Entries);
    }

    [Fact]
    public async Task A_configured_apns_sender_posts_to_the_device_and_keeps_the_token_out_of_the_log()
    {
        using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var options = new PushOptions { Apns = new ApnsOptions { KeyId = "K", TeamId = "T", PrivateKey = ec.ExportPkcs8PrivateKeyPem(), Sandbox = true } };
        var http = new StubFactory(HttpStatusCode.OK, "{}");
        var logger = new CapturingLogger<ApnsPushSender>();
        var sender = new ApnsPushSender(http, Options.Create(options), TimeProvider.System, logger);

        var result = await sender.SendAsync(_delivery with { Platform = PushPlatforms.Ios, Token = "abcdef" }, TestContext.Current.CancellationToken);

        Assert.Equal(PushSendResult.Sent, result);
        var request = Assert.Single(http.Requests);
        Assert.Equal("https://api.sandbox.push.apple.com/3/device/abcdef", request.RequestUri!.ToString());
        Assert.Equal("com.runovahq.app", request.Headers.GetValues("apns-topic").Single());
        Assert.Equal("alert", request.Headers.GetValues("apns-push-type").Single());
        Assert.DoesNotContain(logger.Entries, entry => entry.Contains("abcdef", StringComparison.Ordinal));
    }

    private static string ToBase64(string base64Url)
    {
        var text = base64Url.Replace('-', '+').Replace('_', '/');
        return text.PadRight(text.Length + ((4 - (text.Length % 4)) % 4), '=');
    }

    private sealed class StubFactory(HttpStatusCode status = HttpStatusCode.OK, string body = "{}") : IHttpClientFactory
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        public HttpClient CreateClient(string name) => new(new Handler(this, status, body));

        private sealed class Handler(StubFactory owner, HttpStatusCode status, string body) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                owner.Requests.Add(request);
                return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
            }
        }
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Entries.Add(formatter(state, exception));
    }
}
