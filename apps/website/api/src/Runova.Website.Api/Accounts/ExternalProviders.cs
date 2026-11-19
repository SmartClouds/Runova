using System.Diagnostics.CodeAnalysis;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Google;
using Microsoft.AspNetCore.WebUtilities;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// A sign-in provider: the name the API and the pages use (<c>google</c>), the handler's scheme,
/// which is also what Identity keeps as the login's provider, the callback the handler listens on,
/// and whether the saved settings switch it on.
/// </summary>
internal sealed record ExternalProvider(string Name, string Scheme, string CallbackPath, Func<SignInSnapshot, bool> IsActive)
{
    /// <summary>The error code the sign-in page shows when the provider's side went wrong.</summary>
    public string FailedCode => $"{Name}-failed";
}

/// <summary>Every provider a Runova account can sign in with (E48.3, E116).</summary>
internal static class ExternalProviders
{
    public static readonly ExternalProvider Google = new("google", GoogleDefaults.AuthenticationScheme, "/api/oauth/google/callback", s => s.GoogleActive);

    public static readonly ExternalProvider Apple = new("apple", "Apple", "/api/oauth/apple/callback", s => s.AppleActive);

    public static readonly ExternalProvider Microsoft = new("microsoft", "Microsoft", "/api/oauth/microsoft/callback", s => s.MicrosoftActive);

    /// <summary>In the order the sign-in pages show them.</summary>
    public static readonly IReadOnlyList<ExternalProvider> All = [Google, Apple, Microsoft];

    public static bool TryFind(string? name, [NotNullWhen(true)] out ExternalProvider? provider)
    {
        provider = All.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
        return provider is not null;
    }

    /// <summary>The provider whose handler (scheme) made a login, as Identity keeps it.</summary>
    public static ExternalProvider? ForScheme(string? scheme) =>
        All.FirstOrDefault(p => string.Equals(p.Scheme, scheme, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Where a failed or cancelled sign-in lands: the sign-in page with the reason, and with where
    /// the sign-in was going when that was anywhere but the account page, so an app's authorize
    /// page can still finish after the person tries another way.
    /// </summary>
    public static string FailurePath(string error, string? returnUrl)
    {
        var back = ExternalSignInEndpoints.SafeReturn(returnUrl);
        return back == ExternalSignInEndpoints.DefaultReturn
            ? $"{ExternalSignInEndpoints.SignInPage}?error={error}"
            : $"{ExternalSignInEndpoints.SignInPage}?error={error}&next={Uri.EscapeDataString(back)}";
    }

    /// <summary>
    /// The handler's failure event, for every provider: the reason and the return path, read back
    /// from the finish address the sign-in started with.
    /// </summary>
    public static Task OnRemoteFailure(ExternalProvider provider, RemoteFailureContext context)
    {
        context.Response.Redirect(FailurePath(provider.FailedCode, ReturnUrlOf(context.Properties)));
        context.HandleResponse();
        return Task.CompletedTask;
    }

    private static string? ReturnUrlOf(AuthenticationProperties? properties)
    {
        if (properties?.RedirectUri is not { } finish || finish.IndexOf('?', StringComparison.Ordinal) is var at && at < 0)
        {
            return null;
        }

        var query = QueryHelpers.ParseQuery(finish[at..]);
        return query.TryGetValue("returnUrl", out var value) ? value.ToString() : null;
    }
}
