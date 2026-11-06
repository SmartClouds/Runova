using Runova.Website.Api.Accounts;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Billing;
using Runova.Website.Api.Dependencies;
using Runova.Website.Api.Media;
using Runova.Website.Api.Monitoring;
using Runova.Website.Api.News;
using Runova.Website.Api.Posts;
using Runova.Website.Api.Releases;
using Runova.Website.Api.Reports;
using Runova.Website.Api.Sessions;
using Runova.Website.Api.Users;

namespace Runova.Website.Api;

/// <summary>The <c>/api/v1</c> route group that every resource maps its endpoints on.</summary>
internal static class ApiV1
{
    public const string Prefix = "/api/v1";

    public static RouteGroupBuilder MapApiV1(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup(Prefix);
        // One static class per resource adds itself here.
        api.MapSessions();
        api.MapMe();
        api.MapUsers();
        api.MapPasswordSetups();
        api.MapAccounts();
        api.MapAccountSessions();
        api.MapExternalSignIns();
        api.MapSignInSettings();
        api.MapDeviceTokens();
        api.MapSync();
        api.MapTeams();
        api.MapNews();
        api.MapTechnologies();
        api.MapPosts();
        api.MapMedia();
        api.MapAuditEntries();
        api.MapApiClients();
        api.MapReleases();
        api.MapReports();
        api.MapDependencies();
        api.MapBilling();
        api.MapMonitoring();
        return api;
    }
}
