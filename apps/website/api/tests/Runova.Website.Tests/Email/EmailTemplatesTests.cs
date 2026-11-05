using Runova.Website.Core.Email;

namespace Runova.Website.Tests.Email;

public sealed class EmailTemplatesTests
{
    public static TheoryData<string, EmailContent> Every => new()
    {
        { "verify", EmailTemplates.VerifyEmail("Sam", "https://runovahq.com/account/verify-email#token=abc") },
        { "reset", EmailTemplates.ResetPassword("Sam", "https://runovahq.com/account/reset-password#token=abc") },
        { "taken", EmailTemplates.AlreadyRegistered("Sam", "https://runovahq.com/account/sign-in", "https://runovahq.com/account/reset-password") },
    };

    [Theory]
    [MemberData(nameof(Every))]
    public void Every_email_has_a_subject_and_both_bodies(string name, EmailContent content)
    {
        Assert.False(string.IsNullOrWhiteSpace(content.Subject), name);
        Assert.False(string.IsNullOrWhiteSpace(content.TextBody), name);
        Assert.StartsWith("<!doctype html>", content.HtmlBody, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(Every))]
    public void No_email_uses_an_em_dash(string name, EmailContent content)
    {
        Assert.DoesNotContain('—', content.Subject + content.TextBody + content.HtmlBody);
        _ = name;
    }

    [Fact]
    public void The_link_is_in_both_bodies()
    {
        var content = EmailTemplates.VerifyEmail("Sam", "https://runovahq.com/account/verify-email#token=abc");

        Assert.Contains("https://runovahq.com/account/verify-email#token=abc", content.TextBody, StringComparison.Ordinal);
        Assert.Contains("href=\"https://runovahq.com/account/verify-email#token=abc\"", content.HtmlBody, StringComparison.Ordinal);
    }

    [Fact]
    public void A_name_is_html_encoded()
    {
        var content = EmailTemplates.VerifyEmail("<script>alert(1)</script>", "https://runovahq.com/x");

        Assert.DoesNotContain("<script>", content.HtmlBody, StringComparison.Ordinal);
        Assert.Contains("&lt;script&gt;", content.HtmlBody, StringComparison.Ordinal);
    }
}
