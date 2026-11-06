using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Email;
using Runova.Website.Data;
using Runova.Website.Data.Email;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Accounts;

public sealed class EmailOutboxTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTransport _transport = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-11-05T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        var connection = await postgres.CreateDatabaseAsync();
        _factory = new WebsiteApiFactory(connection, time: _time, services: s => s.AddSingleton<IEmailTransport>(_transport));
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task The_job_sends_what_is_queued_and_then_forgets_the_bodies()
    {
        var id = await QueueAsync("sam@example.test");

        await RunJobAsync();

        var message = await ReadAsync(id);
        Assert.Equal("sam@example.test", Assert.Single(_transport.Sent).To);
        Assert.NotNull(message.SentAt);
        Assert.Null(message.TextBody);
        Assert.Null(message.HtmlBody);
    }

    [Fact]
    public async Task A_failed_send_is_retried_later_and_not_at_once()
    {
        var id = await QueueAsync("sam@example.test");
        _transport.FailNext = true;

        await RunJobAsync();
        await RunJobAsync();

        var message = await ReadAsync(id);
        Assert.Null(message.SentAt);
        Assert.Equal(1, message.Attempts);
        Assert.NotNull(message.LastError);
        Assert.Empty(_transport.Sent);

        _time.Advance(TimeSpan.FromMinutes(5));
        await RunJobAsync();

        Assert.Single(_transport.Sent);
    }

    [Fact]
    public async Task A_message_is_sent_once_even_when_the_job_runs_again()
    {
        await QueueAsync("sam@example.test");

        await RunJobAsync();
        await RunJobAsync();

        Assert.Single(_transport.Sent);
    }

    private async Task<long> QueueAsync(string to)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var outbox = scope.ServiceProvider.GetRequiredService<EmailOutbox>();
        var message = outbox.Add(to, new Core.Email.EmailContent("Kind", "Subject", "Text body", "<p>Html body</p>"));
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

    private sealed class FakeTransport : IEmailTransport
    {
        public List<OutgoingEmail> Sent { get; } = [];

        public bool FailNext { get; set; }

        public Task SendAsync(OutgoingEmail email, CancellationToken cancellationToken)
        {
            if (FailNext)
            {
                FailNext = false;
                throw new InvalidOperationException("SendGrid said no.");
            }

            Sent.Add(email);
            return Task.CompletedTask;
        }
    }
}
