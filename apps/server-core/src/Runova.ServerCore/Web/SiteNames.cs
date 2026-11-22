using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Web;

/// <summary>Every name a site answers for: its domains, then the names redirected to it.</summary>
internal static class SiteNames
{
    /// <summary>What a certificate for the site has to cover.</summary>
    public static string[] All(SiteSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return [.. settings.Domains ?? [], .. settings.RedirectDomains ?? []];
    }
}
