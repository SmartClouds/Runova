using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Email;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The SendGrid transport against a fake api.sendgrid.com. No database needed.</summary>
public sealed class SendGridEmailTransportTests
{
    private const string Key = "SG.test-key-never-shown";
    private readonly FakeSendGrid _sendGrid = new();

    private static readonly OutgoingEmail _email = new(
        "sam@example.test", "VerifyEmail", "Confirm your email", "Open https://runovahq.com/x?token=1", "<p><a href=\"https://runovahq.com/x?token=1\">Confirm</a></p>");

    [Fact]
    public async Task It_posts_to_the_mail_send_endpoint_with_the_key_as_a_bearer_token()
    {
        await SendAsync(_email);

        var request = Assert.Single(_sendGrid.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal(new Uri("https://api.sendgrid.com/v3/mail/send"), request.Uri);
        Assert.Equal("Bearer", request.Authorization?.Scheme);
        Assert.Equal(Key, request.Authorization?.Parameter);
        Assert.Equal("application/json", request.ContentType);
    }

    [Fact]
    public async Task The_body_names_the_recipient_sender_subject_contents_and_kind()
    {
        await SendAsync(_email, o =>
        {
            o.From = "hello@runovahq.com";
            o.FromName = "Runova team";
        });

        var body = Assert.Single(_sendGrid.Requests).Json;
        var to = Assert.Single(body.GetProperty("personalizations").EnumerateArray()).GetProperty("to");
        Assert.Equal("sam@example.test", Assert.Single(to.EnumerateArray()).GetProperty("email").GetString());
        Assert.Equal("hello@runovahq.com", body.GetProperty("from").GetProperty("email").GetString());
        Assert.Equal("Runova team", body.GetProperty("from").GetProperty("name").GetString());
        Assert.Equal("Confirm your email", body.GetProperty("subject").GetString());

        // SendGrid wants text/plain before text/html.
        var content = body.GetProperty("content").EnumerateArray().ToList();
        Assert.Equal(["text/plain", "text/html"], content.Select(c => c.GetProperty("type").GetString()));
        Assert.Equal(_email.TextBody, content[0].GetProperty("value").GetString());
        Assert.Equal(_email.HtmlBody, content[1].GetProperty("value").GetString());

        Assert.Equal(["VerifyEmail"], body.GetProperty("categories").EnumerateArray().Select(c => c.GetString()));
    }

    [Fact]
    public async Task An_email_without_html_sends_only_the_text()
    {
        await SendAsync(_email with { HtmlBody = null });

        var content = Assert.Single(Assert.Single(_sendGrid.Requests).Json.GetProperty("content").EnumerateArray());
        Assert.Equal("text/plain", content.GetProperty("type").GetString());
    }

    [Fact]
    public async Task Tracking_is_off_so_one_time_links_reach_the_reader_unchanged()
    {
        await SendAsync(_email);

        var tracking = Assert.Single(_sendGrid.Requests).Json.GetProperty("tracking_settings");
        Assert.False(tracking.GetProperty("click_tracking").GetProperty("enable").GetBoolean());
        Assert.False(tracking.GetProperty("click_tracking").GetProperty("enable_text").GetBoolean());
        Assert.False(tracking.GetProperty("open_tracking").GetProperty("enable").GetBoolean());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Sandbox_mode_follows_the_setting(bool sandbox)
    {
        await SendAsync(_email, o => o.SandboxMode = sandbox);

        var mailSettings = Assert.Single(_sendGrid.Requests).Json.GetProperty("mail_settings");
        Assert.Equal(sandbox, mailSettings.GetProperty("sandbox_mode").GetProperty("enable").GetBoolean());
    }

    [Fact]
    public async Task A_refusal_throws_with_the_status_and_what_SendGrid_said_but_not_the_key()
    {
        _sendGrid.Answers(HttpStatusCode.Forbidden, "The from address does not match a verified Sender Identity.");

        var error = await Assert.ThrowsAsync<HttpRequestException>(() => SendAsync(_email));

        Assert.Equal(HttpStatusCode.Forbidden, error.StatusCode);
        Assert.Contains("403", error.Message, StringComparison.Ordinal);
        Assert.Contains("verified Sender Identity", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(Key, error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public async Task Without_a_key_it_refuses_and_calls_nobody(string? key)
    {
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => SendAsync(_email, o => o.SendGridApiKey = key));

        Assert.Contains("Email__SendGridApiKey", error.Message, StringComparison.Ordinal);
        Assert.Empty(_sendGrid.Requests);
    }

    private async Task SendAsync(OutgoingEmail email, Action<EmailOptions>? configure = null)
    {
        var options = new EmailOptions { SendGridApiKey = Key };
        configure?.Invoke(options);
        using var http = new HttpClient(_sendGrid.Handler());
        SendGridEmailTransport.Configure(http);
        var transport = new SendGridEmailTransport(http, Options.Create(options), NullLogger<SendGridEmailTransport>.Instance);
        await transport.SendAsync(email, TestContext.Current.CancellationToken);
    }
}
