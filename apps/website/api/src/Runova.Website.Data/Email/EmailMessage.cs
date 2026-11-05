namespace Runova.Website.Data.Email;

/// <summary>
/// An email waiting in the outbox, or sent. It is saved in the same transaction as the change that
/// sends it, so a rolled back registration sends nothing. The bodies hold one-time links, so they are
/// cleared as soon as the message is sent.
/// </summary>
public class EmailMessage
{
    public long Id { get; set; }

    public string To { get; set; } = "";

    /// <summary>One of the kinds in <c>EmailTemplates</c>, for logs and counts; never a secret.</summary>
    public string Kind { get; set; } = "";

    public string Subject { get; set; } = "";

    public string? TextBody { get; set; }

    public string? HtmlBody { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>The earliest the outbox tries again after a failure.</summary>
    public DateTimeOffset NextAttemptAt { get; set; }

    public DateTimeOffset? SentAt { get; set; }

    public int Attempts { get; set; }

    /// <summary>The last failure, without the message or any address in it.</summary>
    public string? LastError { get; set; }
}
