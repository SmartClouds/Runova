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

/// <summary>
/// The same slow-down as the app: 1, 2, 4... seconds after each wrong password, at most a minute, and
/// 15 minutes locked after 10. Requests are served at the same time, so every call takes one lock.
/// </summary>
public sealed class PasswordLockout(Func<DateTimeOffset> now)
{
    private readonly Lock _gate = new();
    private int _count;
    private DateTimeOffset _last;
    private DateTimeOffset? _until;

    /// <summary>
    /// Counts a guess as wrong before it is checked, unless the lockout is on; false when it is.
    /// The host's handshake reply already tells the controller whether its guess was right, so a
    /// guess has to count from the start and only <see cref="Succeeded"/> takes it back. Checking
    /// and counting together also keeps requests that arrive at once from all getting past.
    /// </summary>
    public bool TryBegin()
    {
        lock (_gate)
        {
            if (WaitLocked() > TimeSpan.Zero)
            {
                return false;
            }

            FailedLocked();
            return true;
        }
    }

    public void Failed()
    {
        lock (_gate)
        {
            FailedLocked();
        }
    }

    public void Succeeded()
    {
        lock (_gate)
        {
            _count = 0;
            _until = null;
        }
    }

    public TimeSpan Wait()
    {
        lock (_gate)
        {
            return WaitLocked();
        }
    }

    public bool Locked() => Wait() > TimeSpan.Zero;

    public DateTimeOffset? LockedUntil()
    {
        lock (_gate)
        {
            Expire();
            return _until;
        }
    }

    private void FailedLocked()
    {
        _count++;
        _last = now();
        if (_count >= 10)
        {
            _until = _last + TimeSpan.FromMinutes(15);
        }
    }

    private TimeSpan WaitLocked()
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
