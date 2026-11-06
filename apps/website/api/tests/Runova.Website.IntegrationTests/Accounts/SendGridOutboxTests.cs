using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Email;
using Runova.Website.Core.Email;
using Runova.Website.Data;
using Runova.Website.Data.Email;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

/// <summary>The outbox with the API's own transport, which is SendGrid, behind a fake api.sendgrid.com.</summary>
public sealed class SendGridOutboxTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeSendGrid _sendGrid = new();
    private string _connection = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _connection = await postgres.CreateDatabaseAsync();
        _factory = new WebsiteApiFactory(
            _connection,
            settings: new Dictionary<string, string> { ["Email:SendGridApiKey"] = "SG.test" },
            services: _sendGrid.Register);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public void The_API_sends_email_through_SendGrid()
    {
        using var factory = new WebsiteApiFactory(_connection);
        using var scope = factory.Services.CreateScope();

        Assert.IsType<SendGridEmailTransport>(scope.ServiceProvider.GetRequiredService<IEmailTransport>());
    }

    [Fact]
    public async Task A_queued_email_goes_to_SendGrid_and_is_marked_sent()
    {
        var id = await QueueAsync();

        await RunJobAsync();

        var request = Assert.Single(_sendGrid.Requests);
        Assert.Equal("SG.test", request.Authorization?.Parameter);
        Assert.Equal("VerifyEmail", Assert.Single(request.Json.GetProperty("categories").EnumerateArray()).GetString());
        var message = await ReadAsync(id);
        Assert.NotNull(message.SentAt);
        Assert.Null(message.TextBody);
        Assert.Null(message.LastError);
    }

    [Fact]
    public async Task A_SendGrid_error_keeps_the_email_queued_with_the_reason()
    {
        _sendGrid.Answers(HttpStatusCode.InternalServerError);
        var id = await QueueAsync();

        await RunJobAsync();

        var message = await ReadAsync(id);
        Assert.Null(message.SentAt);
        Assert.Equal(1, message.Attempts);
        Assert.Contains("500", message.LastError, StringComparison.Ordinal);
        Assert.NotNull(message.TextBody);
    }

    private async Task<long> QueueAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var message = scope.ServiceProvider.GetRequiredService<EmailOutbox>()
            .Add("sam@example.test", new EmailContent("VerifyEmail", "Confirm your email", "Text body", "<p>Html body</p>"));
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        return message.Id;
    }

    private async Task RunJobAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<EmailOutboxJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private async Task<EmailMessage> ReadAsync(long id)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.EmailMessages.AsNoTracking().SingleAsync(m => m.Id == id, TestContext.Current.CancellationToken);
    }
}
