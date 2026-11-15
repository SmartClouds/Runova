using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Cloudflare;

/// <summary>The firewall changes for the tunnel, and what the person should know about them.</summary>
internal sealed record TunnelFirewallPlan(IReadOnlyList<FirewallChange> Changes, IReadOnlyList<string> Notes);

/// <summary>Rules that still let someone in where the tunnel wants no one (empty: it matches).</summary>
internal sealed record TunnelFirewallComparison(IReadOnlyList<string> Open)
{
    public bool Matches => Open.Count == 0;
}

/// <summary>
/// Works out the firewall side of the Cloudflare Tunnel (E95) from the firewall as it is. The web
/// ports (80, 443 and Direct TLS's) close to everyone, the origin lock's Cloudflare rules included,
/// since cloudflared reaches nginx over loopback, which every firewall lets through. SSH is a
/// second, separate step: it stays open, closes to everyone (the tunnel or the core domain is the
/// way in), or opens to Cloudflare Mesh's addresses only. Only single-port rules are removed; a
/// wider rule or one the core cannot change is named instead, as the origin lock does.
/// </summary>
internal static class TunnelFirewallPlanner
{
    public const string MeshComment = "cloudflare mesh";

    /// <summary>The addresses Cloudflare Mesh hands out to its nodes and clients (CGNAT space).</summary>
    public const string MeshRange = "100.96.0.0/12";

    /// <summary>Documentation addresses (RFC 5737, RFC 3849): a rule that lets them in lets everyone in.</summary>
    private static readonly IPAddress[] _outsiders = [IPAddress.Parse("192.0.2.1"), IPAddress.Parse("2001:db8::1")];

    private static readonly IPNetwork _mesh = IPNetwork.Parse(MeshRange);

    /// <summary>Closes the web ports to everyone. SSH is left as it is.</summary>
    public static TunnelFirewallPlan PlanWeb(FirewallState state, IReadOnlyCollection<int> webPorts)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(webPorts);
        RequireDenyByDefault(state);
        var changes = new List<FirewallChange>();
        var notes = new List<string>();
        foreach (var rule in state.Rules.Where(rule => LetsIn(rule) && webPorts.Any(port => Covers(rule, port))).DistinctBy(rule => rule.Id))
        {
            if (rule.Editable && IsSinglePortRule(rule, webPorts))
            {
                changes.Add(Remove(rule));
            }
            else if (OutsidersReach(rule, webPorts))
            {
                notes.Add(StillOpen(rule, "the sites"));
            }
        }

        if (state.Backend == FirewallBackendKind.Ufw && !state.Ipv6)
        {
            notes.Add("ufw is not set up for IPv6 (IPV6=no). The tunnel needs nothing over IPv6, so this is fine.");
        }

        return Checked(changes, notes);
    }

    /// <summary>Who may open SSH while the tunnel is on.</summary>
    public static TunnelFirewallPlan PlanSsh(FirewallState state, TunnelSshMode mode, IReadOnlyCollection<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(sshPorts);
        RequireDenyByDefault(state);
        var changes = new List<FirewallChange>();
        var notes = new List<string>();
        if (mode == TunnelSshMode.Open)
        {
            foreach (var rule in MeshRules(state, sshPorts).Where(rule => rule.Editable))
            {
                changes.Add(Remove(rule));
            }

            foreach (var port in sshPorts.Where(port => !state.Rules.Any(rule => OutsidersReach(rule, [port]))))
            {
                changes.Add(new FirewallChange(FirewallChangeKind.AddRule, new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port)));
            }

            return Checked(changes, notes);
        }

        foreach (var rule in state.Rules.Where(rule => LetsIn(rule) && sshPorts.Any(port => Covers(rule, port))).DistinctBy(rule => rule.Id))
        {
            if (mode == TunnelSshMode.Mesh && IsMeshRule(rule, sshPorts))
            {
                continue;
            }

            if (rule.Editable && IsSinglePortRule(rule, sshPorts))
            {
                changes.Add(Remove(rule));
            }
            else if (OutsidersReach(rule, sshPorts))
            {
                notes.Add(StillOpen(rule, "SSH"));
            }
        }

        if (mode == TunnelSshMode.Mesh)
        {
            foreach (var port in sshPorts.Where(port => !state.Rules.Any(rule => IsMeshRule(rule, [port]))))
            {
                changes.Add(new FirewallChange(
                    FirewallChangeKind.AddRule,
                    new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port, Source: MeshRange, Comment: MeshComment)));
            }
        }

        return Checked(changes, notes);
    }

    /// <summary>
    /// Opens SSH to everyone again and drops the Mesh rule; with <paramref name="reopenWeb"/>, opens
    /// the web ports to everyone too (left closed when the origin lock takes over).
    /// </summary>
    public static TunnelFirewallPlan PlanOff(FirewallState state, IReadOnlyCollection<int> webPorts, IReadOnlyCollection<int> sshPorts, bool reopenWeb)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(webPorts);
        var ssh = PlanSsh(state, TunnelSshMode.Open, sshPorts);
        var changes = new List<FirewallChange>(ssh.Changes);
        if (reopenWeb)
        {
            foreach (var port in webPorts.Where(port => !state.Rules.Any(rule => OutsidersReach(rule, [port]))))
            {
                changes.Add(new FirewallChange(FirewallChangeKind.AddRule, new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port)));
            }
        }

        return Checked(changes, ssh.Notes);
    }

    public static TunnelFirewallComparison CompareWeb(FirewallState state, IReadOnlyCollection<int> webPorts)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(webPorts);
        var open = state.Rules.Where(rule => OutsidersReach(rule, webPorts)).Select(FirewallEvaluation.Describe).Distinct(StringComparer.Ordinal).ToList();
        AddPolicy(state, open);
        return new TunnelFirewallComparison(open);
    }

    public static TunnelFirewallComparison CompareSsh(FirewallState state, TunnelSshMode mode, IReadOnlyCollection<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(sshPorts);
        if (mode == TunnelSshMode.Open)
        {
            return new TunnelFirewallComparison([]);
        }

        var open = state.Rules.Where(rule => OutsidersReach(rule, sshPorts)).Select(FirewallEvaluation.Describe).Distinct(StringComparer.Ordinal).ToList();
        if (mode == TunnelSshMode.Mesh)
        {
            open.AddRange(sshPorts.Where(port => !state.Rules.Any(rule => IsMeshRule(rule, [port])))
                .Select(port => $"No rule lets Cloudflare Mesh ({MeshRange}) reach SSH on {Number(port)}/tcp"));
        }

        AddPolicy(state, open);
        return new TunnelFirewallComparison(open);
    }

    private static void RequireDenyByDefault(FirewallState state)
    {
        if (!state.Active)
        {
            throw new FirewallRefusedException("The firewall is off, so it cannot close anything. Turn it on in the Firewall section first, then set up the tunnel.");
        }

        if (state.DefaultIncoming == FirewallPolicy.Allow)
        {
            throw new FirewallRefusedException("The firewall lets every connection in by default, so closing ports would change nothing. Set the default for incoming traffic to deny first.");
        }
    }

    private static void AddPolicy(FirewallState state, List<string> open)
    {
        if (state.Active && state.DefaultIncoming == FirewallPolicy.Allow)
        {
            open.Insert(0, "The default for incoming traffic is allow");
        }

        if (!state.Active)
        {
            open.Insert(0, "The firewall is off");
        }
    }

    private static TunnelFirewallPlan Checked(List<FirewallChange> changes, IReadOnlyList<string> notes)
    {
        if (changes.Count > FirewallChangePlanner.MaxChanges)
        {
            throw new FirewallRefusedException(
                $"The tunnel needs {Number(changes.Count)} firewall changes; one change set takes at most {Number(FirewallChangePlanner.MaxChanges)}.");
        }

        return new TunnelFirewallPlan(changes, notes);
    }

    private static FirewallChange Remove(FirewallRule rule) => new(FirewallChangeKind.RemoveRule, RuleId: rule.Id);

    private static string StillOpen(FirewallRule rule, string what) =>
        $"\"{FirewallEvaluation.Describe(rule)}\" still lets other addresses reach {what}"
        + (rule.ReadOnlyReason is { } why ? $" and the core cannot change it ({why})" : " and covers other ports too")
        + ". Remove or narrow it in the Firewall section, or the tunnel is not the only way in.";

    private static bool LetsIn(FirewallRule rule) =>
        rule is { Action: FirewallAction.Allow or FirewallAction.Limit, Outgoing: false, Routed: false };

    /// <summary>Whether the rule lets some address that is not loopback reach this port.</summary>
    private static bool Covers(FirewallRule rule, int port) =>
        LetsIn(rule)
        && (rule.Ports is { } ports ? ports.From <= port && port <= ports.To
            : rule.PortList is { } list ? list.Any(range => range.From <= port && port <= range.To)
            : true)
        && rule.Protocol is FirewallProtocol.Tcp or FirewallProtocol.Any;

    private static bool OutsidersReach(FirewallRule rule, IReadOnlyCollection<int> ports) =>
        LetsIn(rule)
        && ports.Any(port => _outsiders.Any(outsider => FirewallEvaluation.Match(rule, new Probe(outsider, port, FirewallProtocol.Tcp)) != RuleMatch.No));

    private static bool IsSinglePortRule(FirewallRule rule, IReadOnlyCollection<int> ports) =>
        rule.PortList is null
        && rule.Ports is { IsSingle: true } single
        && ports.Contains(single.From);

    private static bool IsMeshRule(FirewallRule rule, IReadOnlyCollection<int> sshPorts) =>
        rule is { Action: FirewallAction.Allow, SourceNegated: false, Interface: null, Destination: null, Unknown: null, PortList: null }
        && LetsIn(rule)
        && rule.Ports is { IsSingle: true } ports && sshPorts.Contains(ports.From)
        && rule.Source is { } source && source.Equals(_mesh);

    private static IEnumerable<FirewallRule> MeshRules(FirewallState state, IReadOnlyCollection<int> sshPorts) =>
        state.Rules.Where(rule => IsMeshRule(rule, sshPorts)).DistinctBy(rule => rule.Id);

    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);
}
