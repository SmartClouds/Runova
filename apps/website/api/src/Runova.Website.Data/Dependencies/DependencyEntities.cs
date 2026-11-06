namespace Runova.Website.Data.Dependencies;

/// <summary>
/// The packages of one project as the desktop app read them (E51). It belongs to a sync scope and
/// the project's item id in it, so everyone who can see the scope (the account, or each member of
/// the team) hears about it. Only ecosystem, name and version are kept: no paths and no files.
/// </summary>
public class PackageInventory
{
    public long Id { get; set; }

    public long ScopeId { get; set; }

    /// <summary>The project's sync item id.</summary>
    public string ItemId { get; set; } = "";

    public string ProjectName { get; set; } = "";

    public long? UploadedBy { get; set; }

    public DateTimeOffset UploadedAt { get; set; }

    /// <summary>SHA-256 of the name and packages, so an unchanged upload changes nothing.</summary>
    public string ContentHash { get; set; } = "";

    /// <summary>When the daily check takes it next. It moves by a few hours from day to day.</summary>
    public DateTimeOffset NextCheckAt { get; set; }

    public DateTimeOffset? LastCheckedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

/// <summary>One direct dependency of a project.</summary>
public class InventoryPackage
{
    public long Id { get; set; }

    public long InventoryId { get; set; }

    /// <summary><c>npm</c>, <c>nuget</c> or <c>pub</c>.</summary>
    public string Ecosystem { get; set; } = "";

    public string Name { get; set; } = "";

    public string Version { get; set; } = "";

    public bool Dev { get; set; }
}

/// <summary>What a registry said about a package, kept for a few hours for every project that uses it.</summary>
public class PackageFacts
{
    public long Id { get; set; }

    public string Ecosystem { get; set; } = "";

    /// <summary>The name as the registry matches it: lower case for NuGet.</summary>
    public string Name { get; set; } = "";

    /// <summary>False when the registry has no such package (a private one, say).</summary>
    public bool Found { get; set; }

    public string? LatestVersion { get; set; }

    public string? Deprecated { get; set; }

    public DateTimeOffset CheckedAt { get; set; }
}

/// <summary>The advisories OSV lists for one version of a package, kept for a few hours.</summary>
public class AdvisoryLookup
{
    public long Id { get; set; }

    public string Ecosystem { get; set; } = "";

    public string Name { get; set; } = "";

    public string Version { get; set; } = "";

    /// <summary>A JSON array of <c>{id, severity, summary, fixedVersion}</c>.</summary>
    public string Advisories { get; set; } = "[]";

    public DateTimeOffset CheckedAt { get; set; }
}

/// <summary>Something the last check found about one package of a project. Gone when it no longer holds.</summary>
public class DependencyFinding
{
    public long Id { get; set; }

    public long InventoryId { get; set; }

    public string Ecosystem { get; set; } = "";

    public string Name { get; set; } = "";

    /// <summary><c>security</c>, <c>deprecated</c>, <c>major</c>, <c>minor</c> or <c>patch</c>.</summary>
    public string Kind { get; set; } = "";

    public string CurrentVersion { get; set; } = "";

    public string? TargetVersion { get; set; }

    public string? AdvisoryId { get; set; }

    public string? Severity { get; set; }

    public string? Summary { get; set; }

    /// <summary>The alert policy's key for this news, the same from one check to the next.</summary>
    public string Key { get; set; } = "";

    public DateTimeOffset FirstSeenAt { get; set; }
}

/// <summary>An account's choices for dependency alerts. No row means the defaults.</summary>
public class DependencyAlertSettings
{
    public long UserId { get; set; }

    public bool Enabled { get; set; } = true;

    public string SecurityMinSeverity { get; set; } = "high";

    public bool Deprecated { get; set; } = true;

    public bool Major { get; set; } = true;

    public bool Minor { get; set; }

    public bool Patch { get; set; }

    /// <summary>In the app and on the website.</summary>
    public bool InApp { get; set; } = true;

    /// <summary>To the linked Telegram chat, if there is one.</summary>
    public bool Telegram { get; set; } = true;

    /// <summary>PostgreSQL's <c>xmin</c>.</summary>
    public uint Version { get; set; }
}

/// <summary>A project an account asked to hear nothing about.</summary>
public class MutedProject
{
    public long UserId { get; set; }

    public long InventoryId { get; set; }

    public DateTimeOffset MutedAt { get; set; }
}

/// <summary>A finding an account was already told about, by the alert policy's key.</summary>
public class DependencyAlertDelivery
{
    public long UserId { get; set; }

    public string Key { get; set; } = "";

    public DateTimeOffset At { get; set; }
}

/// <summary>A message for one account, shown in the desktop app and on the website.</summary>
public class UserNotification
{
    public long Id { get; set; }

    public long UserId { get; set; }

    /// <summary><c>dependency-updates</c> for now.</summary>
    public string Kind { get; set; } = "";

    public string Title { get; set; } = "";

    public string Body { get; set; } = "";

    /// <summary>The worst advisory severity in it, or null.</summary>
    public string? Severity { get; set; }

    /// <summary>The project it is about: its scope and item id, which the desktop app knows it by.</summary>
    public long? ScopeId { get; set; }

    public string? ItemId { get; set; }

    public long? InventoryId { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset? ReadAt { get; set; }
}

/// <summary>The Telegram chat an account linked to the RunovaHQ bot.</summary>
public class TelegramLink
{
    public long UserId { get; set; }

    public long ChatId { get; set; }

    /// <summary>The Telegram name the person has, for the account page; may be null.</summary>
    public string? ChatName { get; set; }

    public DateTimeOffset LinkedAt { get; set; }
}

/// <summary>A one-time code the bot's <c>/start</c> link carries. Only its hash is kept. Good for 15 minutes.</summary>
public class TelegramLinkCode
{
    public long Id { get; set; }

    public long UserId { get; set; }

    public string CodeHash { get; set; } = "";

    public DateTimeOffset ExpiresAt { get; set; }
}

/// <summary>A Telegram message waiting to go out, or sent. Retried with a growing wait, like email.</summary>
public class TelegramMessage
{
    public long Id { get; set; }

    public long ChatId { get; set; }

    public string? Text { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset NextAttemptAt { get; set; }

    public DateTimeOffset? SentAt { get; set; }

    public int Attempts { get; set; }

    public string? LastError { get; set; }
}
