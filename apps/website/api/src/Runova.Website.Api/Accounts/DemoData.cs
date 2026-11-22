using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Runova.Website.Api.CloudMonitoring;
using Runova.Website.Api.Notifications;
using Runova.Website.Api.Remote;
using Runova.Website.Core.Accounts;
using Runova.Website.Core.Billing;
using Runova.Website.Data.Accounts;
using Runova.Website.Data.Monitoring;
using Runova.Website.Data.Remote;

namespace Runova.Website.Api.Accounts;

/// <summary>
/// What the demo account shows: a small team at Northwind using Runova, in the API's own DTOs.
/// Every time is relative to the clock's now, so the screens always look recent. The values are
/// made up on the spot and come from no stored row, so this builds the DTOs directly. Remote ids
/// start with 0, which a real one (100000000 to 999999999) never does.
/// </summary>
internal static class DemoData
{
    public const long NorthwindTeamId = -21;
    public const long ContosoTeamId = -22;
    public const long ContosoInvitationId = -42;

    private const long NorthwindScopeId = -31;
    private const long ContosoScopeId = -32;
    private const string Maya = "Maya Lindqvist";
    private const string MayaEmail = "maya.lindqvist@northwind.example";

    public static AccountDto Account(DateTimeOffset now, string displayName = DemoAccount.DisplayName) =>
        new(
            DemoAccount.UserId,
            DemoAccount.Email,
            displayName,
            EmailConfirmed: true,
            HasPassword: true,
            TwoFactorEnabled: true,
            Logins: [],
            PasskeyCount: 1,
            Staff: false,
            CreatedAt: now.AddDays(-45),
            LastSignInAt: now.AddMinutes(-2),
            Version: "1");

    public static SessionListDto Sessions(DateTimeOffset now) =>
        new(
        [
            new(DemoAccount.SessionId, AccountSessionKinds.Mobile, DeviceTokenEndpoints.PhoneDeviceName, "Phone", "4.1.0", null, now.AddMinutes(-2), now, Current: true),
            new(-2, AccountSessionKinds.Desktop, "Demo workstation", "Windows", "4.1.0", "203.0.113.24", now.AddDays(-30), now.AddMinutes(-3), Current: false),
            new(-3, AccountSessionKinds.Web, "Firefox on macOS", "macOS", null, "198.51.100.17", now.AddHours(-5), now.AddHours(-4), Current: false),
        ]);

    public static IReadOnlyList<ActivityDto> Activities(DateTimeOffset now) =>
    [
        new(-61, ActivityActions.DeviceSignIn, null, null, DeviceTokenEndpoints.PhoneDeviceName, now.AddMinutes(-2), Details(("device", DeviceTokenEndpoints.PhoneDeviceName), ("platform", "Phone"))),
        new(-62, ActivityActions.MemberInvited, NorthwindTeamId, "203.0.113.24", "Demo workstation", now.AddHours(-3), Details(("email", "lee.chen@northwind.example"), ("role", TeamRoles.Member))),
        new(-63, ActivityActions.SignIn, null, "198.51.100.17", null, now.AddHours(-5), null),
        new(-64, ActivityActions.MemberRoleChanged, NorthwindTeamId, "203.0.113.24", "Demo workstation", now.AddDays(-1), Details(("from", TeamRoles.Member), ("to", TeamRoles.Admin))),
        new(-65, ActivityActions.SessionEnded, null, "203.0.113.24", "Old laptop", now.AddDays(-6), Details(("device", "Old laptop"))),
        new(-66, ActivityActions.SyncPolicyChanged, NorthwindTeamId, "203.0.113.24", "Demo workstation", now.AddDays(-10), null),
        new(-67, ActivityActions.PasskeyAdded, null, "198.51.100.17", null, now.AddDays(-19), null),
        new(-68, ActivityActions.TwoFactorOn, null, "198.51.100.17", null, now.AddDays(-20), null),
        new(-69, ActivityActions.DeviceSignIn, null, "203.0.113.24", "Demo workstation", now.AddDays(-30), Details(("device", "Demo workstation"), ("platform", "Windows"))),
        new(-70, ActivityActions.MemberJoined, NorthwindTeamId, "203.0.113.24", "Demo workstation", now.AddDays(-38), Details(("role", TeamRoles.Admin))),
        new(-71, ActivityActions.TeamCreated, NorthwindTeamId, "198.51.100.17", null, now.AddDays(-40), Details(("name", "Northwind"))),
        new(-72, ActivityActions.EmailVerified, null, "198.51.100.17", null, now.AddDays(-45), null),
    ];

    public static TeamListDto Teams(DateTimeOffset now) => new([Northwind(now)]);

    public static TeamDto? Team(long id, DateTimeOffset now) => id == NorthwindTeamId ? Northwind(now) : null;

    public static TeamDto Contoso(DateTimeOffset now) => new(ContosoTeamId, "Contoso Labs", TeamRoles.Member, 6, ContosoScopeId, now.AddDays(-90));

    public static TeamMemberListDto Members(DateTimeOffset now) =>
        new(
        [
            new(DemoAccount.UserId, DemoAccount.Email, DemoAccount.DisplayName, TeamRoles.Owner, now.AddDays(-40)),
            new(-2, MayaEmail, Maya, TeamRoles.Admin, now.AddDays(-38)),
            new(-3, "omar.haddad@northwind.example", "Omar Haddad", TeamRoles.Member, now.AddDays(-30)),
            new(-4, "priya.nair@northwind.example", "Priya Nair", TeamRoles.Viewer, now.AddDays(-12)),
        ]);

    public static TeamInvitationListDto TeamInvitations(DateTimeOffset now) =>
        new([new(-41, "lee.chen@northwind.example", TeamRoles.Member, now.AddHours(-3), now.AddHours(-3) + TeamEndpoints.InvitationLifetime)]);

    public static MyInvitationListDto MyInvitations(DateTimeOffset now) =>
        new([new(ContosoInvitationId, ContosoTeamId, "Contoso Labs", TeamRoles.Member, "Sam Rivera", now.AddDays(5))]);

    public static IReadOnlyList<UserNotificationDto> Notifications(DateTimeOffset now) =>
    [
        Notification(-101, NotificationCategories.Deploys, "Critical alert on northwind-shop production", "The health check on shop.northwind.example stopped answering after the release.", "critical", now.AddMinutes(-12), null),
        Notification(-102, CloudMonitorNotifier.DownKind, "Admin dashboard is down", "Connection timed out after 10 s, seen from eu-central and confirmed from us-east.", "critical", now.AddMinutes(-40), null),
        Notification(-103, NotificationCategories.Pipelines, "CI on main passed in northwind-shop", "Build, tests and lint finished in 6 min 12 s.", null, now.AddHours(-1), null),
        Notification(-104, "team-invitation", "Sam Rivera invited you to Contoso Labs", "Open your account to accept or decline.", null, now.AddHours(-2), null),
        Notification(-105, CloudMonitorNotifier.RecoveredKind, "Checkout API is back up", "It was down for 4 minutes.", "info", now.AddHours(-6), now.AddHours(-5)),
        Notification(-106, CloudMonitorNotifier.DownKind, "Checkout API is down", "HTTP 503 from api.northwind.example/health.", "critical", now.AddHours(-6).AddMinutes(-4), now.AddHours(-5)),
        Notification(-107, NotificationCategories.AgentFinished, "Your agent finished in northwind-shop", "Fixed the flaky checkout test and opened a pull request.", null, now.AddHours(-9), now.AddHours(-8)),
        Notification(-108, "sign-in", "New sign-in on Firefox on macOS", "If this was not you, end that session in your account.", "warning", now.AddDays(-1), now.AddDays(-1)),
    ];

    public static NotificationPreferencesDto NotificationPreferences() =>
        new([.. NotificationCategories.All.Select(c => NotificationMapper.ToDto(c, c.Id is not (NotificationCategories.ToolUpdates or NotificationCategories.SecurityNews)))]);

    /// <summary>The demo is on Pro, with notifications sealed for its own devices and a sync key set.</summary>
    public static EncryptionDto Encryption(IReadOnlySet<string> enabled) =>
        EncryptionRules.Status(
            new Entitlement(-1, "pro", "Pro", MaxCloudMonitors: 25, MinIntervalSec: 60, HistoryDays: 90, IsFree: false, EncryptedItems: true),
            enabled,
            syncSealing: enabled.Contains(EncryptionItems.Sync),
            syncHasKey: true);

    public static IReadOnlySet<string> EncryptionOn { get; } = new HashSet<string>(StringComparer.Ordinal) { EncryptionItems.Notifications };

    public static CloudMonitorListDto CloudMonitors(DateTimeOffset now)
    {
        var checkedAt = now.AddSeconds(-40);
        var incident = new CloudMonitorIncidentDto(-301, -203, now.AddMinutes(-40), null, "problem", "Connection timed out after 10 s", "eu-central", "us-east");
        return new(
        [
            Monitor(-201, "Storefront", "https://shop.northwind.example/", "production", now, paused: false,
                new("up", "ok", checkedAt, 182, 200, null, "eu-central", false, null, 1.0)),
            Monitor(-202, "Checkout API", "https://api.northwind.example/health", "production", now, paused: false,
                new("up", "ok", checkedAt, 241, 200, null, "us-east", false, null, 0.9861)),
            Monitor(-203, "Admin dashboard", "https://admin.northwind.example/", "production", now, paused: false,
                new("down", "problem", checkedAt, null, null, "Connection timed out after 10 s", "eu-central", false, incident, 0.9583)),
            Monitor(-205, "Image CDN", "https://cdn.northwind.example/ping", "production", now, paused: false,
                new("degraded", "warn", checkedAt, 2380, 200, "Slow answer: 2.4 s", "eu-central", false, null, 0.9931)),
            Monitor(-204, "Staging storefront", "https://staging.northwind.example/", "staging", now, paused: true,
                PausedStatus(now)),
        ]);
    }

    public static CloudMonitorStatusDto PausedStatus(DateTimeOffset now) => new("paused", "ok", now.AddDays(-2), 205, 200, null, "eu-central", false, null, null);

    /// <summary>Exactly what the phone's own made-up computer expects to find.</summary>
    public static RemoteDirectoryDto ReachableDevices(DateTimeOffset now)
    {
        var me = new RemoteOwnerDto(DemoAccount.UserId, DemoAccount.DisplayName, DemoAccount.Email);
        var maya = new RemoteOwnerDto(-2, Maya, MayaEmail);
        return new(
            [
                new(-11, "000000001", "Demo workstation", "windows", RemoteDeviceKinds.App, IdentityKey("000000001"), UnattendedEnabled: false, Online: true, now, me, [], ["receive-files"]),
                new(-12, "000000002", "Demo laptop", "macos", RemoteDeviceKinds.App, IdentityKey("000000002"), UnattendedEnabled: false, Online: false, now.AddDays(-2), me, [], []),
            ],
            [
                new(-13, "000000003", "Northwind build box", "linux", RemoteDeviceKinds.Agent, IdentityKey("000000003"), UnattendedEnabled: false, Online: true, now, maya, [new(NorthwindTeamId, "Northwind")], []),
            ],
            []);
    }

    /// <summary>The phone's registration for Runova Anywhere, answered and kept nowhere.</summary>
    public static RemoteDeviceDto Phone(DateTimeOffset now, string name, string platform, string identityKey) =>
        new(-1, "000000009", name, platform, RemoteEndpoints.PhonePlatforms.Contains(platform) ? RemoteDeviceKinds.Phone : RemoteDeviceKinds.App, identityKey, AllowOwnDevices: false, UnattendedEnabled: false, TeamIds: [], Online: false, AgentIdentityKey: null, now, now);

    /// <summary>Every body the demo answers a read with, for the tests that look through all of it.</summary>
    public static IReadOnlyList<object> Everything(DateTimeOffset now) =>
    [
        Account(now),
        Sessions(now),
        Activities(now),
        Teams(now),
        Contoso(now),
        Members(now),
        TeamInvitations(now),
        MyInvitations(now),
        Notifications(now),
        NotificationPreferences(),
        Encryption(EncryptionOn),
        CloudMonitors(now),
        ReachableDevices(now),
        Phone(now, "Pixel 9", "android", IdentityKey("000000009")),
    ];

    private static TeamDto Northwind(DateTimeOffset now) => new(NorthwindTeamId, "Northwind", TeamRoles.Owner, 4, NorthwindScopeId, now.AddDays(-40));

    private static UserNotificationDto Notification(long id, string kind, string title, string body, string? severity, DateTimeOffset at, DateTimeOffset? readAt) =>
        new(id, kind, title, body, severity, NorthwindScopeId, null, null, at, readAt, NotificationCategories.OfKind(kind), null);

    private static CloudMonitorDto Monitor(long id, string name, string url, string environment, DateTimeOffset now, bool paused, CloudMonitorStatusDto status) =>
        new(
            id,
            NorthwindScopeId,
            $"demo-monitor{id}",
            name,
            "northwind-shop",
            environment,
            url,
            IntervalSec: 60,
            TimeoutSec: 10,
            CloudAuthModes.None,
            HasSecret: false,
            SecretChangedAt: null,
            AllowInsecure: false,
            paused,
            SuspendedReason: null,
            NotifyInApp: true,
            NotifyTelegram: false,
            Muted: false,
            CanWrite: true,
            status,
            CreatedAt: now.AddDays(-30),
            UpdatedAt: now.AddDays(-2),
            Version: "1");

    private static Dictionary<string, object?> Details(params (string Key, object? Value)[] details) =>
        details.ToDictionary(d => d.Key, d => d.Value, StringComparer.Ordinal);

    // A made-up Ed25519-sized public key, the same for a device every time.
    private static string IdentityKey(string remoteId) =>
        Base64Url.EncodeToString(SHA256.HashData(Encoding.UTF8.GetBytes("runova-demo:" + remoteId)));
}
