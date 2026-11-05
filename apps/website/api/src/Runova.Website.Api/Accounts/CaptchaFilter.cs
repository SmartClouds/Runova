using Runova.Website.Api.Problems;
using Runova.Website.Core.Accounts;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// The Turnstile check on an anonymous form, while an Admin has the captcha on. The token comes in
/// the request body (<see cref="ICaptchaProtected"/>), works once, and must be for this form. It
/// is checked before anything else the form does, so without one nothing is said about the
/// password or the address.
/// </summary>
internal static class CaptchaFilter
{
    public const string Field = "captchaToken";

    public static RouteHandlerBuilder RequireCaptcha(this RouteHandlerBuilder endpoint, string action) =>
        endpoint.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var settings = await http.RequestServices.GetRequiredService<SignInSettingsStore>().GetAsync(http.RequestAborted);
            if (!settings.CaptchaActive)
            {
                return await next(context);
            }

            var token = context.Arguments.OfType<ICaptchaProtected>().FirstOrDefault()?.CaptchaToken;
            var verifier = http.RequestServices.GetRequiredService<TurnstileVerifier>();
            if (!await verifier.VerifyAsync(settings.TurnstileSecret!, token, action, http.Connection.RemoteIpAddress, http.RequestAborted))
            {
                return ApiProblems.Invalid(Field, "Complete the check that you are a person, then try again.");
            }

            return await next(context);
        });
}
