namespace Runova.RemoteAgent.Core;

/// <summary>What the owner chose in the app, copied to the agent when it was set up.</summary>
public sealed record AgentSettings(bool AllowOwnDevices, IReadOnlyList<long> AlwaysAllow, SessionPermissions DefaultPermissions);

public sealed record IncomingFacts(string Mode, string Relation, long ControllerUserId, IReadOnlyList<string> Teams, bool HasPasswordSecret, bool LockedOut);

/// <summary>
/// The agent's own decision on a request (E64). With no one signed in there is no one to ask, so a
/// request that would need someone to accept is declined; only what the owner allowed without asking
/// gets in: the password, the owner's own computers, and teammates they always let in.
/// </summary>
public static class AgentPolicy
{
    public static bool Accepts(IncomingFacts facts, AgentSettings settings)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(settings);
        return facts.Mode switch
        {
            "password" => facts.HasPasswordSecret && !facts.LockedOut,
            "ask" => facts.Relation switch
            {
                "own" => settings.AllowOwnDevices,
                "teammate" => facts.Teams.Count > 0 && settings.AlwaysAllow.Contains(facts.ControllerUserId),
                _ => false,
            },
            _ => false,
        };
    }
}

/// <summary>The same slow-down as the app: 1, 2, 4... seconds after each wrong password, at most a minute, and 15 minutes locked after 10.</summary>
public sealed class PasswordLockout(Func<DateTimeOffset> now)
{
    private int _count;
    private DateTimeOffset _last;
    private DateTimeOffset? _until;

    public void Failed()
    {
        _count++;
        _last = now();
        if (_count >= 10)
        {
            _until = _last + TimeSpan.FromMinutes(15);
        }
    }

    public void Succeeded()
    {
        _count = 0;
        _until = null;
    }

    public TimeSpan Wait()
    {
        Expire();
        if (_until is { } until)
        {
            return Max(until - now());
        }

        if (_count == 0)
        {
            return TimeSpan.Zero;
        }

        var wait = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, _count - 1)));
        return Max(_last + wait - now());
    }

    public bool Locked() => Wait() > TimeSpan.Zero;

    public DateTimeOffset? LockedUntil()
    {
        Expire();
        return _until;
    }

    private void Expire()
    {
        if (_until is { } until && now() >= until)
        {
            _until = null;
            _count = 0;
        }
    }

    private static TimeSpan Max(TimeSpan value) => value > TimeSpan.Zero ? value : TimeSpan.Zero;
}
