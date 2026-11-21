using System.Net;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// T5: what listens on the server (ss, captured from Ubuntu 24.04 in Fixtures/ss) and what Docker
/// publishes (docker ps, Fixtures/docker), each judged public, private or local by its address, and
/// what the firewall makes of it. Docker's published ports go past the host firewall.
/// </summary>
public sealed class ExposureTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public void Tcp_listeners_are_read_with_their_process()
    {
        var sockets = ExposureParsers.ParseSockets(Fixtures.Read("ss/tcp-ubuntu-24.04.txt"), FirewallProtocol.Tcp);

        Assert.Equal(
            ["0.0.0.0:22", "127.0.0.1:6379", "172.17.0.5:9000", "0.0.0.0:8080", "[::]:22", "*:3000", "[::1]:5432"],
            sockets.Select(socket => $"{socket.Shown}:{socket.Port}"));
        Assert.Equal("sshd", sockets[0].Process);
        Assert.Equal(88, sockets[0].Pid);
        Assert.Null(sockets[5].Address);
        Assert.All(sockets, socket => Assert.Equal(FirewallProtocol.Tcp, socket.Protocol));
    }

    [Fact]
    public void Udp_listeners_keep_their_scoped_addresses()
    {
        var sockets = ExposureParsers.ParseSockets(Fixtures.Read("ss/udp-scoped.txt"), FirewallProtocol.Udp);

        Assert.Equal(
            [IPAddress.Parse("127.0.0.54"), IPAddress.Parse("127.0.0.53"), IPAddress.Parse("10.0.0.5"), IPAddress.Parse("fe80::5054:ff:fe12:3456"), IPAddress.Any],
            sockets.Select(socket => socket.Address));
        Assert.Equal("systemd-resolve", sockets[1].Process);
        Assert.Null(sockets[4].Process);
        Assert.Null(sockets[4].Pid);
    }

    [Theory]
    [InlineData("127.0.0.1", ExposureScope.Local)]
    [InlineData("::1", ExposureScope.Local)]
    [InlineData("10.0.0.5", ExposureScope.Private)]
    [InlineData("172.17.0.5", ExposureScope.Private)]
    [InlineData("100.64.1.1", ExposureScope.Private)]
    [InlineData("fe80::1", ExposureScope.Private)]
    [InlineData("fd00::1", ExposureScope.Private)]
    [InlineData("0.0.0.0", ExposureScope.Public)]
    [InlineData("::", ExposureScope.Public)]
    [InlineData("203.0.113.10", ExposureScope.Public)]
    [InlineData("2001:db8::10", ExposureScope.Public)]
    public void An_address_says_who_can_reach_it(string address, ExposureScope scope) =>
        Assert.Equal(scope, ExposureParsers.Scope(IPAddress.Parse(address)));

    [Fact]
    public void Every_address_at_once_is_public()
    {
        Assert.Equal(ExposureScope.Public, ExposureParsers.Scope(null));
    }

    [Fact]
    public void Dockers_published_ports_are_read_from_docker_ps()
    {
        var bindings = ExposureParsers.ParseContainers(Fixtures.Read("docker/ps-json.txt"));

        Assert.Equal(
            [
                "shop-db-1 0.0.0.0:5432->5432/tcp",
                "shop-db-1 :::5432->5432/tcp",
                "shop-cache-1 127.0.0.1:6379->6379/tcp",
                "shop-web-1 0.0.0.0:8000-8002->8000-8002/tcp",
                "shop-web-1 :::8000-8002->8000-8002/tcp",
                "vpn 10.0.0.5:51820->51820/udp",
            ],
            bindings.Select(binding =>
                $"{binding.ContainerName} {binding.HostAddress}:{binding.HostPorts}->{binding.ContainerPorts}/{binding.Protocol.ToString().ToLowerInvariant()}"));
        Assert.Equal("3f1c0a9e7b2d", bindings[0].ContainerId);
        Assert.Equal("postgres:17", bindings[0].Image);
    }

    [Fact]
    public void The_firewall_says_whether_a_port_is_open_to_anyone_some_or_none()
    {
        var firewall = Ufw(rules: [Allow(22), Allow(5432, "10.0.0.0/8")]);

        Assert.Equal(ExposureFirewall.Open, ExposureParsers.Judge(firewall, FirewallProtocol.Tcp, IPAddress.Any, 22));
        Assert.Equal(ExposureFirewall.Restricted, ExposureParsers.Judge(firewall, FirewallProtocol.Tcp, IPAddress.Any, 5432));
        Assert.Equal(ExposureFirewall.Closed, ExposureParsers.Judge(firewall, FirewallProtocol.Tcp, IPAddress.Any, 8080));
        Assert.Equal(ExposureFirewall.Closed, ExposureParsers.Judge(firewall, FirewallProtocol.Udp, IPAddress.Any, 22));
        Assert.Equal(ExposureFirewall.NotApplicable, ExposureParsers.Judge(firewall, FirewallProtocol.Tcp, IPAddress.Loopback, 6379));
        Assert.Equal(ExposureFirewall.Open, ExposureParsers.Judge(firewall, FirewallProtocol.Tcp, null, 22));
        Assert.Equal(ExposureFirewall.Off, ExposureParsers.Judge(Ufw(active: false), FirewallProtocol.Tcp, IPAddress.Any, 8080));
        Assert.Equal(ExposureFirewall.Open, ExposureParsers.Judge(Ufw(incoming: FirewallPolicy.Allow), FirewallProtocol.Tcp, IPAddress.Any, 8080));
    }

    [Fact]
    public async Task The_inventory_judges_every_socket_and_flags_docker_bypassing_the_firewall()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("ss", ["-tlnpH"], _ => FakeProcessRunner.Ok(Fixtures.Read("ss/tcp-ubuntu-24.04.txt")));
        processes.Respond("ss", ["-ulnpH"], _ => FakeProcessRunner.Ok(Fixtures.Read("ss/udp-ubuntu-24.04.txt")));
        processes.Respond("docker", ["ps"], _ => FakeProcessRunner.Ok(Fixtures.Read("docker/ps-json.txt")));
        var source = new ExposureInventorySource(processes, new FixedFirewall(Ufw(rules: [Allow(22)])), new Containers(), new FakeTimeProvider(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000)));

        var inventory = await source.ReadAsync(Cancel);

        Assert.True(inventory.DockerAvailable);
        Assert.Null(inventory.DockerError);
        Assert.Equal(1_800_000_000_000, inventory.CollectedAtUnixMs);
        var ssh = inventory.Sockets.First(socket => socket.Port == 22);
        Assert.Equal((ExposureScope.Public, ExposureFirewall.Open, "sshd"), (ssh.Scope, ssh.Firewall, ssh.Process));
        var redis = inventory.Sockets.Single(socket => socket.Port == 6379);
        Assert.Equal((ExposureScope.Local, ExposureFirewall.NotApplicable), (redis.Scope, redis.Firewall));
        Assert.Equal(ExposureFirewall.Closed, inventory.Sockets.Single(socket => socket.Port == 8080).Firewall);
        Assert.Contains(inventory.Sockets, socket => socket is { Protocol: FirewallProtocol.Udp, Port: 51820 });
        var db = inventory.Containers.First(binding => binding.ContainerName == "shop-db-1");
        Assert.Equal((ExposureScope.Public, ExposureFirewall.Bypassed), (db.Scope, db.Firewall));
        var cache = inventory.Containers.Single(binding => binding.ContainerName == "shop-cache-1");
        Assert.Equal((ExposureScope.Local, ExposureFirewall.NotApplicable), (cache.Scope, cache.Firewall));
        var web = inventory.Containers.First(binding => binding.ContainerName == "shop-web-1");
        Assert.Equal((8000, 8002, 8000, 8002), (web.HostPort, web.HostPortTo, web.ContainerPort, web.ContainerPortTo));
        Assert.Contains(processes.Calls, spec => spec.Arguments.SequenceEqual(["ps", "--no-trunc", "--format", "{{json .}}"]));
    }

    [Fact]
    public async Task A_socket_held_by_a_container_on_the_host_network_names_the_container()
    {
        const string Host = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        var processes = new FakeProcessRunner();
        processes.Respond("ss", ["-tlnpH"], _ => FakeProcessRunner.Ok(
            "LISTEN 0 511 *:3000 *:* users:((\"node\",pid=4100,fd=21))\n"
            + "LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:((\"docker-proxy\",pid=4200,fd=7))\n"
            + "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=88,fd=3))\n"));
        processes.Respond("docker", ["ps"], _ => FakeProcessRunner.Ok());
        var table = new Containers { [4100] = Host, [4200] = "should not be asked" };
        var source = new ExposureInventorySource(processes, new FixedFirewall(Ufw()), table, TimeProvider.System);

        var inventory = await source.ReadAsync(Cancel);

        Assert.Equal(Host, inventory.Sockets.Single(socket => socket.Port == 3000).ContainerId);
        Assert.Null(inventory.Sockets.Single(socket => socket.Port == 8080).ContainerId);
        Assert.Null(inventory.Sockets.Single(socket => socket.Port == 22).ContainerId);
        Assert.Equal([4100, 88], table.Asked);
    }

    [Theory]
    [InlineData("0::/system.slice/docker-{0}.scope\n", true)]
    [InlineData("12:pids:/docker/{0}\n11:memory:/docker/{0}\n", true)]
    [InlineData("0::/docker/{0}\n", true)]
    [InlineData("0::/user.slice/user-1000.slice/user@1000.service/app.slice/docker.service/docker/{0}/init\n", true)]
    [InlineData("0::/user.slice/user-1000.slice/user@1000.service/user.slice/docker-{0}.scope\n", true)]
    [InlineData("0::/system.slice/docker.service\n", false)]
    [InlineData("0::/user.slice/user-1000.slice/session-3.scope\n", false)]
    [InlineData("0::/docker/not-an-id\n", false)]
    [InlineData("", false)]
    public void The_cgroup_file_says_which_container_a_process_runs_in(string cgroup, bool inContainer)
    {
        const string Id = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

        Assert.Equal(inContainer ? Id : null, ProcNet.ContainerId(string.Format(System.Globalization.CultureInfo.InvariantCulture, cgroup, Id)));
    }

    [Fact]
    public async Task Without_docker_there_are_only_sockets()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("ss", ["-tlnpH"], _ => FakeProcessRunner.Ok(Fixtures.Read("ss/tcp-ubuntu-24.04.txt")));
        processes.Respond("docker", ["ps"], _ => throw new ProcessStartException("docker is not installed (looked in /usr/bin)."));
        var source = new ExposureInventorySource(processes, new FixedFirewall(Ufw(active: false)), new Containers(), TimeProvider.System);

        var inventory = await source.ReadAsync(Cancel);

        Assert.False(inventory.DockerAvailable);
        Assert.Null(inventory.DockerError);
        Assert.Empty(inventory.Containers);
        Assert.NotEmpty(inventory.Sockets);
        Assert.All(inventory.Sockets.Where(socket => socket.Scope != ExposureScope.Local), socket => Assert.Equal(ExposureFirewall.Off, socket.Firewall));
    }

    [Fact]
    public async Task A_docker_that_will_not_answer_is_said_and_the_sockets_still_come()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("ss", ["-tlnpH"], _ => FakeProcessRunner.Ok(Fixtures.Read("ss/tcp-ubuntu-24.04.txt")));
        processes.Respond("docker", ["ps"], _ => FakeProcessRunner.Exit(1, error: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
        var source = new ExposureInventorySource(processes, new FixedFirewall(Ufw()), new Containers(), TimeProvider.System);

        var inventory = await source.ReadAsync(Cancel);

        Assert.True(inventory.DockerAvailable);
        Assert.Contains("Cannot connect to the Docker daemon", inventory.DockerError, StringComparison.Ordinal);
        Assert.NotEmpty(inventory.Sockets);
    }

    [Fact]
    public async Task When_ss_fails_the_inventory_says_so()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("ss", [], _ => throw new ProcessStartException("ss is not installed (looked in /usr/bin)."));
        processes.Respond("docker", ["ps"], _ => FakeProcessRunner.Ok());
        var source = new ExposureInventorySource(processes, new FixedFirewall(Ufw()), new Containers(), TimeProvider.System);

        var inventory = await source.ReadAsync(Cancel);

        Assert.Empty(inventory.Sockets);
        Assert.Contains("ss is not installed", inventory.SocketsError, StringComparison.Ordinal);
    }

    /// <summary>A process table that knows only which container each pid runs in.</summary>
    private sealed class Containers : Dictionary<int, string>, IProcessTable
    {
        public List<int> Asked { get; } = [];

        public int? ParentOf(int pid) => null;

        public IReadOnlyCollection<long> SocketInodes(int pid) => [];

        public IReadOnlyList<TcpEntry> TcpOf(int pid) => [];

        public string? ContainerIdOf(int pid)
        {
            Asked.Add(pid);
            return TryGetValue(pid, out var id) ? id : null;
        }
    }

    private sealed class FixedFirewall(FirewallState state) : IFirewallBackendSource
    {
        public IFirewallBackend Current() => new ReadOnly(state);

        private sealed class ReadOnly(FirewallState state) : IFirewallBackend
        {
            public FirewallBackendKind Kind => state.Backend;

            public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(state);

            public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan) => throw new NotSupportedException();

            public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken) =>
                throw new NotSupportedException();

            public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

            public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken) =>
                throw new NotSupportedException();
        }
    }
}
