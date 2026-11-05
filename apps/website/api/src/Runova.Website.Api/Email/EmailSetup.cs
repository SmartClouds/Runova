using Hangfire;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using MimeKit;
using Runova.Website.Core.Email;
using Runova.Website.Data;
using Runova.Website.Data.Email;

namespace Runova.Website.Api.Email;

/// <summary>SMTP settings, from <c>Email__*</c>. With no host the API keeps emails queued and logs that it can not send.</summary>
internal sealed class EmailOptions
{
    public string? Host { get; set; }

    public int Port { get; set; } = 587;

    public string? UserName { get; set; }

    public string? Password { get; set; }

    public string From { get; set; } = "no-reply@runovahq.com";

    public string FromName { get; set; } = "Runova";

    /// <summary>TLS from the start (port 465) instead of STARTTLS (port 587). Never plain text.</summary>
    public bool ImplicitTls { get; set; }
}

/// <summary>One email on its way out.</summary>
internal sealed record OutgoingEmail(string To, string Subject, string TextBody, string? HtmlBody);

/// <summary>Hands an email to a mail server. Tests swap in a fake.</summary>
internal interface IEmailTransport
{
    Task SendAsync(OutgoingEmail email, CancellationToken cancellationToken);
}

internal static class EmailSetup
{
    public static IServiceCollection AddWebsiteEmail(this IServiceCollection services)
    {
        services.AddOptions<EmailOptions>().BindConfiguration("Email");
        services.AddSingleton<IEmailTransport, SmtpEmailTransport>();
        services.AddScoped<EmailOutbox>();
        services.AddScoped<EmailOutboxJob>();
        return services;
    }
}

/// <summary>
/// Queues emails in the request's <see cref="AppDbContext"/>, so they are saved with the change that
/// sends them, and asks for the outbox to run once that change is committed. The job client is
/// looked up only then: Hangfire keeps a process-wide logger, which a second host in one process
/// (the tests have many) can find disposed.
/// </summary>
internal sealed class EmailOutbox(AppDbContext db, TimeProvider time, IServiceProvider services)
{
    private bool _added;

    public EmailMessage Add(string to, EmailContent content)
    {
        var now = time.GetUtcNow();
        var message = new EmailMessage
        {
            To = to,
            Kind = content.Kind,
            Subject = content.Subject,
            TextBody = content.TextBody,
            HtmlBody = content.HtmlBody,
            CreatedAt = now,
            NextAttemptAt = now,
        };
        db.EmailMessages.Add(message);
        _added = true;
        return message;
    }

    /// <summary>Starts the outbox job now rather than at its next minute. Call after the commit.</summary>
    public void SendSoon()
    {
        if (!_added)
        {
            return;
        }

        try
        {
            services.GetService<IBackgroundJobClient>()?.Enqueue<EmailOutboxJob>(job => job.RunAsync(CancellationToken.None));
        }
        catch (Exception e) when (e is InvalidOperationException or ObjectDisposedException or Npgsql.NpgsqlException)
        {
            // The recurring run picks the message up within a minute.
        }
    }
}

/// <summary>
/// Sends what the outbox holds, oldest first. A failure waits a little longer each time (1, 2, 4
/// minutes and so on, up to an hour) and gives up after ten tries. A sent message keeps its
/// subject and kind but loses its bodies, which held one-time links.
/// </summary>
internal sealed partial class EmailOutboxJob(AppDbContext db, IEmailTransport transport, TimeProvider time, ILogger<EmailOutboxJob> logger)
{
    public const int MaxAttempts = 10;
    private const int Batch = 50;

    [DisableConcurrentExecution(timeoutInSeconds: 60)]
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var due = await db.EmailMessages
            .Where(m => m.SentAt == null && m.Attempts < MaxAttempts && m.NextAttemptAt <= now)
            .OrderBy(m => m.Id)
            .Take(Batch)
            .ToListAsync(cancellationToken);

        foreach (var message in due)
        {
            try
            {
                await transport.SendAsync(new OutgoingEmail(message.To, message.Subject, message.TextBody ?? "", message.HtmlBody), cancellationToken);
                message.SentAt = time.GetUtcNow();
                message.TextBody = null;
                message.HtmlBody = null;
                message.LastError = null;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                message.Attempts++;
                message.LastError = e.GetType().Name + ": " + Truncate(e.Message, 400);
                var wait = TimeSpan.FromMinutes(Math.Min(60, Math.Pow(2, message.Attempts - 1)));
                message.NextAttemptAt = time.GetUtcNow() + wait;
                LogFailed(logger, message.Id, message.Kind, message.Attempts, e);
            }

            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private static string Truncate(string text, int length) => text.Length <= length ? text : text[..length];

    [LoggerMessage(Level = LogLevel.Warning, Message = "Email {Id} ({Kind}) failed on attempt {Attempt}")]
    private static partial void LogFailed(ILogger logger, long id, string kind, int attempt, Exception exception);
}

/// <summary>SMTP through MailKit, always over TLS. With no host set it refuses, so messages stay queued.</summary>
internal sealed partial class SmtpEmailTransport(IOptions<EmailOptions> options, ILogger<SmtpEmailTransport> logger) : IEmailTransport
{
    public async Task SendAsync(OutgoingEmail email, CancellationToken cancellationToken)
    {
        var settings = options.Value;
        if (string.IsNullOrWhiteSpace(settings.Host))
        {
            LogNotConfigured(logger);
            throw new InvalidOperationException("Email is not configured. Set Email__Host and the other Email__ settings.");
        }

        using var message = new MimeMessage();
        message.From.Add(new MailboxAddress(settings.FromName, settings.From));
        message.To.Add(MailboxAddress.Parse(email.To));
        message.Subject = email.Subject;
        message.Body = new BodyBuilder { TextBody = email.TextBody, HtmlBody = email.HtmlBody }.ToMessageBody();

        using var client = new SmtpClient();
        await client.ConnectAsync(
            settings.Host,
            settings.Port,
            settings.ImplicitTls ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTls,
            cancellationToken);
        if (!string.IsNullOrEmpty(settings.UserName))
        {
            await client.AuthenticateAsync(settings.UserName, settings.Password ?? "", cancellationToken);
        }

        await client.SendAsync(message, cancellationToken);
        await client.DisconnectAsync(quit: true, cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "An email is waiting, but Email__Host is not set, so it stays queued")]
    private static partial void LogNotConfigured(ILogger logger);
}
