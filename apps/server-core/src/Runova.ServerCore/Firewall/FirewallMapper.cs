using System.Net;
using System.Text.Json;
using Riok.Mapperly.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Firewall;

[Mapper]
internal static partial class FirewallMapper
{
    /// <summary>A rule as the app lists it: a negated source shows only in the description.</summary>
    [MapPropertyFromSource(nameof(FirewallRuleInfo.Description), Use = nameof(Describe))]
    [MapPropertyFromSource(nameof(FirewallRuleInfo.Port), Use = nameof(PortOf))]
    [MapPropertyFromSource(nameof(FirewallRuleInfo.PortTo), Use = nameof(PortToOf))]
    [MapPropertyFromSource(nameof(FirewallRuleInfo.Source), Use = nameof(SourceOf))]
    [MapProperty(nameof(FirewallRule.Destination), nameof(FirewallRuleInfo.Destination), Use = nameof(Format))]
    [MapPropertyFromSource(nameof(FirewallRuleInfo.Note), Use = nameof(NoteOf))]
    public static partial FirewallRuleInfo ToInfo(FirewallRule rule);

    /// <summary>What a backup keeps of a rule, enough to add it again.</summary>
    public static partial FirewallRuleSpec ToSpec(FirewallRuleInfo rule);

    [MapProperty(nameof(FirewallChangeSet.Commands), nameof(FirewallChangeSetInfo.Commands), Use = nameof(ReadCommands))]
    [MapProperty(nameof(FirewallChangeSet.CreatedAt), nameof(FirewallChangeSetInfo.CreatedAtUnixMs))]
    [MapProperty(nameof(FirewallChangeSet.DeadlineAt), nameof(FirewallChangeSetInfo.DeadlineUnixMs))]
    [MapProperty(nameof(FirewallChangeSet.FinishedAt), nameof(FirewallChangeSetInfo.FinishedAtUnixMs))]
    [MapProperty(nameof(FirewallChangeSet.RequestedByName), nameof(FirewallChangeSetInfo.RequestedBy))]
    public static partial FirewallChangeSetInfo ToInfo(FirewallChangeSet row);

    private static string Describe(FirewallRule rule) => FirewallEvaluation.Describe(rule);

    private static int? PortOf(FirewallRule rule) => rule.Ports?.From;

    private static int? PortToOf(FirewallRule rule) => rule.Ports is { IsSingle: false } range ? range.To : null;

    private static string? SourceOf(FirewallRule rule) =>
        rule.Source is { } source && !rule.SourceNegated ? FirewallAddresses.Format(source) : null;

    private static string? Format(IPNetwork? network) => network is { } value ? FirewallAddresses.Format(value) : null;

    private static string? NoteOf(FirewallRule rule) => rule.ReadOnlyReason ?? rule.Unknown;

    private static string[] ReadCommands(string commands) => JsonSerializer.Deserialize<string[]>(commands, CoreJson.Options) ?? [];
}
