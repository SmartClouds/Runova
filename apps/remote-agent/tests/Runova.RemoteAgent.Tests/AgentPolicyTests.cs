using Runova.RemoteAgent.Core;

namespace Runova.RemoteAgent.Tests;

public class AgentPolicyTests
{
    private static readonly AgentSettings _none = new(AllowOwnDevices: false, AlwaysAllow: [], DefaultPermissions: new SessionPermissions(true, true, false));

    private static IncomingFacts Facts(string mode = "ask", string relation = "own", long userId = 4, bool secret = false, bool locked = false) =>
        new(mode, relation, userId, ["Ops"], secret, locked);

    [Fact]
    public void No_one_is_there_to_accept_so_asking_needs_a_rule_that_lets_them_in()
    {
        Assert.False(AgentPolicy.Accepts(Facts(), _none));
        Assert.True(AgentPolicy.Accepts(Facts(), _none with { AllowOwnDevices = true }));
        Assert.False(AgentPolicy.Accepts(Facts(relation: "teammate"), _none with { AllowOwnDevices = true }));
        Assert.True(AgentPolicy.Accepts(Facts(relation: "teammate"), _none with { AlwaysAllow = [4] }));
        Assert.False(AgentPolicy.Accepts(Facts(relation: "other"), _none with { AlwaysAllow = [4], AllowOwnDevices = true }));
    }

    [Fact]
    public void A_password_request_needs_a_password_and_no_lockout()
    {
        Assert.False(AgentPolicy.Accepts(Facts(mode: "password", relation: "other"), _none));
        Assert.True(AgentPolicy.Accepts(Facts(mode: "password", relation: "other", secret: true), _none));
        Assert.False(AgentPolicy.Accepts(Facts(mode: "password", relation: "other", secret: true, locked: true), _none));
    }

    [Fact]
    public void Wrong_passwords_wait_longer_each_time_and_lock_after_ten()
    {
        var now = DateTimeOffset.UnixEpoch;
        var lockout = new PasswordLockout(() => now);

        lockout.Failed();
        Assert.Equal(TimeSpan.FromSeconds(1), lockout.Wait());
        lockout.Failed();
        Assert.Equal(TimeSpan.FromSeconds(2), lockout.Wait());
        for (var i = 0; i < 8; i++)
        {
            now += TimeSpan.FromMinutes(1);
            lockout.Failed();
        }

        Assert.True(lockout.Locked());
        Assert.Equal(now + TimeSpan.FromMinutes(15), lockout.LockedUntil());
        now += TimeSpan.FromMinutes(15);
        Assert.False(lockout.Locked());
    }
}
