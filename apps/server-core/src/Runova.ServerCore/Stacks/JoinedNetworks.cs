using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Networks an app's services join besides their own (another app's default network, a shared
/// one made by hand): the checks on their shape, the checks against the networks the server has,
/// and the lines they become in the override file. Each one is declared there as an external
/// network under a key of its own, so it cannot clash with a network the app's file names, and
/// Compose neither creates nor removes it.
/// </summary>
internal static class JoinedNetworks
{
    public const int MaxPerService = 16;

    /// <summary>Where the override declares a joined network; the network keeps its own name.</summary>
    public const string KeyPrefix = "runova-joined-";

    /// <summary>Docker's own networks: a Compose service cannot join them next to its others.</summary>
    private static readonly HashSet<string> BuiltIn = new(StringComparer.Ordinal) { "bridge", "host", "none" };

    public static string KeyOf(string network) => KeyPrefix + network;

    /// <summary>The shape alone, before anything is written: an empty string when it is fine.</summary>
    public static string CheckShape(StackServiceNetworks[]? networks)
    {
        if (networks is null)
        {
            return string.Empty;
        }

        if (networks.Length > StackRules.MaxServices)
        {
            return $"Name networks for at most {StackRules.MaxServices} services.";
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in networks)
        {
            if (entry is null || !StackRules.IsServiceName(entry.Service))
            {
                return "The networks name a service that is not a service name.";
            }

            if (!seen.Add(entry.Service))
            {
                return $"{entry.Service} has its networks listed twice.";
            }

            if (entry.Networks is null || entry.Networks.Length > MaxPerService)
            {
                return $"A service can join at most {MaxPerService} networks.";
            }

            foreach (var network in entry.Networks)
            {
                if (!DockerNames.IsNetwork(network))
                {
                    return "A network name can have letters, digits, dots, dashes and underscores only.";
                }

                if (BuiltIn.Contains(network))
                {
                    return $"{network} is one of Docker's own networks, which an app's service cannot join next to its own.";
                }
            }
        }

        return string.Empty;
    }

    /// <summary>Only the services that join something, each network once, so a revision lists only what it adds.</summary>
    public static StackServiceNetworks[] Kept(StackServiceNetworks[]? networks) =>
        [.. (networks ?? [])
            .Select(entry => entry with { Networks = [.. entry.Networks.Distinct(StringComparer.Ordinal)] })
            .Where(entry => entry.Networks.Length > 0)];

    /// <summary>
    /// Against the app's services and the networks on the server (null when Docker does not answer;
    /// Compose then says what is missing). Throws with the words to show.
    /// </summary>
    public static void Check(IReadOnlyCollection<StackServiceNetworks> networks, ComposeConfig config, string project, IReadOnlyList<NetworkInfo>? server)
    {
        foreach (var entry in networks)
        {
            var service = config.Services.FirstOrDefault(s => s.Name == entry.Service)
                ?? throw new ComposeConfigException($"There is no service called {entry.Service} in the compose file, so it cannot join a network.");
            if (entry.Networks.Length > 0 && service.NetworkMode is { Length: > 0 } mode)
            {
                throw new ComposeConfigException(
                    $"{service.Name} uses network_mode: {mode}, so it cannot join other networks. Remove network_mode from the compose file first.");
            }

            if (server is null)
            {
                continue;
            }

            foreach (var name in entry.Networks)
            {
                var found = server.FirstOrDefault(n => n.Name == name)
                    ?? throw new ComposeConfigException(
                        $"There is no network called {name} on the server any more, so {service.Name} cannot join it. Start the app it belongs to, or take it off {service.Name}.");
                if (found.ComposeProject == project)
                {
                    throw new ComposeConfigException($"{name} belongs to this app, so {service.Name} is already on its own network.");
                }
            }
        }
    }

    /// <summary>
    /// The service's networks as override lines, indented under its name. A service that names no
    /// network is on the app's default one only because it names none, so that one is kept too.
    /// </summary>
    public static void Append(StringBuilder text, ComposeConfigService service, StackServiceNetworks entry)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(service);
        ArgumentNullException.ThrowIfNull(entry);
        if (entry.Networks.Length == 0)
        {
            return;
        }

        text.Append("    networks:\n");
        if (!service.Definition.TryGetProperty("networks", out _))
        {
            text.Append("      default: {}\n");
        }

        foreach (var network in entry.Networks)
        {
            text.Append("      ").Append(KeyOf(network)).Append(": {}\n");
        }
    }

    /// <summary>The top-level declarations of every joined network, external so Compose leaves them alone.</summary>
    public static void AppendDeclarations(StringBuilder text, IEnumerable<string> networks)
    {
        ArgumentNullException.ThrowIfNull(text);
        var names = networks.Distinct(StringComparer.Ordinal).ToList();
        if (names.Count == 0)
        {
            return;
        }

        text.Append("networks:\n");
        foreach (var network in names)
        {
            text.Append("  ").Append(KeyOf(network)).Append(":\n")
                .Append("    name: \"").Append(network).Append("\"\n")
                .Append("    external: true\n");
        }
    }
}
