namespace Runova.Website.Core.Audit;

/// <summary>The audit actions of the contract, as <c>&lt;resource&gt;.&lt;verb&gt;</c>.</summary>
public static class AuditActions
{
    public const string UserInvite = "user.invite";
    public const string UserUpdate = "user.update";
    public const string UserDelete = "user.delete";
    public const string UserPasswordReset = "user.password-reset";
    public const string UserTwoFactorReset = "user.two-factor-reset";
    public const string NewsCreate = "news.create";
    public const string NewsUpdate = "news.update";
    public const string NewsArchive = "news.archive";
    public const string NewsPublish = "news.publish";
    public const string PostCreate = "post.create";
    public const string PostUpdate = "post.update";
    public const string PostArchive = "post.archive";
    public const string PostPublish = "post.publish";
    public const string MediaUpload = "media.upload";
    public const string MediaDelete = "media.delete";
    public const string ApiClientCreate = "api-client.create";
    public const string ApiClientUpdate = "api-client.update";
    public const string ApiClientRevoke = "api-client.revoke";
    public const string ApiClientRotate = "api-client.rotate";
    public const string SignInSettingsUpdate = "sign-in-settings.update";
    public const string AccountTypeCreate = "account-type.create";
    public const string AccountTypeUpdate = "account-type.update";
    public const string AccountTypeDelete = "account-type.delete";
    public const string PaymentSettingsUpdate = "payment-settings.update";
    public const string SubscriptionAssign = "subscription.assign";
    public const string SubscriptionRemove = "subscription.remove";
    public const string MonitoringNodeCreate = "monitoring-node.create";
    public const string MonitoringNodeUpdate = "monitoring-node.update";
    public const string MonitoringNodeEnrollmentToken = "monitoring-node.enrollment-token";
    public const string MonitoringNodeDrain = "monitoring-node.drain";
    public const string MonitoringNodeRevoke = "monitoring-node.revoke";
    public const string MonitoringNodeDelete = "monitoring-node.delete";
    public const string AnalyticsSettingsUpdate = "analytics-settings.update";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        UserInvite, UserUpdate, UserDelete, UserPasswordReset, UserTwoFactorReset,
        NewsCreate, NewsUpdate, NewsArchive, NewsPublish,
        PostCreate, PostUpdate, PostArchive, PostPublish,
        MediaUpload, MediaDelete,
        ApiClientCreate, ApiClientUpdate, ApiClientRevoke, ApiClientRotate,
        SignInSettingsUpdate,
        AccountTypeCreate, AccountTypeUpdate, AccountTypeDelete, PaymentSettingsUpdate, SubscriptionAssign, SubscriptionRemove,
        MonitoringNodeCreate, MonitoringNodeUpdate, MonitoringNodeEnrollmentToken, MonitoringNodeDrain, MonitoringNodeRevoke, MonitoringNodeDelete,
        AnalyticsSettingsUpdate,
    };
}

/// <summary>Who made a change.</summary>
public static class AuditActorKinds
{
    public const string User = "user";
    public const string ApiClient = "api-client";
    public const string System = "system";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal) { User, ApiClient, System };
}

/// <summary>What kind of thing a change was made to.</summary>
public static class AuditTargetTypes
{
    public const string User = "user";
    public const string News = "news";
    public const string Post = "post";
    public const string Media = "media";
    public const string ApiClient = "api-client";
    public const string SignInSettings = "sign-in-settings";
    public const string AccountType = "account-type";
    public const string PaymentSettings = "payment-settings";
    public const string Subscription = "subscription";
    public const string MonitoringNode = "monitoring-node";
    public const string AnalyticsSettings = "analytics-settings";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        User, News, Post, Media, ApiClient, SignInSettings, AccountType, PaymentSettings, Subscription, MonitoringNode, AnalyticsSettings,
    };
}
