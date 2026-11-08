using System.Text.RegularExpressions;

namespace Runova.Monitoring.Tests.Link;

/// <summary>
/// AC7 of E54: no compose file publishes a port for RabbitMQ, PostgreSQL, the API or a node. The
/// only way in from outside is the proxy, and for nodes the gateway's own port.
/// </summary>
public sealed partial class ComposeTests
{
    private static readonly string _folder = Path.Combine(AppContext.BaseDirectory, "Compose");

    public static TheoryData<string> Files() => new(Directory.GetFiles(_folder, "*.yaml").Select(Path.GetFileName)!);

    /// <summary>Each service's lines, read by indentation: services sit two spaces in, their keys four.</summary>
    private static Dictionary<string, List<string>> Services(string file)
    {
        var services = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        List<string>? current = null;
        var inServices = false;
        foreach (var raw in File.ReadAllLines(Path.Combine(_folder, file)))
        {
            var line = raw.TrimEnd();
            if (line.Length == 0 || line.TrimStart().StartsWith('#'))
            {
                continue;
            }

            if (!line.StartsWith(' '))
            {
                inServices = line == "services:";
                current = null;
                continue;
            }

            if (!inServices)
            {
                continue;
            }

            var service = ServiceLine().Match(line);
            if (service.Success)
            {
                current = [];
                services[service.Groups[1].Value] = current;
            }
            else
            {
                current?.Add(line);
            }
        }

        return services;
    }

    private static List<string> Published(List<string> lines)
    {
        var published = new List<string>();
        var inPorts = false;
        foreach (var line in lines)
        {
            if (KeyLine().IsMatch(line))
            {
                inPorts = line.Trim() == "ports:";
                continue;
            }

            if (inPorts && line.TrimStart().StartsWith("- ", StringComparison.Ordinal))
            {
                published.Add(line.Trim()[2..].Trim('"'));
            }
        }

        return published;
    }

    [Fact]
    public void Every_compose_file_is_found()
    {
        Assert.Equal(
            ["compose.test.yaml", "compose.yaml", "docker-compose.production.yaml", "monitoring-node.compose.yaml"],
            Directory.GetFiles(_folder, "*.yaml").Select(Path.GetFileName).Order(StringComparer.Ordinal));
    }

    [Theory]
    [MemberData(nameof(Files))]
    public void No_broker_database_api_or_node_port_is_published(string file)
    {
        var services = Services(file);

        foreach (var name in new[] { "db", "rabbitmq", "api", "node", "web" })
        {
            if (services.TryGetValue(name, out var lines))
            {
                Assert.True(Published(lines).Count == 0, $"{file}: {name} publishes a port.");
            }
        }
    }

    [Fact]
    public void Production_publishes_only_on_loopback_for_the_server_nginx()
    {
        var services = Services("docker-compose.production.yaml");

        var published = services.SelectMany(s => Published(s.Value).Select(port => (s.Key, port))).ToList();

        Assert.Equal(["gateway", "monitoring-gateway"], published.Select(p => p.Key).Order(StringComparer.Ordinal));
        Assert.All(published, p => Assert.StartsWith("127.0.0.1:", p.port, StringComparison.Ordinal));
    }

    [Fact]
    public void Both_proxies_send_the_api_the_hubs_and_the_relay_to_the_api()
    {
        foreach (var file in new[] { "Caddyfile", "docker-compose.production.yaml" })
        {
            var matcher = File.ReadAllLines(Path.Combine(_folder, file))
                .Select(line => line.Trim())
                .Single(line => line.StartsWith("@api path ", StringComparison.Ordinal));
            var paths = matcher.Split(' ', StringSplitOptions.RemoveEmptyEntries)[2..];

            foreach (var path in new[] { "/api/*", "/hubs/*", "/relay/*" })
            {
                Assert.True(paths.Contains(path), $"{file}: {path} does not reach the API.");
            }
        }
    }

    [Fact]
    public void Rabbitmq_has_no_management_plugin_and_no_guest()
    {
        foreach (var file in new[] { "compose.yaml", "docker-compose.production.yaml" })
        {
            var rabbit = Services(file)["rabbitmq"];
            Assert.Contains(rabbit, line => line.Trim() == "image: rabbitmq:4-alpine");
            Assert.Contains(rabbit, line => line.Trim().StartsWith("RABBITMQ_DEFAULT_USER: runova", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void The_node_and_the_gateway_run_locked_down()
    {
        var node = Services("monitoring-node.compose.yaml")["node"];
        var gateway = Services("docker-compose.production.yaml")["monitoring-gateway"];

        foreach (var service in new[] { node, gateway })
        {
            Assert.Contains(service, line => line.Trim() == "read_only: true");
            Assert.Contains(service, line => line.Trim() == "cap_drop: [ALL]");
            Assert.Contains(service, line => line.Trim() == "security_opt: [\"no-new-privileges:true\"]");
        }
    }

    [GeneratedRegex("^  ([a-z][a-z0-9-]*):$")]
    private static partial Regex ServiceLine();

    [GeneratedRegex("^    [a-z_]+:")]
    private static partial Regex KeyLine();
}
