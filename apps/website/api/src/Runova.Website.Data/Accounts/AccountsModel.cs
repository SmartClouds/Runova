using Microsoft.EntityFrameworkCore;
using Runova.Website.Data.Email;

namespace Runova.Website.Data.Accounts;

/// <summary>The tables behind Runova accounts (E48): the email outbox, sessions, activity, sync and teams.</summary>
internal static class AccountsModel
{
    public static void ConfigureAccounts(this ModelBuilder builder)
    {
        builder.Entity<EmailMessage>(message =>
        {
            message.Property(m => m.To).HasMaxLength(320);
            message.Property(m => m.Kind).HasMaxLength(32);
            message.Property(m => m.Subject).HasMaxLength(200);
            message.Property(m => m.LastError).HasMaxLength(500);
            message.HasIndex(m => new { m.SentAt, m.NextAttemptAt });
            message.HasIndex(m => m.To);
        });
    }
}
