using System.Net;

namespace Runova.Website.Core.Email;

/// <summary>An email ready to queue: a kind for the outbox, a subject, and a plain and an HTML body.</summary>
public sealed record EmailContent(string Kind, string Subject, string TextBody, string HtmlBody);

/// <summary>
/// The emails the website sends to Runova accounts. Each has a plain text body and a simple HTML
/// body with one button. Names are HTML encoded; links are made by the API from the site's own URL.
/// </summary>
public static class EmailTemplates
{
    public const string VerifyEmailKind = "verify-email";
    public const string ResetPasswordKind = "reset-password";
    public const string AlreadyRegisteredKind = "already-registered";
    public const string NewSignInKind = "new-sign-in";
    public const string TeamInvitationKind = "team-invitation";
    public const string PlanEndingKind = "plan-ending";
    public const string PlanEndedKind = "plan-ended";

    public static EmailContent VerifyEmail(string name, string link) => Build(
        VerifyEmailKind,
        "Confirm your email for Runova",
        name,
        [
            "Thanks for making a Runova account. Confirm this is your email address and you are ready to sign in on every computer.",
            "The link works once and for 24 hours.",
        ],
        "Confirm email",
        link,
        "If you did not make a Runova account, you can ignore this email.");

    public static EmailContent ResetPassword(string name, string link) => Build(
        ResetPasswordKind,
        "Reset your Runova password",
        name,
        [
            "Someone asked to reset the password of your Runova account. If it was you, pick a new password with the link below.",
            "The link works once and for one hour. Setting a new password signs you out everywhere else.",
        ],
        "Pick a new password",
        link,
        "If you did not ask for this, ignore this email. Your password stays as it is.");

    public static EmailContent AlreadyRegistered(string name, string signInLink, string resetLink) => Build(
        AlreadyRegisteredKind,
        "You already have a Runova account",
        name,
        [
            "Someone tried to make a new Runova account with this email address, which already has one.",
            $"If it was you, sign in instead. Forgot your password? Reset it here: {resetLink}",
        ],
        "Sign in",
        signInLink,
        "If it was not you, nothing has changed and you can ignore this email.");

    public static EmailContent NewSignIn(string name, string device, string where, string sessionsLink) => Build(
        NewSignInKind,
        "New sign-in to your Runova account",
        name,
        [
            $"Your Runova account was just signed in on {device}, from {where}.",
            "If this was you, there is nothing to do. If not, end that session and change your password.",
        ],
        "See your sessions",
        sessionsLink,
        "You get this email for every new computer or browser that signs in.");

    public static EmailContent TeamInvitation(string inviter, string team, string role, string link) => Build(
        TeamInvitationKind,
        $"{inviter} invited you to {team} on Runova",
        null,
        [
            $"{inviter} invited you to join the team {team} as {role}.",
            "Sign in or make an account with this email address to accept. The invitation is good for 7 days.",
        ],
        "See the invitation",
        link,
        "If you were not expecting this, you can ignore this email.");

    public static EmailContent PlanEnding(string name, string plan, string endsOn, string link) => Build(
        PlanEndingKind,
        $"Your Runova {plan} plan ends on {endsOn}",
        name,
        [
            $"Your {plan} plan was paid up front and ends on {endsOn}. After that this account goes back to Free, and online monitors over its limit are paused.",
            "Extend it from your Plan page whenever you like. The time you buy is added to the end date.",
        ],
        "Extend my plan",
        link,
        "You get this email a week before and the day before a prepaid plan ends.");

    public static EmailContent PlanEnded(string name, string plan, string link) => Build(
        PlanEndedKind,
        $"Your Runova {plan} plan ended",
        name,
        [
            $"Your {plan} plan ended, so this account is on Free now. Online monitors over the Free limit are paused, and none of their history is lost.",
            "Renew from your Plan page and they start again.",
        ],
        "See plans",
        link,
        "You get this email once, when a plan ends.");

    private static EmailContent Build(string kind, string subject, string? name, string[] paragraphs, string button, string link, string footer)
    {
        var greeting = string.IsNullOrWhiteSpace(name) ? "Hi," : $"Hi {name},";
        var text = string.Join(
            "\n\n",
            [greeting, .. paragraphs, $"{button}: {link}", footer, "Runova, https://runovahq.com"]);

        var encodedLink = WebUtility.HtmlEncode(link);
        var body = string.Concat(paragraphs.Select(p => $"<p style=\"margin:0 0 16px\">{WebUtility.HtmlEncode(p)}</p>"));
        var html = $$"""
            <!doctype html>
            <html lang="en">
            <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{{WebUtility.HtmlEncode(subject)}}</title></head>
            <body style="margin:0;padding:24px;background:#f4f5f6;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#17191c">
            <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
            <p style="margin:0 0 24px;font-weight:600;font-size:18px">Runova</p>
            <p style="margin:0 0 16px">{{WebUtility.HtmlEncode(greeting)}}</p>
            {{body}}
            <p style="margin:24px 0"><a href="{{encodedLink}}" style="display:inline-block;background:#00e676;color:#0a0a0a;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:999px">{{WebUtility.HtmlEncode(button)}}</a></p>
            <p style="margin:0 0 16px;font-size:13px;color:#5b6068">Or open this link: {{encodedLink}}</p>
            <p style="margin:0;font-size:13px;color:#5b6068">{{WebUtility.HtmlEncode(footer)}}</p>
            </div>
            </body>
            </html>
            """;
        return new EmailContent(kind, subject, text, html);
    }
}
